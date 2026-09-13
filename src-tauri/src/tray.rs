//! System tray integration.
//!
//! Builds a `TrayIcon` in app setup, owns its (dynamically rebuilt) menu, and
//! routes menu / icon-click events. The menu lists every active server so the
//! user can jump straight to one, plus show/hide + quit entries.
//!
//! The menu is rebuilt whenever the running set changes: `process::launch`
//! emits `kern://running-set-changed` on registration, and the stdout reader
//! thread emits it again when a process exits. A background task spawned in
//! `lib::run` listens for those events and calls [`refresh_menu`].
//!
//! Pattern adapted from the galdr app: a single-frameless-window host that
//! lives in the tray, with `decorations: false` + custom titlebar.

use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem, MenuEvent, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::commands::{self, RunningServerInfo};
use crate::config;
use crate::metrics::MetricsState;
use crate::process;
use crate::window_state;

/// Menu item id prefix for the per-server entries. The instance id follows:
/// `show:<server-id>`.
const SHOW_PREFIX: &str = "show:";

/// Menu item id prefix for quick-stop entries: `stop:<server-id>`.
const STOP_PREFIX: &str = "stop:";
const STOP_ALL_ID: &str = "stop-all";

/// Menu item ids for the fixed entries.
const TOGGLE_WINDOW_ID: &str = "toggle-window";
const QUIT_ID: &str = "quit";

/// Builds and installs the tray icon + menu. Call once from `setup`. The menu
/// is rebuilt immediately (and again whenever the running set changes).
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, TOGGLE_WINDOW_ID, "Show kern", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit kern", true, None::<&str>)?;

    // The menu is rebuilt wholesale by refresh_menu whenever the running set
    // changes; the initial build just needs a valid structure to attach.
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("app icon missing"))
        .tooltip("kern")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event)
        .build(app)?;

    // First population of the live server list + tooltip.
    refresh_menu(app);

    Ok(())
}

/// Handles a tray menu click by dispatching on the item id.
fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == TOGGLE_WINDOW_ID {
        toggle_window(app);
    } else if id == QUIT_ID {
        quit(app);
    } else if id == STOP_ALL_ID {
        let handle = app.clone();
        std::thread::spawn(move || {
            let registry: tauri::State<'_, process::ProcessRegistry> = handle.state();
            for server_id in registry.running_ids() {
                let _ = commands::stop_instance_blocking(&handle, &server_id);
            }
        });
    } else if let Some(server_id) = id.strip_prefix(STOP_PREFIX) {
        let handle = app.clone();
        let server_id = server_id.to_string();
        std::thread::spawn(move || {
            let _ = commands::stop_instance_blocking(&handle, &server_id);
        });
    } else if let Some(server_id) = id.strip_prefix(SHOW_PREFIX) {
        focus_server(app, server_id);
    }
}

/// Left-click on the tray icon toggles the window visibility, matching the
/// classic tray-app affordance. Other buttons are ignored (right-click opens
/// the menu natively).
fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_window(tray.app_handle());
    }
}

/// Shows or hides the main window, persisting the new visibility so the next
/// manual launch restores it.
fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
            window_state::set_hidden(app, true);
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            window_state::set_hidden(app, false);
        }
        // Keep the menu label in sync ("Show kern" vs "Hide kern").
        refresh_menu(app);
    }
}

/// Shows the window and asks the frontend to navigate to the given server's
/// detail view. Emitted as `kern://focus-server` (mirroring the existing
/// `kern://open-install` deep-link channel the frontend already listens for).
fn focus_server(app: &AppHandle, server_id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        window_state::set_hidden(app, false);
    }
    let _ = app.emit("kern://focus-server", server_id);
}

