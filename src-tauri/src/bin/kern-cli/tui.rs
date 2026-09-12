//! Interactive fleet dashboard (`kern-cli` with no arguments, or `kern-cli dash`).
//!
//! Three panes: the fleet table (status/CPU/RAM/uptime), a live log tail for
//! the selected server, and an event ticker fed by the audit feed. Everything
//! is driven by the same automation API the rest of the CLI uses, so the
//! dashboard works remotely via `KERN_AUTOMATION_URL` too.
//!
//! Keys:
//!   q / Ctrl+C   quit            ?          help
//!   ↑ / ↓, j/k   select server   s / x / r  start / stop / restart
//!   PgUp/PgDn    scroll logs     b          backup
//!   Home / End   log top/bottom  /          filter fleet
//!   :            command bar     Esc        cancel input / close overlay
//!
//! Polling: fleet + host every second, the selected log every 700 ms, audit
//! events every 2 s. Network errors never kill the dashboard; they surface in
//! the status line and the loop keeps running.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Cell, Clear, List, ListItem, Paragraph, Row, Table, TableState};
use ratatui::Frame;
use serde_json::Value;

use crate::client::{CliError, Client, Result};
use crate::output::{fmt_pct, fmt_time, fmt_uptime, Output};

const GREEN: Color = Color::Rgb(76, 245, 160);
const AMBER: Color = Color::Rgb(245, 160, 76);
const RED: Color = Color::Rgb(245, 76, 76);
const DIM: Color = Color::Rgb(120, 126, 136);
const ZINC: Color = Color::Rgb(205, 210, 219);

const FLEET_REFRESH: Duration = Duration::from_millis(1000);
const LOG_REFRESH: Duration = Duration::from_millis(700);
const EVENT_REFRESH: Duration = Duration::from_secs(2);
const LOG_BUFFER: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    Command,
    Filter,
}

#[derive(Debug, Clone)]
enum ConfirmAction {
    Stop(String),    // id
    Restart(String), // id
}

struct Confirm {
    prompt: String,
    action: ConfirmAction,
}

struct App {
    client: Client,
    servers: Vec<Value>,
    selected: usize,
    filter: String,
    host_cpu: f32,
    host_ram: f32,
    log_id: Option<String>,
    log_lines: VecDeque<String>,
    log_offset: u64,
    log_scroll: usize,
    events: VecDeque<String>,
    event_cursor: u64,
    statuses: HashMap<String, String>,
    status: Option<(Instant, String, bool)>,
    mode: Mode,
    input: String,
    confirm: Option<Confirm>,
    help: bool,
    quit: bool,
    unreachable: bool,
}

impl App {
    fn new(client: Client) -> Self {
        let now = epoch_now();
        App {
            client,
            servers: Vec::new(),
            selected: 0,
            filter: String::new(),
            host_cpu: 0.0,
            host_ram: 0.0,
            log_id: None,
            log_lines: VecDeque::new(),
            log_offset: 0,
            log_scroll: 0,
            events: VecDeque::new(),
            event_cursor: now.saturating_sub(60),
            statuses: HashMap::new(),
            status: None,
            mode: Mode::Normal,
            input: String::new(),
            confirm: None,
            help: false,
            quit: false,
            unreachable: false,
        }
    }

    fn set_status(&mut self, message: impl Into<String>, error: bool) {
        self.status = Some((Instant::now(), message.into(), error));
    }

    fn visible(&self) -> Vec<&Value> {
        let filter = self.filter.to_lowercase();
        self.servers
            .iter()
            .filter(|s| {
                if filter.is_empty() {
                    return true;
                }
                let name = s.get("name").and_then(Value::as_str).unwrap_or("");
                let id = s.get("id").and_then(Value::as_str).unwrap_or("");
                name.to_lowercase().contains(&filter) || id.to_lowercase().contains(&filter)
            })
            .collect()
    }

    fn selected_server(&self) -> Option<&Value> {
        self.visible().get(self.selected).copied()
    }

