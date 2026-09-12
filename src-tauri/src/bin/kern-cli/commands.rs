//! Command implementations + their clap argument structs.
//!
//! Every command is a thin, scriptable wrapper over the automation API. Human
//! output goes through [`Output`]; `--format json` prints the raw response so
//! the CLI can double as a JSON client.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use clap::{Args, Subcommand, ValueEnum};
use regex::Regex;
use serde_json::{json, Value};

use crate::client::{self, CliError, Client, Result};
use crate::output::{fmt_pct, fmt_time, fmt_uptime, parse_duration, sparkline, Format, Output};

// ──────────────────────────────────────────────────────────────────────────
// args
// ──────────────────────────────────────────────────────────────────────────

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum SortKey {
    Name,
    Status,
    Cpu,
    Ram,
    Uptime,
}

#[derive(Debug, Args)]
pub struct ListArgs {
    /// Only servers carrying this tag.
    #[arg(long)]
    pub tag: Option<String>,
    /// Only servers in this group.
    #[arg(long)]
    pub group: Option<String>,
    /// Only running servers.
    #[arg(long)]
    pub running: bool,
    /// Only stopped servers.
    #[arg(long)]
    pub stopped: bool,
    /// Only orphaned servers (folder missing).
    #[arg(long)]
    pub orphaned: bool,
    /// Include a live listening-port scan per running server.
    #[arg(long)]
    pub ports: bool,
    /// Sort key.
    #[arg(long, value_enum, default_value_t = SortKey::Name)]
    pub sort: SortKey,
    /// Reverse the sort order.
    #[arg(long)]
    pub reverse: bool,
}