/// Rebuilds the tray menu from the current running set + window visibility,
/// and updates the tooltip to show the active count.
pub fn refresh_menu(app: &AppHandle) {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return,
    };

    let running = list_running(app);
    let count = running.len();

    // Aggregate telemetry + alert state for the tooltip / icon.
    let mut cpu_sum = 0.0f32;
    let mut ram_sum = 0.0f32;
    let mut sampled = 0u32;
    {
        let metrics_state: tauri::State<'_, MetricsState> = app.state();
        for info in &running {
            if let Some(m) = metrics_state.instance_metrics(info.pid, "running") {
                cpu_sum += m.cpu;
                ram_sum += m.ram;
                sampled += 1;
            }
        }
    }
    let has_error = config::load_config(app)
        .map(|cfg| {
            cfg.servers.values().any(|s| {
                s.status == "error" || s.status == "stopped-forced"
            })
        })
        .unwrap_or(false);

    let header = if count == 0 {
        "kern".to_string()
    } else {
        format!("kern · {count} running")
    };
    let header = if has_error { format!("⚠ {header}") } else { header };

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    if let Ok(h) = MenuItem::with_id(app, "__header", header, false, None::<&str>) {
        items.push(Box::new(h));
    }
    if let Ok(sep) = PredefinedMenuItem::separator(app) {
        items.push(Box::new(sep));
    }

    if running.is_empty() {
        if let Ok(empty) =
            MenuItem::with_id(app, "__none", "No active servers", false, None::<&str>)
        {
            items.push(Box::new(empty));
        }
    } else {
        for info in &running {
            // Reuse the id each rebuild is fine — duplicate ids across rebuilds
            // don't conflict because the whole menu is replaced.
            let label = format!("{}  {}", bullet(), info.name);
            if let Ok(item) =
                MenuItem::with_id(app, format!("{SHOW_PREFIX}{}", info.id), label, true, None::<&str>)
            {
                items.push(Box::new(item));
            }
        }

        // Quick controls submenu: per-server stop + stop-all.
        let mut quick: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
        for info in &running {
            if let Ok(item) = MenuItem::with_id(
                app,
                format!("{STOP_PREFIX}{}", info.id),
                format!("■ stop {}", info.name),
                true,
                None::<&str>,
            ) {
                quick.push(Box::new(item));
            }
        }
        if let Ok(stop_all) = MenuItem::with_id(app, STOP_ALL_ID, "■ stop all servers", true, None::<&str>) {
            quick.push(Box::new(stop_all));
        }
        let quick_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
            quick.iter().map(|b| b.as_ref()).collect();
        if let Ok(submenu) = Submenu::with_items(app, "Quick controls", true, &quick_refs) {
            items.push(Box::new(submenu));
        }
    }

    if let Ok(sep) = PredefinedMenuItem::separator(app) {
        items.push(Box::new(sep));
    }

    let window_visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let toggle_label = if window_visible { "Hide kern" } else { "Show kern" };
    if let Ok(toggle) = MenuItem::with_id(app, TOGGLE_WINDOW_ID, toggle_label, true, None::<&str>) {
        items.push(Box::new(toggle));
    }
    if let Ok(quit) = MenuItem::with_id(app, QUIT_ID, "Quit kern", true, None::<&str>) {
        items.push(Box::new(quit));
    }

    // Build the new menu from the boxed items. The ref slice is what
    // Menu::with_items expects.
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|b| b.as_ref()).collect();
    if let Ok(menu) = Menu::with_items(app, &refs) {
        let _ = tray.set_menu(Some(menu));
    }

    // Tooltip: running count + aggregate CPU/RAM + alert marker.
    let mut tooltip = if count == 0 {
        "kern · idle".to_string()
    } else {
        format!("kern · {count} running")
    };
    if sampled > 0 {
        tooltip.push_str(&format!(
            " · cpu {:.0}% · ram {:.0}%",
            cpu_sum * 100.0,
            (ram_sum / sampled as f32) * 100.0
        ));
    }
    if has_error {
        tooltip = format!("⚠ {tooltip}");
    }
    let _ = tray.set_tooltip(Some(tooltip));

    // Dynamic icon state: alert > running > idle. While the live radar is
    // animating it owns the icon — don't stomp its current frame.
    if !crate::tray_radar::is_animating(app) {
        let state = if has_error {
            TrayState::Alert
        } else if count > 0 {
            TrayState::Running
        } else {
            TrayState::Idle
        };
        set_state_icon(&tray, state);
    }
}