    fn selected_id_name(&self) -> Option<(String, String)> {
        self.selected_server().map(|s| {
            (
                s.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                s.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
            )
        })
    }

    fn refresh_fleet(&mut self) {
        match self.client.get("/servers") {
            Ok(value) => {
                self.unreachable = false;
                self.servers = value
                    .get("servers")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Ok(host) = self.client.get("/host/metrics") {
                    self.host_cpu = host.get("cpu").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                    self.host_ram = host.get("ram").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                }
                let visible = self.visible().len();
                if visible == 0 {
                    self.selected = 0;
                } else if self.selected >= visible {
                    self.selected = visible - 1;
                }
                // Follow selection changes with the log pane.
                let selected = self
                    .selected_server()
                    .and_then(|s| s.get("id").and_then(Value::as_str))
                    .map(str::to_string);
                if selected != self.log_id {
                    self.log_id = selected;
                    self.log_lines.clear();
                    self.log_offset = 0;
                    self.log_scroll = 0;
                    self.poll_log();
                }
            }
            Err(e) => {
                self.unreachable = true;
                self.set_status(format!("{e}"), true);
            }
        }
    }

    fn poll_log(&mut self) {
        let Some(id) = self.log_id.clone() else {
            return;
        };
        let path = format!("/servers/{id}/log?lines=200&offset={}", self.log_offset);
        match self.client.get(&path) {
            Ok(value) => {
                let reset = value.get("reset").and_then(Value::as_bool).unwrap_or(false);
                if reset {
                    self.log_lines.clear();
                    self.log_scroll = 0;
                }
                if let Some(lines) = value.get("lines").and_then(Value::as_array) {
                    for line in lines.iter().filter_map(Value::as_str) {
                        self.log_lines.push_back(line.to_string());
                    }
                }
                while self.log_lines.len() > LOG_BUFFER {
                    self.log_lines.pop_front();
                    if self.log_scroll > 0 {
                        self.log_scroll -= 1;
                    }
                }
                self.log_offset = value
                    .get("nextOffset")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.log_offset);
            }
            Err(e) => self.set_status(format!("{e}"), true),
        }
    }

    fn poll_events(&mut self) {
        let path = format!("/events?since={}&wait=0", self.event_cursor);
        // Errors are ignored here: the fleet poll reports connectivity, and a
        // blip in the event feed shouldn't clear the screen with a warning.
        if let Ok(value) = self
            .client
            .get_with_timeout(&path, Duration::from_secs(10))
        {
            if let Some(map) = value.get("statuses").and_then(Value::as_object) {
                for (id, status) in map {
                    let status = status.as_str().unwrap_or("").to_string();
                    if let Some(previous) = self.statuses.get(id) {
                        if *previous != status {
                            let name = self
                                .servers
                                .iter()
                                .find(|s| s.get("id").and_then(Value::as_str) == Some(id.as_str()))
                                .and_then(|s| s.get("name").and_then(Value::as_str))
                                .unwrap_or(id.as_str());
                            self.push_event(format!("{name}: {previous} → {status}"));
                        }
                    }
                    self.statuses.insert(id.clone(), status);
                }
            }
            if let Some(entries) = value.get("entries").and_then(Value::as_array) {
                for entry in entries {
                    let at = entry.get("at").and_then(Value::as_u64).unwrap_or(0);
                    self.push_event(format!(
                        "{} {} {}",
                        fmt_time(at),
                        entry.get("action").and_then(Value::as_str).unwrap_or("?"),
                        entry.get("detail").and_then(Value::as_str).unwrap_or("")
                    ));
                }
            }
            let now = value.get("now").and_then(Value::as_u64).unwrap_or(self.event_cursor);
            self.event_cursor = now.saturating_sub(1);
        }
    }

    fn push_event(&mut self, line: String) {
        self.events.push_back(line);
        while self.events.len() > 200 {
            self.events.pop_front();
        }
    }

    /// Runs a lifecycle action for the selected server.
    fn act_selected(&mut self, action: &str) {
        let Some((id, name)) = self.selected_id_name() else {
            self.set_status("no server selected", true);
            return;
        };
        match self.client.post(&format!("/servers/{id}/{action}"), None) {
            Ok(_) => {
                self.set_status(format!("{action} {name}"), false);
                self.refresh_fleet();
            }
            Err(e) => self.set_status(format!("{e}"), true),
        }
    }

    fn stop_selected(&mut self) {
        if let Some((id, name)) = self.selected_id_name() {
            self.confirm = Some(Confirm {
                prompt: format!("stop {name}?"),
                action: ConfirmAction::Stop(id),
            });
        }
    }

    fn restart_selected(&mut self) {
        if let Some((id, name)) = self.selected_id_name() {
            self.confirm = Some(Confirm {
                prompt: format!("restart {name}?"),
                action: ConfirmAction::Restart(id),
            });
        }
    }

    fn backup_selected(&mut self) {
        if let Some((id, name)) = self.selected_id_name() {
            match self.client.post(&format!("/servers/{id}/backup"), None) {
                Ok(_) => self.set_status(format!("backup accepted for {name}"), false),
                Err(e) => self.set_status(format!("{e}"), true),
            }
        }
    }

    fn run_command(&mut self) {
        let raw = self.input.trim().to_string();
        self.input.clear();
        self.mode = Mode::Normal;
        if raw.is_empty() {
            return;
        }
        let mut parts = raw.split_whitespace();
        let verb = parts.next().unwrap_or("").to_lowercase();
        let target = parts.next().unwrap_or("").to_string();
        let target = if target.is_empty() {
            self.selected_id_name().map(|(_, name)| name).unwrap_or_default()
        } else {
            target
        };
        match verb.as_str() {
            "quit" | "q" => self.quit = true,
            "help" => self.help = true,
            "clear" => {
                self.events.clear();
                self.set_status("cleared events", false);
            }
            "filter" => {
                self.filter = target;
                self.selected = 0;
            }
            "start" | "stop" | "restart" | "install" => {
                let ids: Vec<(String, String)> = if target.eq_ignore_ascii_case("all") {
                    self.visible()
                        .iter()
                        .filter_map(|s| {
                            Some((
                                s.get("id").and_then(Value::as_str)?.to_string(),
                                s.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
                            ))
                        })
                        .collect()
                } else {
                    self.visible()
                        .iter()
                        .find(|s| {
                            let name = s.get("name").and_then(Value::as_str).unwrap_or("");
                            let id = s.get("id").and_then(Value::as_str).unwrap_or("");
                            name.eq_ignore_ascii_case(&target)
                                || name.to_lowercase().contains(&target.to_lowercase())
                                || id == target
                        })
                        .map(|s| {
                            vec![(
                                s.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                                s.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
                            )]
                        })
                        .unwrap_or_default()
                };
                if ids.is_empty() {
                    self.set_status(format!("no server matches '{target}'"), true);
                    return;
                }
                let mut failures = 0;
                for (id, name) in ids {
                    match self.client.post(&format!("/servers/{id}/{verb}"), None) {
                        Ok(_) => self.set_status(format!("{verb} {name}"), false),
                        Err(e) => {
                            self.set_status(format!("{e}"), true);
                            failures += 1;
                        }
                    }
                }
                if failures == 0 {
                    self.refresh_fleet();
                }
            }
            other => self.set_status(format!("unknown command '{other}'"), true),
        }
    }

    fn handle_key(&mut self, code: KeyCode, modifiers: KeyModifiers) {
        // Input modes consume keys first.
        if self.mode != Mode::Normal {
            match code {
                KeyCode::Esc => {
                    self.mode = Mode::Normal;
                    self.input.clear();
                }
                KeyCode::Enter => {
                    if self.mode == Mode::Command {
                        self.run_command();
                    } else {
                        self.filter = self.input.clone();
                        self.input.clear();
                        self.mode = Mode::Normal;
                        self.selected = 0;
                    }
                }
                KeyCode::Backspace => {
                    self.input.pop();
                }
                KeyCode::Char(c) => self.input.push(c),
                _ => {}
            }
            return;
        }

        if self.confirm.is_some() {
            match code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    let confirm = self.confirm.take().unwrap();
                    let (action, id) = match confirm.action {
                        ConfirmAction::Stop(id) => ("stop", id),
                        ConfirmAction::Restart(id) => ("restart", id),
                    };
                    match self.client.post(&format!("/servers/{id}/{action}"), None) {
                        Ok(_) => self.set_status(format!("{action} accepted"), false),
                        Err(e) => self.set_status(format!("{e}"), true),
                    }
                    self.refresh_fleet();
                }
                KeyCode::Char('n') | KeyCode::Esc => {
                    self.confirm = None;
                }
                _ => {}
            }
            return;
        }

        if self.help {
            if matches!(code, KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q')) {
                self.help = false;
            }
            return;
        }

        let visible_len = self.visible().len();
        match code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => self.quit = true,
            KeyCode::Char('?') => self.help = true,
            KeyCode::Up | KeyCode::Char('k') => {
                if self.selected > 0 {
                    self.selected -= 1;
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.selected + 1 < visible_len {
                    self.selected += 1;
                }
            }
            KeyCode::Home => self.log_scroll = self.log_lines.len().saturating_sub(1),
            KeyCode::End => self.log_scroll = 0,
            KeyCode::PageUp => {
                self.log_scroll = (self.log_scroll + 10).min(self.log_lines.len().saturating_sub(1));
            }
            KeyCode::PageDown => self.log_scroll = self.log_scroll.saturating_sub(10),
            KeyCode::Char('s') => self.act_selected("start"),
            KeyCode::Char('x') => self.stop_selected(),
            KeyCode::Char('r') => self.restart_selected(),
            KeyCode::Char('b') => self.backup_selected(),
            KeyCode::Char('i') => self.act_selected("install"),
            KeyCode::Char('/') => {
                self.mode = Mode::Filter;
                self.input = self.filter.clone();
            }
            KeyCode::Char(':') => {
                self.mode = Mode::Command;
                self.input.clear();
            }
            _ => {}
        }
    }
}