#[derive(Debug, Args)]
pub struct ActionArgs {
    /// Server ids or names. Omit when using --all/--tag/--group.
    pub servers: Vec<String>,
    /// Every registered server.
    #[arg(long)]
    pub all: bool,
    /// Every server with this tag.
    #[arg(long)]
    pub tag: Option<String>,
    /// Every server in this group.
    #[arg(long)]
    pub group: Option<String>,
    /// Block until the action reaches its target state.
    #[arg(long)]
    pub wait: bool,
    /// How long --wait may take (e.g. 30s, 5m).
    #[arg(long, default_value = "60s")]
    pub timeout: String,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum WaitFor {
    Running,
    Stopped,
    /// Running and below the CPU/RAM alert thresholds.
    Healthy,
}

#[derive(Debug, Args)]
pub struct WaitArgs {
    pub server: String,
    #[arg(long = "for", value_enum, default_value_t = WaitFor::Running)]
    pub wait_for: WaitFor,
    #[arg(long, default_value = "60s")]
    pub timeout: String,
}

#[derive(Debug, Args)]
pub struct AddArgs {
    /// Folder to register.
    pub path: String,
    /// Instance name (defaults to the folder name).
    #[arg(long)]
    pub name: Option<String>,
    /// Server type / plugin id.
    #[arg(long, default_value = "custom")]
    pub server_type: String,
    /// Group label.
    #[arg(long)]
    pub group: Option<String>,
    /// Tag (repeatable).
    #[arg(long = "tag")]
    pub tags: Vec<String>,
    /// Start automatically with kern.
    #[arg(long)]
    pub auto_start: bool,
    /// Adopt an existing folder: skip plugin scaffolding.
    #[arg(long)]
    pub import: bool,
    /// Start the instance after registering it.
    #[arg(long)]
    pub start: bool,
}

#[derive(Debug, Args)]
pub struct EditArgs {
    pub server: String,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub group: Option<String>,
    /// Clear the group label.
    #[arg(long = "clear-group")]
    pub clear_group: bool,
    /// Replace tags (repeatable).
    #[arg(long = "tag")]
    pub tags: Vec<String>,
    #[arg(long = "auto-start")]
    pub auto_start: bool,
    #[arg(long = "no-auto-start")]
    pub no_auto_start: bool,
    /// Graceful-stop console command (empty string disables stdin).
    #[arg(long = "stop-command")]
    pub stop_command: Option<String>,
    /// Graceful-stop timeout in seconds.
    #[arg(long = "stop-timeout")]
    pub stop_timeout: Option<u64>,
}

#[derive(Debug, Args)]
pub struct RmArgs {
    pub server: String,
    /// Also delete the instance's working directory.
    #[arg(long)]
    pub folder: bool,
    /// Skip the confirmation prompt for --folder.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    pub server: String,
    /// Keep streaming new lines (Ctrl+C to stop).
    #[arg(long)]
    pub follow: bool,
    /// Initial tail size.
    #[arg(long, default_value_t = 200)]
    pub lines: usize,
    /// Only print lines matching this regex.
    #[arg(long)]
    pub grep: Option<String>,
    /// Drop lines matching this regex.
    #[arg(long)]
    pub exclude: Option<String>,
    /// Follow poll interval.
    #[arg(long, default_value = "1s")]
    pub interval: String,
}

#[derive(Debug, Args)]
pub struct SendArgs {
    pub server: String,
    /// Line to write to the server's stdin (joined with spaces).
    #[arg(required = true, num_args = 1..)]
    pub message: Vec<String>,
}

#[derive(Debug, Args)]
pub struct TopArgs {
    /// Refresh interval (ignored with --once).
    #[arg(long, default_value = "1s")]
    pub interval: String,
    /// Print one snapshot and exit.
    #[arg(long)]
    pub once: bool,
}

#[derive(Debug, Args)]
pub struct MetricsArgs {
    pub server: String,
    /// History window in seconds.
    #[arg(long, default_value_t = 3600)]
    pub window: u64,
    /// Draw CPU/RAM sparklines instead of a table.
    #[arg(long)]
    pub spark: bool,
}

#[derive(Debug, Args)]
pub struct AuditArgs {
    /// How many entries to fetch.
    #[arg(long, default_value_t = 50)]
    pub limit: usize,
    /// Filter to one server (id or name).
    #[arg(long)]
    pub server: Option<String>,
}

#[derive(Debug, Args)]
pub struct EventsArgs {
    /// Keep streaming (Ctrl+C to stop).
    #[arg(long)]
    pub follow: bool,
}

#[derive(Debug, Args)]
pub struct EndpointArgs {
    /// Print the bearer token too.
    #[arg(long)]
    pub show_token: bool,
}

#[derive(Debug, Args)]
pub struct ApiArgs {
    /// HTTP method (GET, POST, PATCH, DELETE).
    pub method: String,
    /// API path, e.g. /servers
    pub path: String,
    /// JSON request body.
    #[arg(long)]
    pub body: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum BackupCmd {
    /// List snapshots for an instance.
    List { server: String },
    /// Create a snapshot now (returns as soon as it is accepted).
    Create {
        server: String,
        /// Wait for the backup to appear in the list.
        #[arg(long)]
        wait: bool,
    },
    /// Restore a snapshot over the instance's world.
    Restore {
        server: String,
        backup: String,
        #[arg(long, short = 'y')]
        yes: bool,
    },
    /// Delete a snapshot.
    Delete {
        server: String,
        backup: String,
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum TaskCmd {
    /// List scheduled tasks.
    List { server: String },
    /// Run one task now (id or name).
    Run { server: String, task: String },
}

#[derive(Debug, Subcommand)]
pub enum PluginCmd {
    /// List installed plugins.
    List,
    /// Install a .kern package.
    Install {
        path: String,
        #[arg(long)]
        force: bool,
    },
    /// Uninstall a plugin by id.
    Remove { id: String },
    /// Validate a .kern package without installing.
    Validate { path: String },
}

// ──────────────────────────────────────────────────────────────────────────
// selectors
// ──────────────────────────────────────────────────────────────────────────

fn name_of(server: &Value) -> String {
    server
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string()
}

fn id_of(server: &Value) -> String {
    server
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn running_of(server: &Value) -> bool {
    server.get("running").and_then(Value::as_bool).unwrap_or(false)
}

fn fetch_servers(client: &Client) -> Result<Vec<Value>> {
    let value = client.get("/servers")?;
    Ok(value
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn ambiguous(needle: &str, matches: &[&Value]) -> CliError {
    let names: Vec<String> = matches.iter().map(|s| name_of(s)).collect();
    CliError::Error(format!(
        "'{needle}' is ambiguous — matches: {}",
        names.join(", ")
    ))
}

fn resolve_in(servers: &[Value], needle: &str) -> Result<Value> {
    if let Some(server) = servers.iter().find(|s| id_of(s) == needle) {
        return Ok(server.clone());
    }
    let lower = needle.to_lowercase();
    let exact: Vec<&Value> = servers
        .iter()
        .filter(|s| name_of(s).to_lowercase() == lower)
        .collect();
    match exact.len() {
        1 => return Ok(exact[0].clone()),
        n if n > 1 => return Err(ambiguous(needle, &exact)),
        _ => {}
    }
    let prefix: Vec<&Value> = servers
        .iter()
        .filter(|s| {
            id_of(s).to_lowercase().starts_with(&lower) || name_of(s).to_lowercase().starts_with(&lower)
        })
        .collect();
    match prefix.len() {
        1 => return Ok(prefix[0].clone()),
        n if n > 1 => return Err(ambiguous(needle, &prefix)),
        _ => {}
    }
    let substring: Vec<&Value> = servers
        .iter()
        .filter(|s| {
            id_of(s).to_lowercase().contains(&lower) || name_of(s).to_lowercase().contains(&lower)
        })
        .collect();
    match substring.len() {
        1 => return Ok(substring[0].clone()),
        n if n > 1 => return Err(ambiguous(needle, &substring)),
        _ => {}
    }
    Err(CliError::NotFound(format!("no server matches '{needle}'")))
}

fn resolve_server(client: &Client, needle: &str) -> Result<Value> {
    let servers = fetch_servers(client)?;
    resolve_in(&servers, needle)
}

fn resolve_targets(
    client: &Client,
    needles: &[String],
    all: bool,
    tag: Option<&str>,
    group: Option<&str>,
) -> Result<Vec<Value>> {
    let servers = fetch_servers(client)?;
    if all || tag.is_some() || group.is_some() {
        let mut out: Vec<Value> = servers
            .into_iter()
            .filter(|s| {
                let tag_ok = tag.is_none_or(|t| {
                    s.get("tags")
                        .and_then(Value::as_array)
                        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(t)))
                });
                let group_ok = group.is_none_or(|g| {
                    s.get("group").and_then(Value::as_str) == Some(g)
                });
                tag_ok && group_ok
            })
            .collect();
        if out.is_empty() {
            return Err(CliError::NotFound("no servers match the filter".into()));
        }
        out.sort_by_key(|s| name_of(s).to_lowercase());
        return Ok(out);
    }
    if needles.is_empty() {
        return Err(CliError::Error(
            "no servers given — pass names/ids or --all/--tag/--group".into(),
        ));
    }
    needles
        .iter()
        .map(|needle| resolve_in(&servers, needle))
        .collect()
}

// ──────────────────────────────────────────────────────────────────────────
// status / list / show
// ──────────────────────────────────────────────────────────────────────────

pub fn status(client: &Client, out: &Output) -> Result<()> {
    let value = client.get("/status")?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let version = value.get("version").and_then(Value::as_str).unwrap_or("?");
    let api = value
        .get("apiVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let pid = value.get("pid").and_then(Value::as_u64).unwrap_or(0);
    let cpu = value
        .pointer("/host/cpu")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as f32;
    let ram = value
        .pointer("/host/ram")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as f32;

    let servers = fetch_servers(client).unwrap_or_default();
    let running = servers.iter().filter(|s| running_of(s)).count();

    println!(
        "{} v{} · api v{} · pid {}",
        out.bold("kern"),
        version,
        api,
        pid
    );
    println!(
        "{}  {} of {} running",
        out.dim("servers"),
        if running > 0 {
            out.green(&running.to_string())
        } else {
            running.to_string()
        },
        servers.len()
    );
    println!(
        "{}  cpu {}  ram {}",
        out.dim("host   "),
        fmt_pct(Some(cpu)),
        fmt_pct(Some(ram))
    );
    Ok(())
}

pub fn list(client: &Client, out: &Output, args: &ListArgs) -> Result<()> {
    let path = if args.ports {
        "/servers?ports=1"
    } else {
        "/servers"
    };
    let value = client.get(path)?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let mut servers = value
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    servers.retain(|s| {
        let tag_ok = args.tag.as_ref().is_none_or(|t| {
            s.get("tags")
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(t.as_str())))
        });
        let group_ok = args
            .group
            .as_ref()
            .is_none_or(|g| s.get("group").and_then(Value::as_str) == Some(g.as_str()));
        let running = running_of(s);
        let orphaned = s
            .get("orphaned")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let running_ok = !args.running || running;
        let stopped_ok = !args.stopped || !running;
        let orphan_ok = !args.orphaned || orphaned;
        tag_ok && group_ok && running_ok && stopped_ok && orphan_ok
    });

    sort_servers(&mut servers, args.sort);
    if args.reverse {
        servers.reverse();
    }

    if args.ports && out.format == Format::Plain {
        // Plain format stays one line per server; ports joined with commas.
    }

    if out.format == Format::Plain {
        for s in &servers {
            println!(
                "{}\t{}\t{}\t{}\t{}\t{}",
                id_of(s),
                name_of(s),
                s.get("status").and_then(Value::as_str).unwrap_or(""),
                running_of(s),
                fmt_pct(cpu_of(s)),
                fmt_pct(ram_of(s)),
            );
        }
        return Ok(());
    }

    let ports_enabled = args.ports;
    let mut headers = vec!["STATUS", "NAME", "CPU", "RAM", "UPTIME", "GROUP"];
    if ports_enabled {
        headers.push("PORTS");
    }
    headers.push("ID");

    let rows: Vec<Vec<String>> = servers
        .iter()
        .map(|s| {
            let status = s.get("status").and_then(Value::as_str).unwrap_or("");
            let orphaned = s
                .get("orphaned")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let badge = if orphaned {
                out.amber("orphaned")
            } else {
                out.status_badge(status, running_of(s))
            };
            let mut row = vec![
                badge,
                name_of(s),
                fmt_pct(cpu_of(s)),
                fmt_pct(ram_of(s)),
                fmt_uptime(s.get("uptimeSecs").and_then(Value::as_u64)),
                s.get("group").and_then(Value::as_str).unwrap_or("-").to_string(),
            ];
            if ports_enabled {
                row.push(ports_of(s).join(","));
            }
            row.push(id_of(s));
            row
        })
        .collect();

    out.table(&headers, &rows);
    Ok(())
}

fn cpu_of(server: &Value) -> Option<f32> {
    server.pointer("/metrics/cpu").and_then(Value::as_f64).map(|v| v as f32)
}

fn ram_of(server: &Value) -> Option<f32> {
    server.pointer("/metrics/ram").and_then(Value::as_f64).map(|v| v as f32)
}

fn ports_of(server: &Value) -> Vec<String> {
    server
        .get("ports")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| p.get("port").and_then(Value::as_u64).map(|v| v.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn sort_servers(servers: &mut [Value], key: SortKey) {
    match key {
        SortKey::Name => servers.sort_by_key(|s| name_of(s).to_lowercase()),
        SortKey::Status => servers.sort_by_key(|s| {
            s.get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }),
        SortKey::Cpu => servers.sort_by(|a, b| {
            cpu_of(b)
                .unwrap_or(-1.0)
                .total_cmp(&cpu_of(a).unwrap_or(-1.0))
        }),
        SortKey::Ram => servers.sort_by(|a, b| {
            ram_of(b)
                .unwrap_or(-1.0)
                .total_cmp(&ram_of(a).unwrap_or(-1.0))
        }),
        SortKey::Uptime => servers.sort_by(|a, b| {
            b.get("uptimeSecs")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .cmp(&a.get("uptimeSecs").and_then(Value::as_u64).unwrap_or(0))
        }),
    }
}

pub fn show(client: &Client, out: &Output, server: &str) -> Result<()> {
    let s = resolve_server(client, server)?;
    let id = id_of(&s);
    let detail = client.get(&format!("/servers/{id}"))?;
    if out.format == Format::Json {
        print_json(&detail);
        return Ok(());
    }
    let status = detail.get("status").and_then(Value::as_str).unwrap_or("");
    let running = running_of(&detail);
    let mut pairs: Vec<(&str, String)> = vec![
        ("name", name_of(&detail)),
        ("id", id.clone()),
        ("status", out.status_badge(status, running)),
        ("type", detail.get("type").and_then(Value::as_str).unwrap_or("-").to_string()),
        (
            "path",
            detail.get("path").and_then(Value::as_str).unwrap_or("-").to_string(),
        ),
        (
            "group",
            detail.get("group").and_then(Value::as_str).unwrap_or("-").to_string(),
        ),
        (
            "tags",
            detail
                .get("tags")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "-".to_string()),
        ),
        (
            "autoStart",
            detail
                .get("autoStart")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                .to_string(),
        ),
        (
            "pid",
            detail
                .get("pid")
                .and_then(Value::as_u64)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "-".to_string()),
        ),
        ("uptime", fmt_uptime(detail.get("uptimeSecs").and_then(Value::as_u64))),
        ("cpu", fmt_pct(cpu_of(&detail))),
        ("ram", fmt_pct(ram_of(&detail))),
    ];
    if detail.get("adopted").and_then(Value::as_bool).unwrap_or(false) {
        pairs.push(("adopted", out.amber("yes (pid-only monitor)").to_string()));
    }
    if detail.get("orphaned").and_then(Value::as_bool).unwrap_or(false) {
        pairs.push(("orphaned", out.amber("yes (folder missing)").to_string()));
    }
    let ports = ports_of(&detail);
    let ports_text = if ports.is_empty() {
        "-".to_string()
    } else {
        detail
            .get("ports")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| p.get("connect").and_then(Value::as_str).map(str::to_string))
                    .collect::<Vec<_>>()
                    .join("  ")
            })
            .unwrap_or_else(|| ports.join(","))
    };
    pairs.push(("ports", ports_text));
    out.key_values(&pairs);