/// Tray icon tint states.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TrayState {
    Idle,
    Running,
    Alert,
}

/// Overlays a state-colored dot on the app icon and applies it to the tray.
/// The base icon is decoded from the bundled PNG (tiny; cheap enough per menu
/// refresh).
fn set_state_icon(tray: &tauri::tray::TrayIcon, state: TrayState) {
    const BASE_ICON: &[u8] = include_bytes!("../icons/32x32.png");
    let Ok(base) = tauri::image::Image::from_bytes(BASE_ICON) else {
        return;
    };
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();

    let color: [u8; 3] = match state {
        TrayState::Idle => [76, 82, 94],      // gray
        TrayState::Running => [76, 245, 160], // signal green
        TrayState::Alert => [245, 76, 76],    // fault red
    };

    // Bottom-right dot: ~1/3 of the icon, with a 1px inset.
    let radius = (width.min(height) / 6).max(3) as i32;
    let cx = width as i32 - radius - 2;
    let cy = height as i32 - radius - 2;
    for y in (cy - radius).max(0)..(cy + radius).min(height as i32) {
        for x in (cx - radius).max(0)..(cx + radius).min(width as i32) {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= radius * radius {
                let idx = ((y as u32 * width + x as u32) * 4) as usize;
                if idx + 3 < rgba.len() {
                    rgba[idx] = color[0];
                    rgba[idx + 1] = color[1];
                    rgba[idx + 2] = color[2];
                    rgba[idx + 3] = 255;
                }
            }
        }
    }

    let icon = tauri::image::Image::new_owned(rgba, width, height);
    let _ = tray.set_icon(Some(icon));
}

/// Joins the live process table with the registry to resolve names, in the
/// same shape the `list_running_servers` command exposes. Local helper so the
/// tray doesn't need to round-trip through a command.
fn list_running(app: &AppHandle) -> Vec<RunningServerInfo> {
    let registry: tauri::State<'_, process::ProcessRegistry> = app.state();
    let ids = registry.running_ids();
    let cfg = match config::load_config(app) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    ids.into_iter()
        .map(|id| {
            let name = cfg
                .servers
                .get(&id)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| id.clone());
            let pid = registry.pid_for(&id).unwrap_or(0);
            let adopted = registry.is_adopted(&id);
            RunningServerInfo { id, name, pid, adopted }
        })
        .collect()
}

/// Status dot prefix for a running server. Kept a single glyph (no per-state
/// color) to stay legible at tray-menu scale.
fn bullet() -> &'static str {
    "●"
}

/// Real exit path — detach every running server, then quit. Unlike the Stop
/// button (which sends a graceful "stop" command to let Minecraft save its
/// world), quitting kern simply closes the pipe handles and exits, leaving
/// the server processes running. They may get ERROR_BROKEN_PIPE on their
/// next stdout/stderr write but otherwise continue unaffected.
pub fn quit(app: &AppHandle) {
    // Capture window geometry first (this path bypasses CloseRequested, where
    // geometry is normally saved) so the next launch reopens in the same spot.
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(state) = window_state::capture(&window) {
            let _ = window_state::save(app, &state);
        }
    }
    // Detach all running processes: close stdin and drop the child handles
    // without killing, so servers outlive the app. The `generations` map is
    // also cleared to break the registry's link to these processes.
    let registry: tauri::State<'_, process::ProcessRegistry> = app.state();
    registry.detach_all();
    // The cloudflare tunnel must not outlive the app, unlike servers.
    crate::tunnel::shutdown(app);
    app.exit(0);
}