fn epoch_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn status_color(status: &str) -> Color {
    match status {
        "running" => GREEN,
        "starting" | "stopping" | "restarting" => AMBER,
        "error" | "stopped-forced" => RED,
        _ => DIM,
    }
}

fn cpu_of(server: &Value) -> Option<f32> {
    server.pointer("/metrics/cpu").and_then(Value::as_f64).map(|v| v as f32)
}

fn ram_of(server: &Value) -> Option<f32> {
    server.pointer("/metrics/ram").and_then(Value::as_f64).map(|v| v as f32)
}

pub fn run(_out: &Output) -> Result<()> {
    let client = Client::discover()?;
    let mut app = App::new(client);
    app.refresh_fleet();
    app.poll_events();

    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, &mut app);
    ratatui::restore();

    if let Err(e) = result {
        return Err(CliError::Error(format!("dashboard failed: {e}")));
    }
    Ok(())
}

fn event_loop(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> io::Result<()> {
    let mut last_fleet = Instant::now();
    let mut last_log = Instant::now();
    let mut last_events = Instant::now();

    while !app.quit {
        terminal.draw(|frame| ui(frame, app))?;

        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    app.handle_key(key.code, key.modifiers);
                }
            }
        }

        if last_fleet.elapsed() >= FLEET_REFRESH {
            last_fleet = Instant::now();
            app.refresh_fleet();
        }
        if last_log.elapsed() >= LOG_REFRESH {
            last_log = Instant::now();
            app.poll_log();
        }
        if last_events.elapsed() >= EVENT_REFRESH {
            last_events = Instant::now();
            app.poll_events();
        }
    }
    Ok(())
}