    if let Some(crash) = detail.get("lastCrash").filter(|c| !c.is_null()) {
        println!();
        let at = crash.get("at").and_then(Value::as_u64).unwrap_or(0);
        let code = crash
            .get("exitCode")
            .and_then(Value::as_i64)
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string());
        println!(
            "{} {}  exit {code}",
            out.red("last crash"),
            fmt_time(at)
        );
        if let Some(tail) = crash.get("tail").and_then(Value::as_array) {
            for line in tail.iter().filter_map(Value::as_str).take(10) {
                println!("  {}", out.dim(line));
            }
        }
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// registry mutations
// ──────────────────────────────────────────────────────────────────────────

pub fn add(client: &Client, out: &Output, args: &AddArgs) -> Result<()> {
    let path = std::path::Path::new(&args.path);
    if !path.exists() {
        return Err(CliError::Error(format!("'{}' does not exist", args.path)));
    }
    let name = args
        .name
        .clone()
        .or_else(|| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(str::to_string)
        })
        .ok_or_else(|| CliError::Error("could not derive a name — pass --name".into()))?;
    let body = json!({
        "name": name,
        "serverType": args.server_type,
        "path": path.to_string_lossy(),
        "group": args.group,
        "tags": args.tags,
        "autoStart": args.auto_start,
        "imported": args.import,
    });
    let created = client.post("/servers", Some(&body))?;
    if out.format == Format::Json {
        print_json(&created);
    } else if !out.quiet {
        println!(
            "{} registered {} ({})",
            out.green("●"),
            name_of(&created),
            id_of(&created)
        );
    }
    if args.start {
        let id = id_of(&created);
        client.post(&format!("/servers/{id}/start"), None)?;
        if !out.quiet {
            println!("{} started {}", out.green("●"), name_of(&created));
        }
    }
    Ok(())
}

pub fn inspect(client: &Client, out: &Output, path: &str) -> Result<()> {
    let value = client.get(&format!("/inspect?path={}", urlencode(path)))?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let pairs: Vec<(&str, String)> = vec![
        ("path", value.get("path").and_then(Value::as_str).unwrap_or("-").to_string()),
        ("suggested name", value.get("suggestedName").and_then(Value::as_str).unwrap_or("-").to_string()),
        ("suggested runtime", value.get("suggestedRuntime").and_then(Value::as_str).unwrap_or("-").to_string()),
        ("server properties", value.get("hasServerProperties").and_then(Value::as_bool).unwrap_or(false).to_string()),
        ("world", value.get("hasWorld").and_then(Value::as_bool).unwrap_or(false).to_string()),
        ("eula declined", value.get("eulaDeclined").and_then(Value::as_bool).unwrap_or(false).to_string()),
        ("jars", value.get("jars").and_then(Value::as_array).map(|a| join_strs(a)).filter(|s| !s.is_empty()).unwrap_or_else(|| "-".into())),
        ("start scripts", value.get("startScripts").and_then(Value::as_array).map(|a| join_strs(a)).filter(|s| !s.is_empty()).unwrap_or_else(|| "-".into())),
    ];
    out.key_values(&pairs);
    Ok(())
}

fn join_strs(values: &[Value]) -> String {
    values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
}

pub fn edit(client: &Client, out: &Output, args: &EditArgs) -> Result<()> {
    if args.group.is_some() && args.clear_group {
        return Err(CliError::Error(
            "--group and --clear-group cannot be combined".into(),
        ));
    }
    if args.auto_start && args.no_auto_start {
        return Err(CliError::Error(
            "--auto-start and --no-auto-start cannot be combined".into(),
        ));
    }
    let server = resolve_server(client, &args.server)?;
    let id = id_of(&server);
    let mut patch = serde_json::Map::new();
    if let Some(name) = &args.name {
        patch.insert("name".into(), json!(name));
    }
    if let Some(group) = &args.group {
        patch.insert("group".into(), json!(group));
    }
    if args.clear_group {
        patch.insert("group".into(), Value::Null);
    }
    if !args.tags.is_empty() {
        patch.insert("tags".into(), json!(args.tags));
    }
    if args.auto_start {
        patch.insert("autoStart".into(), json!(true));
    }
    if args.no_auto_start {
        patch.insert("autoStart".into(), json!(false));
    }
    if let Some(stop_command) = &args.stop_command {
        patch.insert("stopCommand".into(), json!(stop_command));
    }
    if let Some(timeout) = args.stop_timeout {
        patch.insert("stopTimeoutSecs".into(), json!(timeout));
    }
    if patch.is_empty() {
        return Err(CliError::Error("nothing to change — pass at least one flag".into()));
    }
    let updated = client.patch(&format!("/servers/{id}"), &Value::Object(patch))?;
    if out.format == Format::Json {
        print_json(&updated);
    } else if !out.quiet {
        println!("{} updated {}", out.green("●"), name_of(&updated));
    }
    Ok(())
}

pub fn remove(client: &Client, out: &Output, args: &RmArgs) -> Result<()> {
    let server = resolve_server(client, &args.server)?;
    let id = id_of(&server);
    if args.folder && !args.yes {
        return Err(CliError::Error(format!(
            "refusing to delete the working directory of '{}' without --yes",
            name_of(&server)
        )));
    }
    let path = if args.folder {
        format!("/servers/{id}?folder=1")
    } else {
        format!("/servers/{id}")
    };
    let result = client.delete(&path)?;
    if out.format == Format::Json {
        print_json(&result);
    } else if !out.quiet {
        let folder_note = if args.folder {
            if result.get("folderDeleted").and_then(Value::as_bool).unwrap_or(false) {
                " and its folder"
            } else {
                " (folder deletion failed)"
            }
        } else {
            ""
        };
        println!("{} removed {}{}", out.green("●"), name_of(&server), folder_note);
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// lifecycle
// ──────────────────────────────────────────────────────────────────────────

pub fn action(client: &Client, out: &Output, action: &str, args: &ActionArgs) -> Result<()> {
    let targets = resolve_targets(client, &args.servers, args.all, args.tag.as_deref(), args.group.as_deref())?;
    let timeout = parse_duration(&args.timeout).map_err(CliError::Error)?;
    let mut failures = 0usize;

    for server in &targets {
        let id = id_of(server);
        let name = name_of(server);
        match client.post(&format!("/servers/{id}/{action}"), None) {
            Ok(_) => {
                if !out.quiet {
                    println!("{} {} {}", out.green("●"), action, name);
                }
            }
            Err(e) => {
                eprintln!("{} {} {}: {e}", out.red("×"), action, name);
                failures += 1;
                continue;
            }
        }
        if args.wait {
            let result = match action {
                "start" | "install" => wait_for_state(client, &id, WaitFor::Running, timeout),
                "stop" => wait_for_state(client, &id, WaitFor::Stopped, timeout),
                "restart" => {
                    wait_for_state(client, &id, WaitFor::Stopped, timeout)
                        .and_then(|_| wait_for_state(client, &id, WaitFor::Running, timeout))
                }
                _ => Ok(()),
            };
            match result {
                Ok(()) => {
                    if !out.quiet {
                        println!("  {} {}", out.green("✓"), name);
                    }
                }
                Err(e) => {
                    eprintln!("{} {}: {e}", out.red("×"), name);
                    failures += 1;
                }
            }
        }
    }
    if failures > 0 {
        return Err(CliError::Error(format!("{failures} action(s) failed")));
    }
    Ok(())
}

pub fn wait(client: &Client, out: &Output, args: &WaitArgs) -> Result<()> {
    let server = resolve_server(client, &args.server)?;
    let id = id_of(&server);
    let timeout = parse_duration(&args.timeout).map_err(CliError::Error)?;
    wait_for_state(client, &id, args.wait_for, timeout)?;
    if !out.quiet {
        println!(
            "{} {} is {}",
            out.green("✓"),
            name_of(&server),
            match args.wait_for {
                WaitFor::Running => "running",
                WaitFor::Stopped => "stopped",
                WaitFor::Healthy => "healthy",
            }
        );
    }
    Ok(())
}

fn wait_for_state(client: &Client, id: &str, state: WaitFor, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let detail = client.get(&format!("/servers/{id}"))?;
        let running = running_of(&detail);
        let ok = match state {
            WaitFor::Running => running,
            WaitFor::Stopped => !running && !is_transitional(&detail),
            WaitFor::Healthy => running && is_healthy(&detail),
        };
        if ok {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(CliError::Timeout(format!(
                "timed out waiting for '{id}' to become {}",
                match state {
                    WaitFor::Running => "running",
                    WaitFor::Stopped => "stopped",
                    WaitFor::Healthy => "healthy",
                }
            )));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// A status of starting/stopping/restarting means the process state is in flux.
fn is_transitional(server: &Value) -> bool {
    matches!(
        server.get("status").and_then(Value::as_str),
        Some("starting") | Some("stopping") | Some("restarting")
    )
}

/// Running, clear of a fault status, and below 95% CPU/RAM when metrics exist.
fn is_healthy(server: &Value) -> bool {
    let status = server.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "error" || status == "stopped-forced" {
        return false;
    }
    let cpu_ok = cpu_of(server).is_none_or(|c| c < 0.95);
    let ram_ok = ram_of(server).is_none_or(|r| r < 0.95);
    cpu_ok && ram_ok
}

// ──────────────────────────────────────────────────────────────────────────
// logs / stdin
// ──────────────────────────────────────────────────────────────────────────

pub fn logs(client: &Client, out: &Output, args: &LogsArgs) -> Result<()> {
    let server = resolve_server(client, &args.server)?;
    let id = id_of(&server);
    let interval = parse_duration(&args.interval).map_err(CliError::Error)?;
    let grep = compile_regex(args.grep.as_deref())?;
    let exclude = compile_regex(args.exclude.as_deref())?;

    let mut offset: u64 = 0;
    loop {
        let path = format!("/servers/{id}/log?lines={}&offset={offset}", args.lines);
        let value = client.get(&path)?;
        if out.format == Format::Json && !args.follow {
            print_json(&value);
            return Ok(());
        }
        let lines = value
            .get("lines")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for line in lines.iter().filter_map(Value::as_str) {
            if !passes_filters(line, grep.as_ref(), exclude.as_ref()) {
                continue;
            }
            if out.format == Format::Json {
                println!("{}", json!({ "line": line }));
            } else {
                println!("{line}");
            }
        }
        offset = value.get("nextOffset").and_then(Value::as_u64).unwrap_or(offset);
        if !args.follow {
            return Ok(());
        }
        std::thread::sleep(interval);
    }
}

fn compile_regex(pattern: Option<&str>) -> Result<Option<Regex>> {
    match pattern {
        Some(p) => Regex::new(p)
            .map(Some)
            .map_err(|e| CliError::Error(format!("invalid regex '{p}': {e}"))),
        None => Ok(None),
    }
}

fn passes_filters(line: &str, grep: Option<&Regex>, exclude: Option<&Regex>) -> bool {
    if let Some(grep) = grep {
        if !grep.is_match(line) {
            return false;
        }
    }
    !exclude.is_some_and(|ex| ex.is_match(line))
}

pub fn send(client: &Client, out: &Output, args: &SendArgs) -> Result<()> {
    let server = resolve_server(client, &args.server)?;
    let id = id_of(&server);
    let line = args.message.join(" ");
    let value = client.post(&format!("/servers/{id}/stdin"), Some(&json!({ "line": line })))?;
    if out.format == Format::Json {
        print_json(&value);
    } else if !out.quiet {
        println!("{} sent to {}", out.green("●"), name_of(&server));
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// monitoring
// ──────────────────────────────────────────────────────────────────────────

pub fn host(client: &Client, out: &Output) -> Result<()> {
    let value = client.get("/host/metrics")?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let cpu = value.get("cpu").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    let ram = value.get("ram").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    println!("cpu {}   ram {}", fmt_pct(Some(cpu)), fmt_pct(Some(ram)));
    Ok(())
}

pub fn metrics(client: &Client, out: &Output, args: &MetricsArgs) -> Result<()> {
    let server = resolve_server(client, &args.server)?;
    let id = id_of(&server);
    let value = client.get(&format!("/servers/{id}/metrics?window={}", args.window))?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let samples = value
        .get("samples")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if args.spark {
        let cpus: Vec<f32> = samples
            .iter()
            .filter_map(|s| s.get("cpu").and_then(Value::as_f64).map(|v| v as f32))
            .collect();
        let rams: Vec<f32> = samples
            .iter()
            .filter_map(|s| s.get("ram").and_then(Value::as_f64).map(|v| v as f32))
            .collect();
        if cpus.is_empty() {
            println!("(no samples yet)");
            return Ok(());
        }
        println!("cpu {}", sparkline(&cpus));
        println!("ram {}", sparkline(&rams));
        let avg = |v: &[f32]| v.iter().sum::<f32>() / v.len().max(1) as f32;
        println!(
            "{}",
            out.dim(&format!(
                "{} samples · cpu avg {} peak {} · ram avg {} peak {}",
                cpus.len(),
                fmt_pct(Some(avg(&cpus))),
                fmt_pct(Some(cpus.iter().cloned().fold(0.0, f32::max))),
                fmt_pct(Some(avg(&rams))),
                fmt_pct(Some(rams.iter().cloned().fold(0.0, f32::max))),
            ))
        );
        return Ok(());
    }

    let rows: Vec<Vec<String>> = samples
        .iter()
        .rev()
        .take(40)
        .map(|s| {
            vec![
                fmt_time(s.get("at").and_then(Value::as_u64).unwrap_or(0)),
                fmt_pct(s.get("cpu").and_then(Value::as_f64).map(|v| v as f32)),
                fmt_pct(s.get("ram").and_then(Value::as_f64).map(|v| v as f32)),
            ]
        })
        .collect();
    out.table(&["TIME", "CPU", "RAM"], &rows);
    Ok(())
}

pub fn energy(client: &Client, out: &Output, server: &str) -> Result<()> {
    let s = resolve_server(client, server)?;
    let value = client.get(&format!("/servers/{}/energy", id_of(&s)))?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let pairs: Vec<(&str, String)> = vec![
        (
            "estimated cost",
            format!(
                "{:.2} ({})",
                value.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
                value.get("currencyNote").and_then(Value::as_str).unwrap_or("")
            ),
        ),
        (
            "hours",
            format!("{:.1}", value.get("hours").and_then(Value::as_f64).unwrap_or(0.0)),
        ),
        (
            "estimated watts",
            format!("{:.0}", value.get("estWatts").and_then(Value::as_f64).unwrap_or(0.0)),
        ),
    ];
    out.key_values(&pairs);
    Ok(())
}

pub fn port(client: &Client, out: &Output, server: &str) -> Result<()> {
    let s = resolve_server(client, server)?;
    let detail = client.get(&format!("/servers/{}", id_of(&s)))?;
    if out.format == Format::Json {
        print_json(detail.get("ports").unwrap_or(&Value::Null));
        return Ok(());
    }
    let ports = detail.get("ports").and_then(Value::as_array).cloned().unwrap_or_default();
    if ports.is_empty() {
        println!("(no listening ports)");
        return Ok(());
    }
    let rows: Vec<Vec<String>> = ports
        .iter()
        .map(|p| {
            vec![
                p.get("port").and_then(Value::as_u64).unwrap_or(0).to_string(),
                p.get("connect").and_then(Value::as_str).unwrap_or("-").to_string(),
            ]
        })
        .collect();
    out.table(&["PORT", "CONNECT"], &rows);
    Ok(())
}

pub fn preflight(client: &Client, out: &Output, server: &str) -> Result<()> {
    let s = resolve_server(client, server)?;
    let value = client.get(&format!("/servers/{}/preflight", id_of(&s)))?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let conflicts = value
        .get("conflicts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if conflicts.is_empty()
        && !value.get("eulaPending").and_then(Value::as_bool).unwrap_or(false)
        && !value.get("lowDisk").and_then(Value::as_bool).unwrap_or(false)
    {
        println!("{} all clear", out.green("✓"));
        return Ok(());
    }
    for c in &conflicts {
        println!(
            "{} port {} held by {} (pid {})",
            out.red("!"),
            c.get("port").and_then(Value::as_u64).unwrap_or(0),
            c.get("process").and_then(Value::as_str).unwrap_or("?"),
            c.get("pid").and_then(Value::as_u64).unwrap_or(0),
        );
    }
    if value.get("eulaPending").and_then(Value::as_bool).unwrap_or(false) {
        println!("{} minecraft eula is pending (edit eula.txt)", out.amber("!"));
    }
    if value.get("lowDisk").and_then(Value::as_bool).unwrap_or(false) {
        println!(
            "{} low disk space ({} MB free)",
            out.amber("!"),
            value.get("freeMb").and_then(Value::as_u64).unwrap_or(0)
        );
    }
    Ok(())
}

pub fn crash(client: &Client, out: &Output, server: &str) -> Result<()> {
    let s = resolve_server(client, server)?;
    let value = client.get(&format!("/servers/{}/crash", id_of(&s)))?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let crash = value.get("crash").filter(|c| !c.is_null());
    let Some(crash) = crash else {
        println!("(no crash recorded)");
        return Ok(());
    };
    println!(
        "{} {}  exit {}",
        out.red("last crash"),
        fmt_time(crash.get("at").and_then(Value::as_u64).unwrap_or(0)),
        crash
            .get("exitCode")
            .and_then(Value::as_i64)
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string())
    );
    if let Some(tail) = crash.get("tail").and_then(Value::as_array) {
        for line in tail.iter().filter_map(Value::as_str) {
            println!("  {line}");
        }
    }
    Ok(())
}

pub fn top(client: &Client, out: &Output, args: &TopArgs) -> Result<()> {
    let interval = parse_duration(&args.interval).map_err(CliError::Error)?;
    let live = !args.once && out.format == Format::Table && out.color;
    loop {
        let servers = fetch_servers(client)?;
        let host = client.get("/host/metrics").unwrap_or(Value::Null);
        let cpu = host.get("cpu").and_then(Value::as_f64).unwrap_or(0.0) as f32;
        let ram = host.get("ram").and_then(Value::as_f64).unwrap_or(0.0) as f32;

        if live {
            print!("\x1b[2J\x1b[H");
        }
        println!(
            "{}  host cpu {}  ram {}  ({} servers)",
            out.bold("kern top"),
            fmt_pct(Some(cpu)),
            fmt_pct(Some(ram)),
            servers.len()
        );
        let rows: Vec<Vec<String>> = servers
            .iter()
            .map(|s| {
                let status = s.get("status").and_then(Value::as_str).unwrap_or("");
                vec![
                    out.status_badge(status, running_of(s)),
                    name_of(s),
                    fmt_pct(cpu_of(s)),
                    fmt_pct(ram_of(s)),
                    fmt_uptime(s.get("uptimeSecs").and_then(Value::as_u64)),
                    id_of(s),
                ]
            })
            .collect();
        out.table(
            &["STATUS", "NAME", "CPU", "RAM", "UPTIME", "ID"],
            &rows,
        );
        if args.once {
            return Ok(());
        }
        std::thread::sleep(interval);
    }
}

// ──────────────────────────────────────────────────────────────────────────
// backups / tasks / events / audit
// ──────────────────────────────────────────────────────────────────────────

fn backup_name(item: &Value) -> String {
    item.get("name")
        .or_else(|| item.get("file"))
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string()
}

pub fn backup(client: &Client, out: &Output, cmd: &BackupCmd) -> Result<()> {
    match cmd {
        BackupCmd::List { server } => {
            let s = resolve_server(client, server)?;
            let value = client.get(&format!("/servers/{}/backups", id_of(&s)))?;
            if out.format == Format::Json {
                print_json(&value);
                return Ok(());
            }
            let items = value
                .get("backups")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                println!("(no backups)");
                return Ok(());
            }
            let rows: Vec<Vec<String>> = items
                .iter()
                .map(|b| {
                    vec![
                        backup_name(b),
                        b.get("size")
                            .or_else(|| b.get("sizeBytes"))
                            .and_then(Value::as_u64)
                            .map(fmt_size)
                            .unwrap_or_else(|| "-".into()),
                        backup_created(b),
                    ]
                })
                .collect();
            out.table(&["BACKUP", "SIZE", "CREATED"], &rows);
            Ok(())
        }
        BackupCmd::Create { server, wait } => {
            let s = resolve_server(client, server)?;
            let id = id_of(&s);
            let before: HashSet<String> = if *wait {
                list_backup_names(client, &id)?
            } else {
                HashSet::new()
            };
            client.post(&format!("/servers/{id}/backup"), None)?;
            if out.format == Format::Json {
                println!("{}", json!({ "action": "backup", "status": "accepted" }));
                return Ok(());
            }
            if !out.quiet {
                println!("{} backup accepted for {}", out.green("●"), name_of(&s));
            }
            if *wait {
                let deadline = Instant::now() + Duration::from_secs(600);
                loop {
                    let names = list_backup_names(client, &id)?;
                    if names.len() > before.len() {
                        if !out.quiet {
                            println!("{} backup complete", out.green("✓"));
                        }
                        return Ok(());
                    }
                    if Instant::now() >= deadline {
                        return Err(CliError::Timeout("timed out waiting for the backup".into()));
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            Ok(())
        }
        BackupCmd::Restore {
            server,
            backup: name,
            yes,
        } => {
            if !yes {
                return Err(CliError::Error(
                    "restoring overwrites the world — pass --yes to confirm".into(),
                ));
            }
            let s = resolve_server(client, server)?;
            let id = id_of(&s);
            client.post(
                &format!("/servers/{id}/backups/{}/restore", urlencode(name)),
                None,
            )?;
            if out.format == Format::Json {
                println!("{}", json!({ "action": "restore", "status": "accepted" }));
            } else if !out.quiet {
                println!("{} restore accepted for {}", out.green("●"), name_of(&s));
            }
            Ok(())
        }
        BackupCmd::Delete {
            server,
            backup: name,
            yes,
        } => {
            if !yes {
                return Err(CliError::Error(
                    "deleting a backup cannot be undone — pass --yes to confirm".into(),
                ));
            }
            let s = resolve_server(client, server)?;
            let value = client.delete(&format!(
                "/servers/{}/backups/{}",
                id_of(&s),
                urlencode(name)
            ))?;
            if out.format == Format::Json {
                print_json(&value);
            } else if !out.quiet {
                println!("{} deleted {}", out.green("●"), name);
            }
            Ok(())
        }
    }
}

fn list_backup_names(client: &Client, id: &str) -> Result<HashSet<String>> {
    let value = client.get(&format!("/servers/{id}/backups"))?;
    Ok(value
        .get("backups")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(backup_name).collect())
        .unwrap_or_default())
}

/// Timestamp parsed from the archive name: `world-2026-06-30T14-30-00.zip` or
/// `pre-restore-<epoch>.zip`. The API only exposes name + size.
fn backup_created(item: &Value) -> String {
    let name = backup_name(item);
    if let Some(stamp) = name
        .strip_prefix("world-")
        .and_then(|rest| rest.strip_suffix(".zip"))
    {
        if let Some((date, time)) = stamp.split_once('T') {
            return format!("{date} {}", time.replace('-', ":"));
        }
    }
    if let Some(epoch) = name
        .strip_prefix("pre-restore-")
        .and_then(|rest| rest.strip_suffix(".zip"))
    {
        if let Ok(secs) = epoch.parse::<u64>() {
            return fmt_time(secs);
        }
    }
    "-".to_string()
}

fn fmt_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

pub fn task(client: &Client, out: &Output, cmd: &TaskCmd) -> Result<()> {
    match cmd {
        TaskCmd::List { server } => {
            let s = resolve_server(client, server)?;
            let value = client.get(&format!("/servers/{}/tasks", id_of(&s)))?;
            if out.format == Format::Json {
                print_json(&value);
                return Ok(());
            }
            let tasks = value
                .get("tasks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if tasks.is_empty() {
                println!("(no scheduled tasks)");
                return Ok(());
            }
            let rows: Vec<Vec<String>> = tasks
                .iter()
                .map(|t| {
                    let schedule = task_schedule(t);
                    vec![
                        t.get("id").and_then(Value::as_str).unwrap_or("-").to_string(),
                        t.get("name").and_then(Value::as_str).unwrap_or("-").to_string(),
                        t.get("action").and_then(Value::as_str).unwrap_or("-").to_string(),
                        schedule,
                        if t.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
                            out.green("on")
                        } else {
                            out.dim("off")
                        },
                    ]
                })
                .collect();
            out.table(&["ID", "NAME", "ACTION", "SCHEDULE", "ENABLED"], &rows);
            Ok(())
        }
        TaskCmd::Run { server, task } => {
            let s = resolve_server(client, server)?;
            let id = id_of(&s);
            let list = client.get(&format!("/servers/{id}/tasks"))?;
            let tasks = list
                .get("tasks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let task_id = tasks
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(task.as_str()))
                .or_else(|| {
                    tasks
                        .iter()
                        .find(|t| t.get("name").and_then(Value::as_str) == Some(task.as_str()))
                })
                .and_then(|t| t.get("id").and_then(Value::as_str))
                .ok_or_else(|| CliError::NotFound(format!("no task matches '{task}'")))?
                .to_string();
            let value = client.post(&format!("/servers/{id}/tasks/{task_id}/run"), None)?;
            if out.format == Format::Json {
                print_json(&value);
            } else if !out.quiet {
                println!("{} ran task {task_id}", out.green("●"));
            }
            Ok(())
        }
    }
}

fn task_schedule(task: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(secs) = task.get("intervalSecs").and_then(Value::as_u64).filter(|s| *s > 0) {
        parts.push(format!("every {secs}s"));
    }
    if let Some(at) = task.get("dailyAt").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        parts.push(format!("daily {at}"));
    }
    if let Some(cron) = task.get("cron").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        parts.push(format!("cron {cron}"));
    }
    if parts.is_empty() {
        "-".to_string()
    } else {
        parts.join(" + ")
    }
}

pub fn events(client: &Client, out: &Output, args: &EventsArgs) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // One-shot shows the last hour; --follow streams only what happens next.
    let mut since = if args.follow { now } else { now.saturating_sub(3600) };
    let mut seen: HashSet<String> = HashSet::new();
    let mut statuses: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    loop {
        let wait = if args.follow { 25 } else { 0 };
        let value = client.get_with_timeout(
            &format!("/events?since={since}&wait={wait}"),
            Duration::from_secs(wait + 15),
        )?;

        if let Some(map) = value.get("statuses").and_then(Value::as_object) {
            for (id, status) in map {
                let status = status.as_str().unwrap_or("").to_string();
                match statuses.get(id) {
                    Some(previous) if *previous != status => {
                        if out.format == Format::Json {
                            println!(
                                "{}",
                                json!({ "type": "status", "serverId": id, "from": previous, "to": status })
                            );
                        } else {
                            println!(
                                "{} {} {} → {}",
                                out.dim(&fmt_time(now)),
                                out.amber("status"),
                                previous,
                                status
                            );
                        }
                    }
                    _ => {}
                }
                statuses.insert(id.clone(), status);
            }
        }

        let entries = value
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for entry in &entries {
            let fingerprint = format!(
                "{}|{}|{}|{}",
                entry.get("at").and_then(Value::as_u64).unwrap_or(0),
                entry.get("action").and_then(Value::as_str).unwrap_or(""),
                entry.get("detail").and_then(Value::as_str).unwrap_or(""),
                entry.get("serverId").and_then(Value::as_str).unwrap_or(""),
            );
            if !seen.insert(fingerprint) {
                continue;
            }
            if out.format == Format::Json {
                println!("{entry}");
            } else {
                println!(
                    "{} {} {}",
                    out.dim(&fmt_time(entry.get("at").and_then(Value::as_u64).unwrap_or(0))),
                    out.green(entry.get("action").and_then(Value::as_str).unwrap_or("?")),
                    entry.get("detail").and_then(Value::as_str).unwrap_or("")
                );
            }
        }

        let now_cursor = value.get("now").and_then(Value::as_u64).unwrap_or(since);
        // Overlap by one second to avoid skipping same-second entries; `seen`
        // dedupes anything we've already streamed.
        since = now_cursor.saturating_sub(1);
        if !args.follow {
            return Ok(());
        }
    }
}

pub fn audit(client: &Client, out: &Output, args: &AuditArgs) -> Result<()> {
    let server_filter = match &args.server {
        Some(needle) => Some(id_of(&resolve_server(client, needle)?)),
        None => None,
    };
    let value = client.get(&format!("/audit?limit={}", args.limit.clamp(1, 500)))?;
    if out.format == Format::Json {
        print_json(&value);
        return Ok(());
    }
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let filtered: Vec<&Value> = entries
        .iter()
        .filter(|e| {
            server_filter.as_ref().is_none_or(|id| {
                e.get("serverId").and_then(Value::as_str) == Some(id.as_str())
            })
        })
        .collect();
    if filtered.is_empty() {
        println!("(no audit entries)");
        return Ok(());
    }
    for entry in filtered {
        println!(
            "{} {} {}",
            out.dim(&fmt_time(entry.get("at").and_then(Value::as_u64).unwrap_or(0))),
            out.green(entry.get("action").and_then(Value::as_str).unwrap_or("?")),
            entry.get("detail").and_then(Value::as_str).unwrap_or("")
        );
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// plugins / raw api / doctor / endpoint
// ──────────────────────────────────────────────────────────────────────────

pub fn plugin(client: &Client, out: &Output, cmd: &PluginCmd) -> Result<()> {
    match cmd {
        PluginCmd::List => {
            let value = client.get("/plugins")?;
            if out.format == Format::Json {
                print_json(&value);
                return Ok(());
            }
            let plugins = value
                .get("plugins")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if plugins.is_empty() {
                println!("(no plugins installed)");
                return Ok(());
            }
            let rows: Vec<Vec<String>> = plugins
                .iter()
                .map(|p| {
                    vec![
                        p.get("id").and_then(Value::as_str).unwrap_or("-").to_string(),
                        p.get("displayName").and_then(Value::as_str).unwrap_or("-").to_string(),
                        p.get("version").and_then(Value::as_str).unwrap_or("-").to_string(),
                        p.get("author").and_then(Value::as_str).unwrap_or("-").to_string(),
                    ]
                })
                .collect();
            out.table(&["ID", "NAME", "VERSION", "AUTHOR"], &rows);
            Ok(())
        }
        PluginCmd::Install { path, force } => {
            let value = client.post(
                "/plugins/install",
                Some(&json!({ "path": path, "force": force })),
            )?;
            if out.format == Format::Json {
                print_json(&value);
            } else if !out.quiet {
                println!(
                    "{} installed {} {}",
                    out.green("●"),
                    value.get("displayName").and_then(Value::as_str).unwrap_or("plugin"),
                    value.get("version").and_then(Value::as_str).unwrap_or("")
                );
            }
            Ok(())
        }
        PluginCmd::Remove { id } => {
            let value = client.delete(&format!("/plugins/{}", urlencode(id)))?;
            if out.format == Format::Json {
                print_json(&value);
            } else if !out.quiet {
                println!("{} removed {id}", out.green("●"));
            }
            Ok(())
        }
        PluginCmd::Validate { path } => {
            let value = client.post("/plugins/validate", Some(&json!({ "path": path })))?;
            if out.format == Format::Json {
                print_json(&value);
                return Ok(());
            }
            if value.get("valid").and_then(Value::as_bool).unwrap_or(false) {
                println!("{} valid package", out.green("✓"));
            } else {
                println!(
                    "{} invalid: {}",
                    out.red("×"),
                    value.get("error").and_then(Value::as_str).unwrap_or("unknown error")
                );
                return Err(CliError::Error("validation failed".into()));
            }
            Ok(())
        }
    }
}

pub fn api(client: &Client, _out: &Output, args: &ApiArgs) -> Result<()> {
    let method = args.method.to_uppercase();
    let body = match &args.body {
        Some(raw) => Some(
            serde_json::from_str::<Value>(raw)
                .map_err(|e| CliError::Error(format!("invalid --body JSON: {e}")))?,
        ),
        None => None,
    };
    let value = match method.as_str() {
        "GET" => client.get(&args.path)?,
        "POST" => client.post(&args.path, body.as_ref())?,
        "PATCH" => client.patch(
            &args.path,
            body.as_ref()
                .ok_or_else(|| CliError::Error("PATCH needs --body".into()))?,
        )?,
        "DELETE" => client.delete(&args.path)?,
        other => {
            return Err(CliError::Error(format!(
                "unsupported method '{other}' (use GET/POST/PATCH/DELETE)"
            )));
        }
    };
    print_json(&value);
    Ok(())
}

/// Runs without a discovered client: discovery failures are the diagnosis.
pub fn doctor(out: &Output) -> Result<()> {
    let env_override = matches!(
        (std::env::var("KERN_AUTOMATION_URL"), std::env::var("KERN_AUTOMATION_TOKEN")),
        (Ok(url), Ok(token)) if !url.trim().is_empty() && !token.trim().is_empty()
    );
    if env_override {
        println!("{} using KERN_AUTOMATION_URL / KERN_AUTOMATION_TOKEN override", out.green("ok"));
    } else {
        match client::read_endpoint_file() {
            Ok(endpoint) => {
                println!(
                    "{} endpoint file {} (v{}, pid {})",
                    out.green("ok"),
                    endpoint.path.display(),
                    endpoint.version,
                    endpoint.pid
                );
                if endpoint.version < 2 {
                    println!(
                        "{} endpoint file is v{} — restart kern after updating for richer diagnostics",
                        out.amber("warn"),
                        endpoint.version
                    );
                }
            }
            Err(e) => {
                // main prints the message once; don't duplicate it here.
                return Err(e);
            }
        }
    }

    let client = Client::discover()?;
    doctor_checks(&client, out)
}

fn doctor_checks(client: &Client, out: &Output) -> Result<()> {
    let mut failures = 0usize;
    match client.get("/status") {
        Ok(status) => {
            let version = status.get("version").and_then(Value::as_str).unwrap_or("?");
            let api = status.get("apiVersion").and_then(Value::as_u64).unwrap_or(0);
            println!("{} app reachable — kern v{version}, api v{api}, {}", out.green("ok"), client.url);
            let cli_version = env!("CARGO_PKG_VERSION");
            if version != cli_version {
                println!(
                    "{} cli v{cli_version} and app v{version} differ — reinstall the cli after upgrading kern",
                    out.amber("warn")
                );
            }
            if api < 2 {
                println!(
                    "{} app speaks api v{api}; this cli expects v2 — update kern",
                    out.red("fail")
                );
                failures += 1;
            }
        }
        Err(e) => {
            println!("{} {e}", out.red("fail"));
            failures += 1;
        }
    }

    if let Ok(servers) = fetch_servers(client) {
        let orphaned = servers
            .iter()
            .filter(|s| s.get("orphaned").and_then(Value::as_bool).unwrap_or(false))
            .count();
        println!(
            "{} {} servers registered{}",
            out.green("ok"),
            servers.len(),
            if orphaned > 0 {
                format!(", {} orphaned", out.amber(&orphaned.to_string()))
            } else {
                String::new()
            }
        );
    }

    if failures > 0 {
        return Err(CliError::Error(format!("{failures} check(s) failed")));
    }
    Ok(())
}

pub fn endpoint(client: &Client, out: &Output, args: &EndpointArgs) -> Result<()> {
    if out.format == Format::Json {
        let value = json!({
            "url": client.url,
            "token": if args.show_token { client.token.clone() } else { "***".into() },
            "endpointFile": client.endpoint.as_ref().map(|e| e.path.display().to_string()),
            "endpointVersion": client.endpoint.as_ref().map(|e| e.version),
            "pid": client.endpoint.as_ref().map(|e| e.pid),
            "startedAt": client.endpoint.as_ref().and_then(|e| (e.started_at > 0).then_some(e.started_at)),
        });
        print_json(&value);
        return Ok(());
    }
    println!("{}", client.url);
    if args.show_token {
        println!("{}", client.token);
    }
    if let Some(endpoint) = &client.endpoint {
        println!("{}  {}", out.dim("file  "), endpoint.path.display());
        if endpoint.started_at > 0 {
            println!("{}  {}", out.dim("since "), fmt_time(endpoint.started_at));
        }
        if endpoint.pid > 0 {
            println!("{}  {}", out.dim("pid   "), endpoint.pid);
        }
    }
    Ok(())
}

pub fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    );
}

/// Minimal percent-encoding for path/query segments (RFC 3986 unreserved kept).
pub fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
