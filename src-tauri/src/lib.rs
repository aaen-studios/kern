// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod audit;
mod automation;
mod automation_api;
mod commands;
mod config;
mod crash;
mod disk;
mod download;
mod java;
mod logwatch;
mod manifest;
mod metrics;
mod paths;
mod plugin_kv;
mod plugin_secrets;
mod process;
mod rcon;
mod registry;
mod scheduler;
mod scaffold;
mod seed;
mod snapshots;
mod sync;
mod tray;
mod tray_radar;
mod tunnel;
mod ui_state;
mod watcher;
mod watchdog;
mod web_remote;
mod webhook;
mod window_state;

use tauri::{Emitter, Listener, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;

/// Deep-link target that arrived on this process's own launch argv (cold start:
/// the app wasn't running yet, so the single-instance callback never fires).
/// The frontend drains it via `take_pending_deep_link` once its listener is
/// attached; warm starts deliver through the `kern://open-install` event.
#[derive(Default)]
pub struct PendingDeepLink(pub std::sync::Mutex<Option<String>>);

/// Whether the frontend has finished mounting and attached its event
/// listeners. The single-instance callback uses it to decide whether a warm
/// `kern://open-install` emit would be heard or must also be stashed.
#[derive(Default)]
pub struct FrontendReady(pub std::sync::atomic::AtomicBool);

/// Marks the frontend as mounted and consumes the `.kern` target that launched
/// this process, if any. Called once from the frontend's mount effect.
#[tauri::command]
fn take_pending_deep_link(
    state: tauri::State<'_, PendingDeepLink>,
    ready: tauri::State<'_, FrontendReady>,
) -> Option<String> {
    ready.0.store(true, std::sync::atomic::Ordering::SeqCst);
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be registered FIRST and only on desktop. On a second
    // launch attempt the callback shows + focuses the existing main window
    // instead of starting a duplicate app.
    //
    // Debug-only escape hatch: the E2E stop harness (`scripts/e2e-stop.mjs`)
    // runs an isolated instance (temporary APPDATA) alongside the developer's
    // real app, so it must skip the single-instance forwarding. (macOS doesn't
    // register single-instance at all, so neither the flag nor the block
    // exists there.)
    #[cfg(not(target_os = "macos"))]
    let e2e_isolated = cfg!(debug_assertions)
        && std::env::var("KERN_E2E_ISOLATED")
            .map(|v| v == "1")
            .unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    if !e2e_isolated {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            // A second launch (double-clicked .kern / kern:// link) delivers the
            // target through argv — forward it to the running instance. If the
            // webview hasn't mounted yet the emit would be lost, so stash it
            // for the frontend's mount-time drain as well.
            if let Some(target) = argv.iter().find_map(|a| resolve_kern_target(a)) {
                let ready = app
                    .state::<FrontendReady>()
                    .0
                    .load(std::sync::atomic::Ordering::SeqCst);
                if !ready {
                    if let Ok(mut pending) = app.state::<PendingDeepLink>().0.lock() {
                        *pending = Some(target.clone());
                    }
                }
                let _ = app.emit("kern://open-install", target);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        // OS-login autostart. The `--autostart` arg lets setup distinguish an
        // OS-launched start (which may stay hidden in tray) from a manual one.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(process::ProcessRegistry::default())
        .manage(metrics::MetricsState::default())
        .manage(metrics::MetricsHistory::default())
        .manage(watcher::WatcherState::default())
        .manage(watchdog::WatchdogState::default())
        .manage(web_remote::WebRemoteState::default())
        .manage(PendingDeepLink::default())
        .manage(FrontendReady::default())
        .manage(logwatch::LogAlertState::default())
        .manage(automation::AutomationState::default())
        .manage(tray_radar::RadarControl::default())
        .manage(tunnel::TunnelState::default())
        .setup(|app| {
            let handle = app.handle().clone();

            // Seed sample community plugins from the repo into AppData so the
            // manifest engine can discover them during development.
            if let Ok(base) = config::config_dir(&handle) {
                seed::seed(&manifest::plugins_dir(&base));
            }

            // Cold-start deep link: a double-clicked `.kern` / `kern://` link
            // launches us with the target in our own argv. Stash it so the
            // frontend can drain it on mount (the single-instance callback
            // covers warm starts only).
            let cold_start_target = std::env::args().skip(1).find_map(|a| resolve_kern_target(&a));
            if let Some(target) = &cold_start_target {
                if let Ok(mut pending) = app.state::<PendingDeepLink>().0.lock() {
                    *pending = Some(target.clone());
                }
            }

            // ── Deep links (`kern://`) + .kern file association ────────────
            // Forward any incoming URL to the frontend's install dialog. The
            // handler only accepts local `.kern` paths (remote installs go
            // through the marketplace, which verifies checksums).
            #[cfg(debug_assertions)]
            {
                // Register the scheme/file association for dev builds; release
                // installers register it during installation.
                let _ = app.deep_link().register_all();
            }
            let deep_link_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(target) = resolve_kern_target(url.as_str()) {
                        let _ = deep_link_handle.emit("kern://open-install", target);
                    }
                }
            });

            // Decide initial window visibility.
            //   - OS-login auto-launch (`--autostart`): honor the
            //     `start_hidden_in_tray` setting (default: hidden).
            //   - Installer/updater relaunch (`--show`), or a deep-link launch
            //     (`.kern` / `kern://` on the argv): always show, even if the
            //     app was hidden in the tray before — otherwise finishing an
            //     install, or the install dialog for a double-clicked package,
            //     appears to do nothing.
            //   - Manual launch: restore the last remembered visibility from
            //     window.json (so "persist... opened vs tray" holds).
            let autostarted = std::env::args().any(|a| a == "--autostart");
            let force_show = std::env::args().any(|a| a == "--show");
            let settings = config::load_config(&handle).map(|c| c.settings).ok();
            let remember_hidden = window_state::load(&handle).ok().flatten().map(|s| s.hidden);
            let show_window = if force_show || cold_start_target.is_some() {
                true
            } else if autostarted {
                // start_hidden_in_tray defaults to false → show unless opted in.
                settings
                    .as_ref()
                    .map(|s| !s.start_hidden_in_tray)
                    .unwrap_or(true)
            } else {
                // Manual launch: show unless last state was hidden.
                !remember_hidden.unwrap_or(false)
            };

            if let Some(window) = app.get_webview_window("main") {
                // Restore last-saved window geometry before showing.
                if let Ok(Some(state)) = window_state::load(&handle) {
                    window_state::restore(&window, &state);
                }
                if show_window {
                    // Restore before showing: a launcher (installer, updater,
                    // scheduled task) can pass SW_SHOWMINNOACTIVE down the
                    // process chain, which Windows applies to the first
                    // ShowWindow call and would leave kern minimized.
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    if force_show || cold_start_target.is_some() {
                        // Keep the persisted visibility in sync so the next
                        // manual launch stays visible too.
                        window_state::set_hidden(&handle, false);
                    }
                }
            }

            // Install the tray icon + menu, then listen for running-set changes
            // so its "active servers" list + tooltip stay in sync with the
            // process table (process.rs emits on launch + on exit).
            if let Err(e) = tray::setup(&handle) {
                eprintln!("[tray] setup failed: {e}");
            }
            let refresh_handle = handle.clone();
            handle.listen("kern://running-set-changed", move |_event| {
                tray::refresh_menu(&refresh_handle);
            });

            // Live tray radar: repaints the tray icon from the same metrics
            // pipeline (sweep speed follows CPU, one blip per running server).
            tray_radar::spawn(&handle);

            // Auto-start any instances flagged `autoStart`. Non-orphaned only,
            // best-effort per server so one failure doesn't block the rest.
            // Spawned on background threads so a slow start (e.g. a JAR that
            // takes a moment to resolve) can't block setup.
            if let Ok(cfg) = config::load_config(&handle) {
                // ── Reconcile persisted pids against the live process table ──
                // On a previous quit, detach_all left running servers alive in
                // the OS but dropped kern's handles. Each launch persisted its
                // pid; here we sysinfo-probe each and re-adopt live ones as
                // PID-only monitors (liveness + metrics + force-kill; no stdin
                // pipe, so no graceful stop or log streaming for these). Dead
                // pids are cleared so they don't linger.
                let alive_ids = reconcile_adopted(&handle, &cfg);

                // ── Auto-start flagged instances ──
                // Skipped for already-running (owned or re-adopted) instances
                // so we never double-launch into the same port/working dir.
                for server in cfg.servers.values() {
                    if server.auto_start && !server.is_orphaned && !alive_ids.contains(&server.id) {
                        let h = handle.clone();
                        let id = server.id.clone();
                        tauri::async_runtime::spawn(async move {
                            // Tiny delay lets the window/tray finish wiring up
                            // before processes start streaming logs.
                            std::thread::sleep(std::time::Duration::from_millis(200));
                            if let Err(e) = commands::launch_instance(&h, &id) {
                                eprintln!("[autostart] failed to start '{id}': {e}");
                            }
                        });
                    }
                }
            }

            // Spawn the background worker: backup scheduler, health alerts,
            // and metrics-history sampling all run on one 30s loop.
            scheduler::spawn(&handle);

            // Optionally serve the web remote (LAN JSON API) if enabled.
            web_remote::maybe_spawn(&handle);

            // Optionally expose the web remote through a cloudflared quick
            // tunnel (requires the web remote).
            tunnel::maybe_spawn(&handle);

            // Compile log-alert rules and start the loopback automation API.
            logwatch::reload(&handle);
            automation::maybe_spawn(&handle);

            Ok(())
        })
        .on_window_event(|window, event| {
            let handle = window.app_handle().clone();
            match event {
                // Close button: always capture geometry first (so the next
                // launch reopens here), then either hide to tray (when
                // close-to-tray is on, the default) or let the real close
                // proceed.
                WindowEvent::CloseRequested { api, .. } => {
                    if let Some(w) = window.get_webview_window("main") {
                        if let Ok(state) = window_state::capture(&w) {
                            let _ = window_state::save(&handle, &state);
                        }
                    }
                    let close_to_tray = config::load_config(&handle)
                        .map(|c| c.settings.close_to_tray)
                        .unwrap_or(true);
                    if close_to_tray {
                        api.prevent_close();
                        if let Some(w) = window.get_webview_window("main") {
                            let _ = w.hide();
                            window_state::set_hidden(&handle, true);
                        }
                        tray::refresh_menu(&handle);
                    } else {
                        // Real close: detach all child processes first, so a
                        // running server isn't abruptly orphaned with its stdin
                        // closed mid-save (only the tray Quit path did this
                        // before). detach_all leaves the processes running but
                        // cleanly disconnects the registry's handles.
                        let registry: tauri::State<'_, process::ProcessRegistry> =
                            handle.state();
                        registry.detach_all();
                        // The tunnel, unlike servers, must not outlive the app.
                        crate::tunnel::shutdown(&handle);
                    }
                }
                WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    // Dropping a .kern package onto the window opens the
                    // install dialog (documented behaviour).
                    if let Some(path) = paths.iter().find(|p| {
                        p.extension()
                            .and_then(|e| e.to_str())
                            .is_some_and(|e| e.eq_ignore_ascii_case("kern"))
                    }) {
                        let _ = window
                            .app_handle()
                            .emit("kern://open-install", path.to_string_lossy().to_string());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_deep_link,
            audit::get_audit_log,
            audit::export_audit_log,
            tunnel::tunnel_info,
            tunnel::tunnel_download_binary,
            tunnel::tunnel_apply,
            crash::get_last_crash,
            crash::clear_last_crash,
            automation::automation_info,
            scheduler::run_task_now,
            commands::preflight_launch,
            commands::inspect_server_folder,
            commands::get_config,
            commands::get_servers,
            commands::create_server,
            commands::update_server,
            commands::delete_server,
            commands::delete_server_folder,
            commands::refresh_orphaned_status,
            commands::is_server_running,
            commands::launch_server_instance,
            commands::stop_server_instance,
            commands::update_server_status,
            commands::update_app_settings,
            commands::enable_autostart,
            commands::disable_autostart,
            commands::is_autostart_enabled,
            commands::list_running_servers,
            commands::get_instance_metrics,
            commands::get_host_metrics,
            commands::run_lifecycle_step,
            commands::install_server_instance,
            commands::restart_server_instance,
            commands::get_log_tail,
            commands::open_folder,
            commands::write_stdin_to_instance,
            commands::read_env_file,
            commands::server_file_exists,
            commands::write_server_file,
            commands::read_server_file,
            commands::list_server_directory,
            commands::delete_server_path,
            commands::create_server_directory,
            commands::rename_server_path,
            commands::delete_server_path_recursive,
            commands::open_server_path,
            commands::copy_files_to_server,
            commands::list_plugins,
            commands::get_plugin,
            commands::get_plugin_ui_path,
            commands::install_plugin,
            commands::install_plugin_from_kern,
            commands::validate_kern_file,
            commands::create_plugin_package,
            commands::uninstall_plugin,
            commands::run_instance_command,
            commands::search_files,
            commands::get_file_from_backup,
            commands::read_file_bytes,
            download::download_url,
            download::fetch_mc_versions,
            download::resolve_forge_version,
            commands::backup_world,
            commands::list_backups,
            commands::restore_world,
            commands::delete_backup,
            commands::detect_server_jar,
            commands::run_terminal_command,
            commands::update_backup_schedule,
            commands::update_alert_rules,
            commands::update_server_tasks,
            commands::get_metrics_history,
            commands::get_instance_energy,
            commands::update_command_snippets,
            commands::get_instance_ports,
            commands::find_replace_in_files,
            registry::registry_list_plugins,
            registry::registry_get_plugin,
            registry::registry_install_plugin,
            sync::sync_export,
            sync::sync_import,
            watcher::watch_server_directory,
            watcher::unwatch_server_directory,
            java::detect_java,
            java::check_java_version,
            java::download_java,
            ui_state::get_ui_state,
            ui_state::set_ui_state,
            plugin_kv::plugin_kv_get,
            plugin_kv::plugin_kv_set,
            plugin_kv::plugin_kv_delete,
            plugin_kv::plugin_kv_list,
            plugin_secrets::plugin_secret_get,
            plugin_secrets::plugin_secret_set,
            plugin_secrets::plugin_secret_delete,
            snapshots::snapshot_file,
            snapshots::list_file_snapshots,
            snapshots::read_file_snapshot,
            snapshots::restore_file_snapshot,
            snapshots::delete_file_snapshot,
            rcon::rcon_get_status,
            rcon::rcon_set_config,
            rcon::rcon_test,
            rcon::rcon_execute,
            rcon::rcon_players,
            web_remote::web_remote_info,
            web_remote::web_remote_regenerate_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Resolves a launch argument or deep-link URL to a local `.kern` path.
///
/// Accepts a bare filesystem path (`C:\...\foo.kern`) or a
/// `kern://install?path=<encoded>` URL. Remote (`https://…`) targets are
/// ignored — those must go through the marketplace so checksums are verified.
fn resolve_kern_target(arg: &str) -> Option<String> {
    let is_kern_path = |s: &str| {
        std::path::Path::new(s)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("kern"))
    };

    if let Some(rest) = arg.strip_prefix("kern://") {
        let query = rest.split_once('?')?.1;
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            if key == "path" || key == "file" {
                let decoded = percent_decode(value);
                if is_kern_path(&decoded) {
                    return Some(decoded);
                }
            }
        }
        return None;
    }

    if is_kern_path(arg) {
        Some(arg.to_string())
    } else {
        None
    }
}

/// Minimal percent-decoder for deep-link query values.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(decoded) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(decoded);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Probes each instance's persisted `pid` against the live OS process table and/// re-adopts still-running ones as PID-only monitors. Returns the set of ids
/// that are now running (owned or adopted) so the auto-start loop can skip them.
///
/// Dead pids are cleared from config so they don't linger. This runs once at
/// startup, before auto-start, so a server still alive from a previous session
/// is recognized rather than double-launched.
fn reconcile_adopted(
    handle: &tauri::AppHandle,
    cfg: &config::AppConfig,
) -> Vec<String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let registry: tauri::State<'_, process::ProcessRegistry> = handle.state();

    // Collect candidate (id, pid, recorded start time) triples from config.
    let candidates: Vec<(String, u32, Option<u64>)> = cfg
        .servers
        .iter()
        .filter_map(|(id, s)| s.pid.map(|p| (id.clone(), p, s.pid_started)))
        .collect();

    if candidates.is_empty() {
        return registry.running_ids();
    }

    let pids: Vec<Pid> = candidates.iter().map(|(_, p, _)| Pid::from_u32(*p)).collect();
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&pids), true);

    let mut stale: Vec<String> = Vec::new();
    let mut legacy: Vec<(String, u64)> = Vec::new();
    for (id, pid, started) in candidates {
        let process = sys.process(Pid::from_u32(pid));
        match (process, started) {
            // Fully verified: same pid AND same OS start time.
            (Some(p), Some(expected)) if p.start_time() == expected => {
                registry.adopt(handle, &id, pid);
            }
            // Legacy entry: a pid was persisted before start times were
            // recorded. Adopting it preserves the "keep servers across
            // restarts" guarantee; record the observed start time so every
            // future restart is fully verified.
            (Some(p), None) => {
                eprintln!(
                    "[reconcile] adopting legacy pid {pid} for '{id}' without a recorded start time"
                );
                registry.adopt(handle, &id, pid);
                legacy.push((id, p.start_time()));
            }
            // Dead pid, or a recycled pid with a different start time.
            _ => stale.push(id),
        }
    }

    // Persist observed start times for legacy adoptions so identity is
    // verifiable from now on. (Not a "stale" write: the pid stays.)
    if !legacy.is_empty() {
        let clear_handle = handle.clone();
        let _ = config::with_config_mut(&clear_handle, |c| {
            for (id, started) in &legacy {
                if let Some(instance) = c.servers.get_mut(id) {
                    instance.pid_started = Some(*started);
                }
            }
            Ok(())
        });
    }

    // Clear only the stale entries. Adopted processes keep their pid +
    // start time so a subsequent restart can verify them again (clearing the
    // pid here was why re-adoption only ever worked once).
    if !stale.is_empty() {
        let clear_handle = handle.clone();
        let _ = config::with_config_mut(&clear_handle, |c| {
            for id in &stale {
                if let Some(instance) = c.servers.get_mut(id) {
                    instance.pid = None;
                    instance.pid_started = None;
                }
            }
            Ok(())
        });
    }

    // Owned processes (if any launched earlier in setup) + adopted ones.
    registry.running_ids()
}

#[cfg(test)]
mod deeplink_tests {
    use super::{percent_decode, resolve_kern_target};

    #[test]
    fn percent_decodes_encoded_values() {
        assert_eq!(percent_decode("%2Ftmp%2Ffoo.kern"), "/tmp/foo.kern");
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("no-encoding"), "no-encoding");
        assert_eq!(percent_decode("trailing%"), "trailing%");
    }

    #[test]
    fn resolves_plain_kern_path() {
        assert_eq!(
            resolve_kern_target("/tmp/foo.kern"),
            Some("/tmp/foo.kern".to_string())
        );
        assert_eq!(resolve_kern_target("/tmp/foo.txt"), None);
        assert_eq!(resolve_kern_target("--autostart"), None);
    }

    #[test]
    fn resolves_deep_link_path_query() {
        assert_eq!(
            resolve_kern_target("kern://install?path=%2Ftmp%2Ffoo.kern"),
            Some("/tmp/foo.kern".to_string())
        );
        assert_eq!(resolve_kern_target("kern://install?id=foo"), None);
    }

    #[test]
    fn ignores_remote_urls() {
        assert_eq!(
            resolve_kern_target("kern://install?url=https%3A%2F%2Fexample.com%2Fx.kern"),
            None
        );
    }
}