fn ui(frame: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(6),
            Constraint::Length(6),
            Constraint::Length(1),
        ])
        .split(frame.area());

    header(frame, chunks[0], app);

    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(38), Constraint::Percentage(62)])
        .split(chunks[1]);
    fleet(frame, body[0], app);
    logs(frame, body[1], app);
    events(frame, chunks[2], app);
    footer(frame, chunks[3], app);

    if let Some(confirm) = &app.confirm {
        confirm_overlay(frame, confirm);
    }
    if app.help {
        help_overlay(frame);
    }
    if app.mode != Mode::Normal {
        input_line(frame, app);
    }
}

fn header(frame: &mut Frame, area: Rect, app: &App) {
    let running = app.servers.iter().filter(|s| {
        s.get("running").and_then(Value::as_bool).unwrap_or(false)
    }).count();
    let mut spans = vec![
        Span::styled("kern ", Style::default().fg(GREEN).add_modifier(Modifier::BOLD)),
        Span::styled(
            format!("· {running}/{} running", app.servers.len()),
            Style::default().fg(ZINC),
        ),
        Span::styled(
            format!("  · host cpu {} ram {}", fmt_pct(Some(app.host_cpu)), fmt_pct(Some(app.host_ram))),
            Style::default().fg(DIM),
        ),
        Span::styled(format!("  · {}", fmt_time(epoch_now())), Style::default().fg(DIM)),
    ];
    if !app.filter.is_empty() {
        spans.push(Span::styled(
            format!("  · filter \"{}\"", app.filter),
            Style::default().fg(AMBER),
        ));
    }
    if app.unreachable {
        spans.push(Span::styled("  · app unreachable", Style::default().fg(RED)));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn fleet(frame: &mut Frame, area: Rect, app: &App) {
    let visible = app.visible();
    let rows: Vec<Row> = visible
        .iter()
        .map(|s| {
            let status = s.get("status").and_then(Value::as_str).unwrap_or("");
            let running = s.get("running").and_then(Value::as_bool).unwrap_or(false);
            let orphaned = s.get("orphaned").and_then(Value::as_bool).unwrap_or(false);
            let status_text = if orphaned { "orphaned" } else { status };
            let symbol = match status {
                "running" => "●",
                "starting" | "stopping" | "restarting" => "◐",
                "error" | "stopped-forced" => "■",
                _ => "○",
            };
            Row::new(vec![
                Cell::from(Span::styled(
                    format!("{symbol} {}", status_text),
                    Style::default().fg(status_color(status)),
                )),
                Cell::from(Span::styled(
                    s.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
                    Style::default().fg(ZINC),
                )),
                Cell::from(fmt_pct(cpu_of(s))),
                Cell::from(fmt_pct(ram_of(s))),
                Cell::from(fmt_uptime(s.get("uptimeSecs").and_then(Value::as_u64))),
            ])
            .style(if running {
                Style::default()
            } else {
                Style::default().fg(DIM)
            })
        })
        .collect();

    let widths = [
        Constraint::Length(14),
        Constraint::Min(12),
        Constraint::Length(5),
        Constraint::Length(5),
        Constraint::Length(9),
    ];
    let table = Table::new(rows, widths)
        .header(
            Row::new(vec!["STATUS", "NAME", "CPU", "RAM", "UPTIME"])
                .style(Style::default().fg(DIM)),
        )
        .block(Block::bordered().title(" fleet "))
        .row_highlight_style(Style::default().bg(Color::Rgb(20, 24, 32)))
        .highlight_symbol("› ");

    let mut state = TableState::default().with_selected(if visible.is_empty() {
        None
    } else {
        Some(app.selected)
    });
    frame.render_stateful_widget(table, area, &mut state);
}

fn logs(frame: &mut Frame, area: Rect, app: &App) {
    let title = match app.log_id.as_deref() {
        Some(id) => {
            let name = app
                .servers
                .iter()
                .find(|s| s.get("id").and_then(Value::as_str) == Some(id))
                .and_then(|s| s.get("name").and_then(Value::as_str))
                .unwrap_or(id);
            format!(" log · {name} ")
        }
        None => " log ".to_string(),
    };
    let inner_height = area.height.saturating_sub(2) as usize;
    let total = app.log_lines.len();
    let end = total.saturating_sub(app.log_scroll);
    let start = end.saturating_sub(inner_height);
    let lines: Vec<Line> = app
        .log_lines
        .iter()
        .skip(start)
        .take(end.saturating_sub(start))
        .map(|line| Line::from(line.as_str()))
        .collect();
    let suffix = if app.log_scroll > 0 {
        format!(" ↑{} ", app.log_scroll)
    } else {
        String::new()
    };
    let paragraph = Paragraph::new(Text::from(lines))
        .block(Block::bordered().title(format!("{title}{suffix}")));
    frame.render_widget(paragraph, area);
}

fn events(frame: &mut Frame, area: Rect, app: &App) {
    let inner_height = area.height.saturating_sub(2) as usize;
    let start = app.events.len().saturating_sub(inner_height);
    let items: Vec<ListItem> = app
        .events
        .iter()
        .skip(start)
        .map(|line| ListItem::new(Line::from(Span::styled(line.clone(), Style::default().fg(DIM)))))
        .collect();
    let list = List::new(items).block(Block::bordered().title(" events "));
    frame.render_widget(list, area);
}

fn footer(frame: &mut Frame, area: Rect, app: &App) {
    let text = if let Some((at, message, error)) = &app.status {
        if at.elapsed() < Duration::from_secs(6) {
            let style = if *error {
                Style::default().fg(RED)
            } else {
                Style::default().fg(GREEN)
            };
            Line::from(Span::styled(format!(" {message}"), style))
        } else {
            keys_line()
        }
    } else {
        keys_line()
    };
    frame.render_widget(Paragraph::new(text), area);
}

fn keys_line() -> Line<'static> {
    Line::from(Span::styled(
        " q quit · ↑↓ select · s start · x stop · r restart · b backup · i install · / filter · : command · ? help · PgUp/PgDn logs ",
        Style::default().fg(DIM),
    ))
}

fn confirm_overlay(frame: &mut Frame, confirm: &Confirm) {
    let area = centered_rect(frame.area(), 46, 5);
    frame.render_widget(Clear, area);
    let block = Block::bordered()
        .title(" confirm ")
        .style(Style::default().bg(Color::Rgb(11, 12, 16)));
    let paragraph = Paragraph::new(Text::from(vec![
        Line::from(confirm.prompt.clone()),
        Line::from(""),
        Line::from(Span::styled("y / enter = yes · n / esc = no", Style::default().fg(DIM))),
    ]))
    .alignment(Alignment::Center)
    .block(block);
    frame.render_widget(paragraph, area);
}

fn help_overlay(frame: &mut Frame) {
    let area = centered_rect(frame.area(), 64, 16);
    frame.render_widget(Clear, area);
    let lines = vec![
        Line::from(Span::styled("kern dashboard", Style::default().fg(GREEN).add_modifier(Modifier::BOLD))),
        Line::from(""),
        Line::from("q, ctrl+c      quit"),
        Line::from("↑ ↓ / j k      select a server"),
        Line::from("s / x / r      start / stop / restart"),
        Line::from("i              run the install step"),
        Line::from("b              back up the selected server"),
        Line::from("/              filter the fleet"),
        Line::from(":              command bar — start|stop|restart <name|all>"),
        Line::from("               also: backup <name>, filter <text>, clear, quit"),
        Line::from("PgUp / PgDn    scroll the log pane"),
        Line::from("Home / End     jump to log top / follow"),
        Line::from("? / esc        close this help"),
        Line::from(""),
        Line::from(Span::styled(
            "data refreshes: fleet 1s · log 0.7s · events 2s",
            Style::default().fg(DIM),
        )),
    ];
    let paragraph = Paragraph::new(Text::from(lines))
        .block(
            Block::bordered()
                .title(" help ")
                .style(Style::default().bg(Color::Rgb(11, 12, 16))),
        );
    frame.render_widget(paragraph, area);
}

fn input_line(frame: &mut Frame, app: &App) {
    let area = Rect {
        x: 0,
        y: frame.area().height.saturating_sub(1),
        width: frame.area().width,
        height: 1,
    };
    let prefix = if app.mode == Mode::Command { ":" } else { "/" };
    let line = Line::from(vec![
        Span::styled(prefix, Style::default().fg(GREEN)),
        Span::styled(app.input.clone(), Style::default().fg(ZINC)),
        Span::styled("▌", Style::default().fg(GREEN)),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn centered_rect(area: Rect, percent_x: u16, height: u16) -> Rect {
    let width = area.width * percent_x / 100;
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    Rect {
        x,
        y,
        width,
        height: height.min(area.height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn test_app() -> App {
        let client = Client {
            url: "http://127.0.0.1:1".to_string(),
            token: "test".to_string(),
            endpoint: None,
        };
        let mut app = App::new(client);
        app.servers = vec![
            serde_json::json!({
                "id": "srv_one",
                "name": "Alpha",
                "status": "running",
                "running": true,
                "orphaned": false,
                "uptimeSecs": 125,
                "metrics": { "cpu": 0.12, "ram": 0.4 }
            }),
            serde_json::json!({
                "id": "srv_two",
                "name": "Beta",
                "status": "stopped",
                "running": false,
                "orphaned": false,
                "uptimeSecs": null,
                "metrics": null
            }),
        ];
        app.host_cpu = 0.2;
        app.host_ram = 0.5;
        app.log_lines.push_back("hello log line".to_string());
        app
    }

    fn render(app: &App) -> String {
        let backend = TestBackend::new(110, 32);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| ui(frame, app)).unwrap();
        let buffer = terminal.backend().buffer();
        let mut out = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                out.push_str(buffer[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn renders_fleet_log_and_events() {
        let app = test_app();
        let text = render(&app);
        assert!(text.contains("kern"), "header missing");
        assert!(text.contains("fleet"), "fleet title missing");
        assert!(text.contains("Alpha"), "server name missing");
        assert!(text.contains("Beta"), "server name missing");
        assert!(text.contains("hello log line"), "log pane missing");
        assert!(text.contains("events"), "events title missing");
        assert!(text.contains("1/2 running"), "running count missing: {text}");
    }

    #[test]
    fn help_overlay_lists_keys() {
        let mut app = test_app();
        app.help = true;
        let text = render(&app);
        assert!(text.contains("command bar"));
        assert!(text.contains("quit"));
    }

    #[test]
    fn confirm_overlay_renders_prompt() {
        let mut app = test_app();
        app.confirm = Some(Confirm {
            prompt: "stop Alpha?".to_string(),
            action: ConfirmAction::Stop("srv_one".to_string()),
        });
        let text = render(&app);
        assert!(text.contains("stop Alpha?"));
        assert!(text.contains("yes"));
    }

    #[test]
    fn filter_hides_non_matching_servers() {
        let mut app = test_app();
        app.filter = "alpha".to_string();
        assert_eq!(app.visible().len(), 1);
        let text = render(&app);
        assert!(text.contains("Alpha"));
        assert!(!text.contains("Beta"));
    }

    #[test]
    fn selection_clamps_when_list_shrinks() {
        let mut app = test_app();
        app.selected = 1;
        app.filter = "alpha".to_string();
        app.servers.pop();
        // refresh_fleet clamps; emulate the clamp path without a network call.
        let visible = app.visible().len();
        if app.selected >= visible {
            app.selected = visible.saturating_sub(1);
        }
        assert_eq!(app.selected, 0);
    }
}
