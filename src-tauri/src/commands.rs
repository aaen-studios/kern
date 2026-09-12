//! Tauri commands exposing the server registry CRUD + process lifecycle.
//!
//! Spec: documentation/ArchitecturePlan.md §2 (Phase 1 — standard CRUD
//! operations via Rust file commands, plus orphaned-state handling) and
//! §5 (Phase 2 — variable process lifecycle execution + log streaming).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::config::{self, AppConfig, AppSettings, ServerInstance};
use crate::manifest;
use crate::metrics::{InstanceMetrics, MetricSample, MetricsHistory, MetricsState};
use crate::paths;
use crate::process;
use crate::scaffold;

/// Returns the full config document, with `is_orphaned` refreshed on read.
#[tauri::command]
pub fn get_config(app_handle: AppHandle) -> Result<AppConfig, String> {
    config::load_config(&app_handle)
}

/// Returns just the tracked server instances as a list.
#[tauri::command]
pub fn get_servers(app_handle: AppHandle) -> Result<Vec<ServerInstance>, String> {
    let cfg = config::load_config(&app_handle)?;
    Ok(cfg.servers.into_values().collect())
}

/// Input accepted by `create_server`. Fields the host owns (`id`, `status`,
/// `is_orphaned`) are filled in server-side.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewServerInput {
    pub name: String,
    pub server_type: String,
    pub path: String,
    #[serde(default)]
    pub user_overrides: HashMap<String, String>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// True when adopting an existing folder (import wizard): skip plugin
    /// scaffolding so nothing is added to a folder the user already populated.
    #[serde(default)]
    pub imported: bool,
}

/// Creates a new server instance and returns the persisted record (with its
/// generated id and resolved orphaned status).
///
/// After persisting, the plugin's `scaffold` files are written into the
/// instance directory — so the path exists immediately and the instance isn't
/// orphaned on first load. Scaffolding is best-effort and never blocks creation.
#[tauri::command]
pub fn create_server(
    app_handle: AppHandle,
    input: NewServerInput,
) -> Result<ServerInstance, String> {
    let mut cfg = config::load_config(&app_handle)?;

    let instance = ServerInstance {
        id: config::generate_unique_id(&cfg.servers),
        name: input.name,
        server_type: input.server_type,
        path: input.path.clone(),
        status: "stopped".to_string(),
        is_orphaned: false,
        user_overrides: input.user_overrides.clone(),
        auto_start: input.auto_start,
        pid: None,
        pid_started: None,
        stop_command: None,
        stop_timeout_secs: config::default_stop_timeout_secs(),
        features: HashMap::new(),
        watchdog: config::WatchdogConfig::default(),
        tasks: Vec::new(),
        group: input.group.filter(|g| !g.trim().is_empty()),
        tags: input
            .tags
            .into_iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect(),
        rcon: config::RconConfig::default(),
        backup_schedule: config::BackupSchedule::default(),
        alert_rules: config::AlertRules::default(),
        command_history: Vec::new(),
        command_snippets: Vec::new(),
        last_ports: Vec::new(),
    };

    cfg.servers.insert(instance.id.clone(), instance.clone());
    config::save_config(&app_handle, &cfg)?;
    crate::audit::record(
        &app_handle,
        "create",
        &format!("created server '{}' ({})", instance.name, instance.server_type),
        Some(&instance.id),
    );

    // Scaffold starter files from the plugin manifest (if installed + declared).
    // Best-effort: a missing/unknown plugin just leaves the folder empty.
    // Skipped for imported folders — adopting an existing server must not add
    // files to a directory the user already populated.
    if !input.imported {
        if let Ok(manifest_path) = manifest_path_for(&app_handle, &instance.server_type) {
            if manifest_path.exists() {
                if let Ok(manifest) = manifest::load(&manifest_path) {
                    scaffold::write(
                        std::path::Path::new(&instance.path),
                        &manifest,
                        &instance.user_overrides,
                    );
                }
            }
        }
    }

    // Materialize the instance's overrides into a .env file so the launched
    // process has them available. Each override becomes a KEY=value line.
    // Best-effort, never blocks creation. Skipped entirely when there are no
    // overrides — no point writing an empty file. Also skipped when a .env
    // already exists, so a pre-populated folder is never clobbered.
    if !input.imported && !instance.user_overrides.is_empty() {
        let env_path = std::path::Path::new(&instance.path).join(".env");
        if !env_path.exists() {
            let content: String = instance
                .user_overrides
                .iter()
                .map(|(k, v)| format!("{k}={v}\n"))
                .collect();
            let _ = std::fs::write(&env_path, content);
        }
    }

    Ok(instance)
}

/// Updates an existing instance by id. Returns an error if the id is unknown.
///
/// Host-owned fields (`status`, `pid`, `pid_started`, `is_orphaned`, scheduler
/// timers) are preserved: the frontend's copy can be stale and a round-trip
/// must not clobber a status write or a backup timer that happened since.
#[tauri::command]
pub fn update_server(
    app_handle: AppHandle,
    server: ServerInstance,
) -> Result<ServerInstance, String> {
    let mut updated: Option<ServerInstance> = None;
    config::with_config_mut(&app_handle, |cfg| {
        let entry = cfg
            .servers
            .get_mut(&server.id)
            .ok_or_else(|| format!("server '{}' not found", server.id))?;
        entry.name = server.name;
        entry.server_type = server.server_type;
        entry.path = server.path;
        entry.user_overrides = server.user_overrides;
        entry.auto_start = server.auto_start;
        entry.stop_command = server.stop_command;
        entry.stop_timeout_secs = server.stop_timeout_secs;
        entry.features = server.features;
        entry.watchdog = server.watchdog;
        entry.group = server.group.filter(|g| !g.trim().is_empty());
        entry.tags = server
            .tags
            .into_iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        // Preserve host-managed last-run stamps across a UI round-trip.
        let last_runs: HashMap<String, u64> = entry
            .tasks
            .iter()
            .map(|t| (t.id.clone(), t.last_run_secs))
            .collect();
        entry.tasks = server
            .tasks
            .into_iter()
            .map(|mut t| {
                if let Some(prev) = last_runs.get(&t.id) {
                    t.last_run_secs = *prev;
                }
                t
            })
            .collect();
        updated = Some(entry.clone());
        Ok(())
    })?;
    updated.ok_or_else(|| format!("server '{}' not found", server.id))
}

/// Deletes an instance by id. Missing ids are treated as already-deleted (Ok).
///
/// A running process is stopped first — removing the record while the server
/// runs would leave an untracked, unstoppable child holding its port.
#[tauri::command]
pub async fn delete_server(app_handle: AppHandle, id: String) -> Result<(), String> {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let name = audit_name(&handle, &id);
        if process::is_running(&handle, &id) || process::is_task_running(&handle, &id) {
            stop_instance_internal(&handle, &id, false)?;
        }
        config::with_config_mut(&handle, |cfg| {
            cfg.servers.remove(&id);
            Ok(())
        })?;
        crate::audit::record(
            &handle,
            "delete",
            &format!("deleted server '{name}'"),
            Some(&id),
        );
        // Drop the filesystem watch so a deleted instance doesn't leak a
        // watcher on its old directory.
        crate::watcher::unwatch_instance(&handle, &id);
        // Drop the RCON credential too.
        crate::rcon::clear_password(&id);
        // Drop accumulated metrics history for the deleted instance.
        let history: tauri::State<'_, MetricsHistory> = handle.state();
        history.forget(&id);
        Ok(())
    })
    .await
    .map_err(|e| format!("delete task failed: {e}"))?
}

/// Deletes an instance's working directory from disk. Best-effort — missing
/// directories are treated as already gone (Ok). Used alongside `delete_server`
/// when the user opts to also remove the folder.
#[tauri::command]
pub fn delete_server_folder(app_handle: AppHandle, id: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    // Never delete a directory out from under a live process: files would fail
    // mid-write and the server would keep running from an unlinked tree.
    if process::is_running(&app_handle, &id) || process::is_task_running(&app_handle, &id) {
        return Err(format!(
            "cannot delete the working directory for '{id}' while it is running — stop it first"
        ));
    }
    let path = std::path::Path::new(&instance.path);
    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("failed to remove '{}': {e}", path.display()))?;
    }
    Ok(())
}

/// Opens a path in the system's default file manager, showing its contents.
/// Uses the `open` crate which handles platform differences (Explorer on
/// Windows, Finder on macOS, xdg-open on Linux).
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    open::that(p).map_err(|e| format!("failed to open '{}': {e}", path))
}

/// Re-checks every instance's path on disk and returns the refreshed list.
#[tauri::command]
pub fn refresh_orphaned_status(
    app_handle: AppHandle,
) -> Result<Vec<ServerInstance>, String> {
    let mut cfg = config::load_config(&app_handle)?;
    config::refresh_orphaned(&mut cfg);
    config::save_config(&app_handle, &cfg)?;
    Ok(cfg.servers.into_values().collect())
}

/// Returns true if the instance currently has a running child process.
#[tauri::command]
pub fn is_server_running(app_handle: AppHandle, id: String) -> bool {
    process::is_running(&app_handle, &id)
}

/// Lightweight status update — changes just the persisted status for an
/// instance without touching any other field. Used by the frontend to sync
/// persisted state when a process exits or errors.
#[tauri::command]
pub fn update_server_status(app_handle: AppHandle, id: String, status: String) -> Result<(), String> {
    config::with_config_mut(&app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(&id) {
            instance.status = status;
        }
        Ok(())
    })
}

/// Replaces the persisted global app settings (launch-on-login, close-to-tray,
/// start-hidden-in-tray). The frontend `useSettings` hook is the only caller.
#[tauri::command]
pub fn update_app_settings(
    app_handle: AppHandle,
    settings: AppSettings,
) -> Result<(), String> {
    config::with_config_mut(&app_handle, |cfg| {
        cfg.settings = settings;
        Ok(())
    })?;
    // Log-alert rules are compiled from settings — recompile immediately so a
    // save takes effect without an app restart.
    crate::logwatch::reload(&app_handle);
    crate::audit::record(&app_handle, "settings", "updated app settings", None);
    Ok(())
}

/// Registers kern as an OS-login launch item (Windows Run key / Linux
/// autostart / macOS Login Item via LaunchAgent). The persisted
/// `launch_on_login` flag is kept in sync so the UI reflects the intent.
#[tauri::command]
pub fn enable_autostart(app_handle: AppHandle) -> Result<(), String> {
    app_handle
        .autolaunch()
        .enable()
        .map_err(|e| format!("failed to enable autostart: {e}"))?;
    config::with_config_mut(&app_handle, |cfg| {
        cfg.settings.launch_on_login = true;
        Ok(())
    })
}

/// Removes the OS-login launch item. The persisted flag is cleared even if the
/// OS entry was already gone, so the UI never shows a stale "enabled" state.
#[tauri::command]
pub fn disable_autostart(app_handle: AppHandle) -> Result<(), String> {
    app_handle
        .autolaunch()
        .disable()
        .map_err(|e| format!("failed to disable autostart: {e}"))?;
    config::with_config_mut(&app_handle, |cfg| {
        cfg.settings.launch_on_login = false;
        Ok(())
    })
}

/// Reports whether the OS-login launch item is currently registered. Reads the
/// autostart manager directly (not just the persisted flag) so external changes
/// (e.g. the user disabling it via Task Manager) are reflected.
#[tauri::command]
pub fn is_autostart_enabled(app_handle: AppHandle) -> bool {
    app_handle.autolaunch().is_enabled().unwrap_or(false)
}

/// One entry in the list of currently-running instances. Joins the live
/// process table (id + pid) with the registry (name) for display in the tray
/// menu and elsewhere.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningServerInfo {
    pub id: String,
    pub name: String,
    pub pid: u32,
    /// True if this is a re-adopted PID-only monitor (no Child handle, so no
    /// graceful stop or live log streaming). The UI surfaces this distinctly.
    pub adopted: bool,
}

/// Lists every currently-running instance (id, name, pid, adopted). Names are
/// resolved from the persisted registry; an id with no matching registry entry
/// (e.g. deleted while running) falls back to the id.
#[tauri::command]
pub fn list_running_servers(app_handle: AppHandle) -> Result<Vec<RunningServerInfo>, String> {
    let registry: tauri::State<'_, process::ProcessRegistry> = app_handle.state();
    let ids = registry.running_ids();
    let cfg = config::load_config(&app_handle)?;
    let infos = ids
        .into_iter()
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
        .collect();
    Ok(infos)
}

/// Returns live CPU/RAM telemetry for a running instance, driven by the
/// instance's process tree. When the instance isn't running (no tracked PID),
/// returns a zeroed reading tagged with its persisted/orphaned status so the
/// radar idles cleanly instead of showing stale load.
#[tauri::command]
pub fn get_instance_metrics(
    app_handle: AppHandle,
    id: String,
) -> Result<InstanceMetrics, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let status = if instance.is_orphaned {
        "orphaned"
    } else {
        instance.status.as_str()
    };

    // Only sample live load when a process is actually tracked. An "error" or
    // transient status with no live process still falls through to the idle
    // reading below, which is the right thing to show.
    if let Some(pid) = process::pid_for(&app_handle, &id) {
        let state: tauri::State<'_, MetricsState> = app_handle.state();
        if let Some(m) = state.instance_metrics(pid, status) {
            return Ok(m);
        }
    }

    Ok(InstanceMetrics {
        cpu: 0.0,
        ram: 0.0,
        status: status.to_string(),
    })
}

/// Returns host-wide CPU/RAM telemetry, used by the empty-state radar so the
/// dashboard pulses with the real machine load even when no instances exist.
#[tauri::command]
pub fn get_host_metrics(app_handle: AppHandle) -> Result<InstanceMetrics, String> {
    let state: tauri::State<'_, MetricsState> = app_handle.state();
    Ok(state.host_metrics())
}

/// A listening TCP port attributed to an instance's process tree.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub port: u16,
    /// Suggested quick-connect string, e.g. "localhost:25565".
    pub connect: String,
}

/// Returns the TCP listening ports owned by an instance's process tree.
///
/// Builds the descendant-PID set via sysinfo's parent pointers, then matches
/// them against the OS socket table via `netstat` (Windows) / `ss` (Linux) /
/// `lsof` (macOS) — sysinfo 0.32 doesn't expose listening sockets directly.
/// Used by the port viewer / quick-connect feature so the user can copy a
/// join link without reading logs.
#[tauri::command]
pub async fn get_instance_ports(app_handle: AppHandle, id: String) -> Result<Vec<ListeningPort>, String> {
    tauri::async_runtime::spawn_blocking(move || get_instance_ports_blocking(app_handle, id))
        .await
        .map_err(|e| format!("ports task failed: {e}"))?
}

fn get_instance_ports_blocking(app_handle: AppHandle, id: String) -> Result<Vec<ListeningPort>, String> {
    let Some(root_pid) = process::pid_for(&app_handle, &id) else {
        return Ok(Vec::new());
    };
    let tree = instance_tree_pids(&app_handle, root_pid);

    // Query the OS socket table and keep listening TCP ports whose owning PID
    // is in the instance's process tree.
    let listening_lines = query_listening_sockets();
    let mut ports: std::collections::BTreeSet<u16> = std::collections::BTreeSet::new();
    for (pid, port) in listening_lines {
        if tree.contains(&pid) {
            ports.insert(port);
        }
    }

    let result: Vec<ListeningPort> = ports
        .into_iter()
        .map(|p| ListeningPort {
            port: p,
            connect: format!("localhost:{p}"),
        })
        .collect();

    // Remember them for the next pre-start conflict check (best-effort: a
    // config write failure must not fail the port query itself).
    if !result.is_empty() {
        let port_list: Vec<u16> = result.iter().map(|p| p.port).collect();
        let h = app_handle.clone();
        let id_owned = id.clone();
        let _ = config::with_config_mut(&h, |cfg| {
            if let Some(instance) = cfg.servers.get_mut(&id_owned) {
                instance.last_ports = port_list;
            }
            Ok(())
        });
    }
    Ok(result)
}

/// Collects the pid set of an instance's process tree (root + all descendants).
/// Read under the metrics lock (which owns the refreshed process table), then
/// released before any slow OS calls.
pub(crate) fn instance_tree_pids(
    app_handle: &AppHandle,
    root_pid: u32,
) -> std::collections::HashSet<u32> {
    use sysinfo::{Pid, ProcessesToUpdate};

    let state: tauri::State<'_, MetricsState> = app_handle.state();
    let mut tree: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let Ok(mut sys) = state.0.lock() else {
        return tree;
    };
    sys.refresh_processes(ProcessesToUpdate::All, true);
    tree.insert(root_pid);
    loop {
        let mut grew = false;
        let current: Vec<u32> = tree.iter().copied().collect();
        for pid in current {
            let sp = Pid::from_u32(pid);
            if sys.process(sp).is_some() {
                for (cpid, child) in sys.processes() {
                    if child.parent() == Some(sp) && tree.insert(cpid.as_u32()) {
                        grew = true;
                    }
                }
            }
        }
        if !grew {
            break;
        }
    }
    tree
}

/// One port held by another process, reported by the pre-start check.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortConflict {
    pub port: u16,
    pub pid: u32,
    pub process: String,
}

/// Pre-start findings shown to the user before a launch is confirmed.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub conflicts: Vec<PortConflict>,
    /// `eula.txt` exists and still says `eula=false` (Minecraft).
    pub eula_pending: bool,
    /// Free space is below the warning floor.
    pub low_disk: bool,
    pub free_mb: Option<u64>,
}

/// Free-space floor below which a start shows a warning (200 MiB).
const LOW_DISK_BYTES: u64 = 200 * 1024 * 1024;

/// Checks a few things that commonly make a launch fail or surprise the user:
/// ports the instance used last time now held by another process, a pending
/// Minecraft EULA, and a nearly-full disk. Read-only.
#[tauri::command]
pub fn preflight_launch(app_handle: AppHandle, id: String) -> Result<PreflightReport, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    // Ports: compare the last-observed set against the live socket table.
    let own_pids: std::collections::HashSet<u32> = process::pid_for(&app_handle, &id)
        .map(|root| instance_tree_pids(&app_handle, root))
        .unwrap_or_default();
    let listening = query_listening_sockets();
    let conflicts_raw = find_port_conflicts(&instance.last_ports, &listening, &own_pids);

    let conflicts = if conflicts_raw.is_empty() {
        Vec::new()
    } else {
        use sysinfo::{Pid, ProcessesToUpdate};
        let pids: Vec<Pid> = conflicts_raw.iter().map(|(_, p)| Pid::from_u32(*p)).collect();
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(ProcessesToUpdate::Some(&pids), true);
        conflicts_raw
            .into_iter()
            .map(|(port, pid)| {
                let process = sys
                    .process(Pid::from_u32(pid))
                    .map(|p| p.name().to_string_lossy().to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                PortConflict { port, pid, process }
            })
            .collect()
    };

    // Minecraft EULA helper: an existing `eula=false` means the server will
    // refuse to start until it's accepted.
    let eula_path = std::path::Path::new(&instance.path).join("eula.txt");
    let eula_pending = std::fs::read_to_string(&eula_path)
        .map(|raw| eula_declined(&raw))
        .unwrap_or(false);

    let free = crate::disk::available_space_for(std::path::Path::new(&instance.path));
    Ok(PreflightReport {
        conflicts,
        eula_pending,
        low_disk: free.is_some_and(|bytes| bytes < LOW_DISK_BYTES),
        free_mb: free.map(|bytes| bytes / (1024 * 1024)),
    })
}

/// Pure conflict finder: known ports held by pids outside the instance's own
/// tree. Sorted + deduped so the dialog order is stable.
fn find_port_conflicts(
    known: &[u16],
    listening: &[(u32, u16)],
    own: &std::collections::HashSet<u32>,
) -> Vec<(u16, u32)> {
    let mut out: Vec<(u16, u32)> = Vec::new();
    for port in known {
        for (pid, lport) in listening {
            if lport == port && !own.contains(pid) {
                out.push((*port, *pid));
                break;
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// True when an eula.txt body declares `eula=false` (case-insensitive).
fn eula_declined(content: &str) -> bool {
    content.lines().any(|line| {
        let lower = line.trim().to_ascii_lowercase();
        lower.starts_with("eula") && lower.contains('=') && lower.contains("false")
    })
}

/// Runs `netstat -ano` (Windows) / `ss -tlnp` (Linux) / `lsof -iTCP -sTCP:LISTEN`
/// (macOS) and returns `(pid, local_listening_port)` pairs. Best-effort: an
/// empty Vec on any parse failure.
fn query_listening_sockets() -> Vec<(u32, u16)> {
    let out = if cfg!(target_os = "windows") {
        process::silent_command("netstat")
            .args(["-ano", "-p", "TCP"])
            .output()
    } else if cfg!(target_os = "macos") {
        process::silent_command("lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
            .output()
    } else {
        process::silent_command("ss").args(["-tlnp"]).output()
    };
    let Ok(out) = out else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    parse_listening(&text)
}

/// Parses netstat/ss/lsof output into (pid, port) pairs for LISTENING rows.
fn parse_listening(text: &str) -> Vec<(u32, u16)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let lower = line.to_lowercase();
        // Only rows that are actually listening.
        if !(lower.contains("listen") || lower.contains("listening")) {
            continue;
        }
        // Extract the local port from the address token (last :port on the line
        // segment that looks like an addr). Extract the pid from the tail.
        let port = extract_port(&lower);
        let pid = extract_pid(&lower);
        if let (Some(p), Some(pid)) = (port, pid) {
            out.push((pid, p));
        }
    }
    out
}

/// Pulls the local listening port out of a netstat/ss/lsof line.
///
/// The **first** address-like token carrying a `:port` is the local endpoint;
/// taking the last match would grab netstat's foreign address (`0.0.0.0:0`)
/// and report port 0 for every server, which is the bug this fixes.
fn extract_port(line: &str) -> Option<u16> {
    // Address forms: "0.0.0.0:25565", "[::]:25565", "*:25565".
    for tok in line.split_whitespace() {
        let Some(idx) = tok.rfind(':') else { continue };
        let Ok(port) = tok[idx + 1..].trim_end_matches(']').parse::<u16>() else {
            continue;
        };
        if tok.contains('.') || tok.contains('[') || tok.contains('*') {
            return Some(port);
        }
    }
    None
}

/// Pulls the owning PID out of the tail of a netstat/ss/lsof line.
fn extract_pid(line: &str) -> Option<u32> {
    // Look for "pid=<n>" (ss) or a trailing integer (netstat) or " <n> " (lsof).
    if let Some(idx) = line.find("pid=") {
        let rest = &line[idx + 4..];
        let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(p) = num.parse::<u32>() {
            return Some(p);
        }
    }
    // netstat -ano: the last whitespace token is the PID.
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for t in tokens.iter().rev() {
        if t.chars().all(|c| c.is_ascii_digit()) && !t.is_empty() {
            if let Ok(p) = t.parse::<u32>() {
                return Some(p);
            }
        }
    }
    None
}

/// Locates the manifest for a plugin id under `<app_data>/plugins/<id>/`.
fn manifest_path_for(app_handle: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    paths::validate_plugin_id(plugin_id)?;
    let base = config::config_dir(app_handle)?;
    Ok(base.join("plugins").join(plugin_id).join("manifest.json"))
}

/// Resolves a lifecycle step for the given runtime.
///
/// Plugins may declare runtime-specific steps as `start.node`, `start.rust`,
/// etc. — useful when a runtime changes the command entirely (e.g. a Rust bot
/// runs via `cargo run`, not `rust <file>`). Falls back to the generic step
/// name when no runtime-qualified variant exists.
fn lifecycle_step<'m>(
    manifest: &'m manifest::Manifest,
    step: &str,
    runtime: Option<&str>,
) -> Result<&'m manifest::LifecycleStep, String> {
    if let Some(rt) = runtime {
        let qualified = format!("{step}.{rt}");
        if let Some(found) = manifest.lifecycle.get(&qualified) {
            return Ok(found);
        }
    }
    manifest
        .lifecycle
        .get(step)
        .ok_or_else(|| format!("plugin '{}' has no '{step}' lifecycle step", manifest.id))
}

/// Human-readable transient status for a lifecycle step: "starting",
/// "installing", "building", … (previously `format!("{step}-ing")` produced
/// "start-ing", which the frontend's status union didn't recognize).
fn transient_status(step_name: &str) -> String {
    match step_name {
        "start" => "starting".to_string(),
        "install" => "installing".to_string(),
        "build" => "building".to_string(),
        "stop" => "stopping".to_string(),
        other => format!("{other}-ing"),
    }
}

/// Shared logic for running any lifecycle step. Loads the instance + manifest,
/// resolves the step (with runtime qualification), substitutes variables,
/// spawns via `process::launch`, and sets the persisted status.
///
/// On spawn failure the persisted status is set to "error" before the error
/// is returned, so the UI never sees a stale "starting" / "installing" state.
fn run_step(app_handle: &AppHandle, id: &str, step_name: &str) -> Result<(), String> {
    // Atomically reserve the start slot: closes the check-then-spawn race where
    // two launches (rapid double-click, web remote + UI) both pass the
    // is_running check and spawn into the same port. Released on every return.
    let _reservation = process::reserve_start(app_handle, id)?;
    // A manual start clears any accumulated crash-watchdog attempts.
    if step_name == "start" {
        crate::watchdog::reset(app_handle, id);
    }

    let cfg = config::load_config(app_handle)?;
    let instance = cfg
        .servers
        .get(id)
        .ok_or_else(|| format!("server '{id}' not found"))?
        .clone();
    if instance.is_orphaned {
        return Err(format!(
            "instance '{id}' is orphaned (path missing): {}",
            instance.path
        ));
    }

    // ── Custom (barebones) instances ────────────────────────────────────
    // "custom" instances have no plugin manifest — the user provides a
    // start_command override directly. All other lifecycle steps are not
    // supported (no install, etc.).
    if instance.server_type == "custom" {
        if step_name != "start" {
            return Err(
                "custom instances have no lifecycle steps — run commands directly in the terminal"
                    .to_string(),
            );
        }
        let start_cmd = instance
            .user_overrides
            .get("start_command")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "custom instances require a start_command override — set it in instance settings"
                    .to_string()
            })?;
        let overrides = instance.user_overrides.clone();
        let line = process::resolve_variables(start_cmd, &overrides);
        if line.trim().is_empty() {
            return Err("start_command is empty".to_string());
        }

        let transient = transient_status(step_name);
        set_status(app_handle, id, &transient)?;

        // Run the user's line through the OS shell verbatim so PATH lookups,
        // .cmd/.bat shims (npm / bun / yarn on Windows), env-var expansion,
        // pipes and redirects all work — anything goes.
        if let Err(e) = process::launch_via_shell(
            app_handle,
            id,
            std::path::Path::new(&instance.path),
            &line,
            None, // java_path
            true, // restartable: this is the start step
        ) {
            set_status(app_handle, id, "error")?;
            return Err(e);
        }
        set_status(app_handle, id, "running")?;
        persist_process_identity(app_handle, id);
        return Ok(());
    }

    let manifest_path = manifest_path_for(app_handle, &instance.server_type)?;
    let manifest = manifest::load(&manifest_path)?;

    let runtime = instance.user_overrides.get("runtime").map(String::as_str);
    let step = lifecycle_step(&manifest, step_name, runtime)?;

    // ── Smart JAR / script detection for start steps ───────────────────
    // For "start" lifecycle steps that template {{userOverrides.server_jar}}
    // (i.e. JAR-based servers like Minecraft), resolve which JAR or launch
    // script exists on disk and inject it into the overrides so the manifest
    // template resolves to a real filename. For shell-based steps (Forge /
    // NeoForge), detect the actual script (run.sh, start.sh, etc.) and inject
    // its extension-less name so build_shell_command picks the right extension.
    //
    // Plugins whose start step doesn't reference server_jar (e.g. the Discord
    // bot, which runs `node index.js` / `cargo run`) are left untouched — the
    // plugin fully owns the command.
    let step_needs_jar = step.command.contains("server_jar")
        || step.args.iter().any(|a| a.contains("server_jar"));
    let mut overrides = instance.user_overrides.clone();
    if step_name == "start" && step_needs_jar {
        let root = std::path::Path::new(&instance.path);

        // Check if the user has set a custom jar / script name.
        let custom_jar = overrides.get("server_jar").map(String::as_str).unwrap_or("").trim();
        if !custom_jar.is_empty() {
            // User specified a custom name — validate it exists.
            if !root.join(custom_jar).exists() {
                set_status(app_handle, id, "error")?;
                return Err(format!(
                    "Server JAR not found: '{custom_jar}'. Check the name in Settings > Server JAR."
                ));
            }
            if step.use_shell {
                // For shell steps, strip the extension so build_shell_command
                // can resolve it to the platform-appropriate extension.
                let bare = strip_script_extension(custom_jar);
                overrides.insert("server_jar".to_string(), bare);
            } else {
                overrides.insert("server_jar".to_string(), custom_jar.to_string());
            }
        } else if step.use_shell {
            // Shell-based step (Forge/NeoForge): detect which script exists.
            // Try in priority order: kern_start (installer-generated), run, start.
            // Strip the extension so build_shell_command adds the right one.
            let detected = detect_script_for_launch(root);
            match detected {
                Some(name) => {
                    let bare = strip_script_extension(&name);
                    overrides.insert("server_jar".to_string(), bare);
                }
                None => {
                    set_status(app_handle, id, "error")?;
                    return Err(
                        "Forge/NeoForge launch scripts not found (run.sh/start.sh). Run 'install' first, or set a custom script name in Settings > Server JAR.".to_string()
                    );
                }
            }
        } else {
            // JAR-based step: auto-detect in priority order.
            let detected = detect_jar_for_launch(root, runtime.unwrap_or("purpur"));
            match detected {
                Some(name) => {
                    overrides.insert("server_jar".to_string(), name);
                }
                None => {
                    set_status(app_handle, id, "error")?;
                    return Err(
                        "Server JAR not found. Run 'install' first, or set a custom JAR name in settings.".to_string()
                    );
                }
            }
        }
    }

    // ── Per-instance custom start command ───────────────────────────────
    // A user can override the plugin's start step entirely by filling in the
    // `start_command` override (set via the ⚙ button next to Start). When
    // present and non-empty for a start step, we run it through the OS shell
    // verbatim (cmd.exe /C · sh -c) so PATH lookups, .cmd/.bat shims (npm /
    // bun / yarn on Windows), env-var expansion, pipes and redirects all work,
    // and ignore the manifest's `start` step. Lets each project run whatever it
    // actually needs (e.g. `bun run dev`, a specific binary, an env-injected
    // invocation, a bare `npm`) without editing the plugin manifest.
    let custom = overrides
        .get("start_command")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    if step_name == "start" {
        if let Some(line) = custom {
            let resolved = process::resolve_variables(line, &overrides);
            if resolved.trim().is_empty() {
                return Err("custom start_command is empty".to_string());
            }
            let transient = transient_status(step_name);
            set_status(app_handle, id, &transient)?;
            let java_path = overrides.get("java_path").map(String::as_str);
            if let Err(e) = process::launch_via_shell(
                app_handle,
                id,
                std::path::Path::new(&instance.path),
                &resolved,
                java_path,
                true, // restartable: this is the start step
            ) {
                set_status(app_handle, id, "error")?;
                return Err(e);
            }
            set_status(app_handle, id, "running")?;
            persist_process_identity(app_handle, id);
            return Ok(());
        }
    }

    // ── Manifest step (no custom start_command) ─────────────────────────
    // Resolve the manifest's step.command + step.args against the overrides.
    let (command, mut args): (String, Vec<String>) = {
        let c = process::resolve_variables(&step.command, &overrides);
        let a: Vec<String> = step
            .args
            .iter()
            .flat_map(|x| process::shell_split(&process::resolve_variables(x, &overrides)))
            .collect();
        (c, a)
    };

    // ── Cargo multi-binary auto-resolve ─────────────────────────────────
    // `cargo run` / `cargo build` with no `--bin` errors out on workspaces
    // that define several binaries and no `default-run` ("could not determine
    // which binary to run"). If the plugin lets the host pick the target, an
    // explicit `cargo_bin` override wins; otherwise we resolve one from the
    // instance's Cargo.toml and inject `--bin <name>` so the step always
    // launches. Skipped entirely when the step already passes `--bin`.
    //
    // A custom `start_command` returns early above, so by here we're always on
    // the manifest step and `cargo` means the plugin's own command.
    if command == "cargo"
        && step_name == "start"
        && !args.iter().any(|a| a == "--bin" || a.starts_with("--bin="))
    {
        let bin = overrides
            .get("cargo_bin")
            .cloned()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| resolve_cargo_bin(std::path::Path::new(&instance.path)));
        if let Some(name) = bin {
            // cargo expects `run --bin <name> [args…]` — splice `--bin <name>`
            // right after the leading subcommand (`run` / `build`).
            if let Some(idx) = args.iter().position(|a| a == "run" || a == "build") {
                args.insert(idx + 1, "--bin".to_string());
                args.insert(idx + 2, name);
            }
        }
    }

    // Set a transient status like "starting", "installing", etc.
    let transient = format!("{step_name}-ing");
    set_status(app_handle, id, &transient)?;

    // The Setup-selected JDK, read from the live overrides (the value the user
    // sees on the Setup page) rather than the possibly-stale `.env` file. Passed
    // explicitly so shell-based steps (Forge/NeoForge) derive the right
    // JAVA_HOME / PATH for the same JDK.
    let java_path = overrides.get("java_path").map(String::as_str);

    if let Err(e) = process::launch(
        app_handle,
        id,
        std::path::Path::new(&instance.path),
        &command,
        &args,
        step.use_shell,
        java_path,
        step_name == "start", // restartable: only the start step feeds the watchdog
    ) {
        // Spawn failed — roll back to error so the UI isn't stuck in a
        // transient state.
        set_status(app_handle, id, "error")?;
        return Err(e);
    }

    // Spawn succeeded. For "start" the status advances to "running"; other
    // steps (install, build) stay in the background — the frontend will
    // receive an Exited event when they complete and can reconcile status.
    if step_name == "start" {
        set_status(app_handle, id, "running")?;
        persist_process_identity(app_handle, id);
    }
    Ok(())
}

/// Persists the launched process's pid + OS start time so a later app restart
/// can re-adopt it after identity verification (the start time guards against
/// pid reuse). Best-effort: a write failure doesn't undo a successful launch.
fn persist_process_identity(app_handle: &AppHandle, id: &str) {
    let Some(pid) = process::pid_for(app_handle, id) else {
        return;
    };
    let started = process::process_start_time(pid);
    let _ = config::with_config_mut(app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(id) {
            instance.pid = Some(pid);
            instance.pid_started = started;
        }
        Ok(())
    });
}

/// Resolves a `--bin <name>` for a `cargo run` / `cargo build` step when the
/// workspace defines more than one binary target and declares no `default-run`.
/// Without this, Cargo errors out with "could not determine which binary to run"
/// and the start step never spawns.
///
/// Resolution order:
///   1. An explicit `cargo_bin` override (user can pin a target).
///   2. The package name from `[package] name = "…"` (Cargo's implicit default
///      when a `src/main.rs` exists with no explicit `[[bin]]`).
///   3. The single `[[bin]] name = "…"` if exactly one is declared.
///   4. The first `[[bin]]` when several exist (deterministic — sorted), so
///      multi-binary workspaces always launch instead of erroring.
///
/// Returns None when no Cargo.toml is present (then `cargo run` runs as-is and
/// is expected to succeed for a normal single-binary project).
fn resolve_cargo_bin(root: &std::path::Path) -> Option<String> {
    let toml = std::fs::read_to_string(root.join("Cargo.toml")).ok()?;

    // Walk the manifest tracking the current section header so we only treat a
    // `name = "…"` as a binary target when it lives under `[[bin]]`.
    let mut section = String::new();
    let mut pkg_name: Option<String> = None;
    let mut bins: Vec<String> = Vec::new();
    for line in toml.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            // Strip every layer of brackets so both `[package]` and `[[bin]]`
            // reduce to a bare section key ("package", "bin").
            section = t.trim_matches(|c| c == '[' || c == ']').trim().to_string();
            continue;
        }
        let Some((k, v)) = t.split_once('=') else { continue };
        let key = k.trim();
        let val = v.trim().trim_end_matches(',').trim();
        let quoted = val
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .map(str::to_string);
        if section == "package" && key == "name" {
            pkg_name = quoted.clone();
        }
        if section == "bin" && key == "name" {
            if let Some(q) = quoted {
                bins.push(q);
            }
        }
    }

    // Explicit [[bin]] tables win over the implicit main.rs default.
    if !bins.is_empty() {
        if bins.len() == 1 {
            return Some(bins[0].clone());
        }
        // Several [[bin]] targets: pick one deterministically (sorted) so the
        // start step always launches instead of erroring.
        bins.sort();
        return Some(bins[0].clone());
    }

    // No explicit [[bin]] — fall back to the package name, which Cargo treats
    // as the implicit target when src/main.rs exists.
    pkg_name
}

/// Strips the extension from a script filename so `build_shell_command` can
/// resolve it to the platform-appropriate extension (.bat on Windows, .sh on
/// Unix). E.g. "run.sh" → "run", "start.bat" → "start", "kern_start" → "kern_start".
fn strip_script_extension(name: &str) -> String {
    if let Some(stem) = name.strip_suffix(".sh") {
        stem.to_string()
    } else if let Some(stem) = name.strip_suffix(".bat") {
        stem.to_string()
    } else {
        name.to_string()
    }
}

/// Detects which launch script exists for Forge/NeoForge. Checks in priority
/// order: kern_start (installer-generated), run, start. Returns the full
/// filename (with extension) of the first match.
fn detect_script_for_launch(root: &std::path::Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    let candidates = ["kern_start.bat", "run.bat", "start.bat"];
    #[cfg(not(target_os = "windows"))]
    let candidates = ["kern_start.sh", "run.sh", "start.sh"];

    for name in &candidates {
        if root.join(name).exists() {
            return Some(name.to_string());
        }
    }
    None
}

/// Lightweight jar / script detection for pre-launch validation. Checks common
/// names in priority order based on the runtime. Returns the first filename
/// that exists on disk, or None if nothing is found.
fn detect_jar_for_launch(root: &std::path::Path, runtime: &str) -> Option<String> {
    // Priority 1: server.jar (Vanilla, Paper, Purpur — and commonly used by all)
    if root.join("server.jar").exists() {
        return Some("server.jar".to_string());
    }

    // Priority 2: runtime-specific jars or launch scripts
    match runtime {
        "fabric" => {
            if root.join("fabric-server-launch.jar").exists() {
                return Some("fabric-server-launch.jar".to_string());
            }
        }
        "quilt" => {
            if root.join("quilt-server-launcher.jar").exists() {
                return Some("quilt-server-launcher.jar".to_string());
            }
        }
        "forge" | "neoforge" => {
            // Forge/NeoForge use generated run scripts, not -jar.
            #[cfg(target_os = "windows")]
            {
                for name in &["run.bat", "start.bat", "kern_start.bat"] {
                    if root.join(name).exists() {
                        return Some(name.to_string());
                    }
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                for name in &["run.sh", "start.sh", "kern_start.sh"] {
                    if root.join(name).exists() {
                        return Some(name.to_string());
                    }
                }
            }
        }
        _ => {}
    }

    // Priority 3: scan for any *.jar (excluding installer/library jars)
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut fallbacks: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jar") {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                if name.ends_with("-installer.jar")
                    || name.ends_with("-libraries.jar")
                    || name.contains("installer")
                {
                    continue;
                }
                fallbacks.push(name);
            }
        }
        fallbacks.sort();
        if let Some(first) = fallbacks.into_iter().next() {
            return Some(first);
        }
    }

    None
}

/// Launches a server instance's "start" lifecycle step.
///
/// Resolves the command + args from the plugin manifest's lifecycle, preferring
/// a runtime-qualified variant (`start.<runtime>`) when one exists, applies
/// `{{userOverrides.*}}` substitution, spawns the process, and streams its
/// output to `<instance.path>/latest.log` + a `log:<id>:stream` event.
#[tauri::command]
pub fn launch_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    run_step(&app_handle, &id, "start")?;
    crate::audit::record(
        &app_handle,
        "start",
        &format!("started '{}'", audit_name(&app_handle, &id)),
        Some(&id),
    );
    Ok(())
}

/// Public entry point for launching an instance's "start" step from outside the
/// command surface (used by the auto-start-on-launch path in `lib::setup`).
/// Thin wrapper around the shared `run_step` helper.
pub fn launch_instance(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    run_step(app_handle, id, "start")?;
    crate::audit::record(
        app_handle,
        "start",
        &format!("started '{}'", audit_name(app_handle, id)),
        Some(id),
    );
    Ok(())
}

/// Best-effort instance name for human-readable audit details.
fn audit_name(app_handle: &AppHandle, id: &str) -> String {
    config::load_config(app_handle)
        .ok()
        .and_then(|cfg| cfg.servers.get(id).map(|s| s.name.clone()))
        .unwrap_or_else(|| id.to_string())
}

/// Read-only findings for the "import existing server folder" wizard.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInspection {
    pub path: String,
    pub jars: Vec<String>,
    pub start_scripts: Vec<String>,
    pub has_server_properties: bool,
    pub eula_declined: bool,
    pub has_world: bool,
    /// Runtime id understood by the minecraft plugin ("paper", "forge", …).
    pub suggested_runtime: Option<String>,
    /// Overrides to pre-fill for the chosen plugin.
    pub suggested_overrides: std::collections::HashMap<String, String>,
    /// Folder name, pre-filled as the instance name.
    pub suggested_name: String,
}

/// Inspects a folder the user wants to adopt as an instance: which server jar
/// or launch script it holds, whether a world exists, and whether the
/// Minecraft EULA still needs accepting. Never writes anything.
#[tauri::command]
pub fn inspect_server_folder(path: String) -> Result<FolderInspection, String> {
    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        return Err(format!("'{path}' does not exist"));
    }
    if !dir.is_dir() {
        return Err(format!("'{path}' is not a folder"));
    }

    let mut jars: Vec<String> = Vec::new();
    let mut start_scripts: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_dir() {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".jar") {
                if lower.ends_with("-installer.jar")
                    || lower.ends_with("-libraries.jar")
                    || lower.contains("installer")
                {
                    continue;
                }
                jars.push(name);
            } else if matches!(
                lower.as_str(),
                "run.bat" | "run.sh" | "start.bat" | "start.sh" | "kern_start.bat" | "kern_start.sh"
            ) {
                start_scripts.push(name);
            }
        }
    }
    jars.sort();
    start_scripts.sort();

    let eula_declined = std::fs::read_to_string(dir.join("eula.txt"))
        .map(|raw| eula_declined(&raw))
        .unwrap_or(false);

    let (suggested_runtime, server_jar) = detect_server_flavor(&jars, &start_scripts);
    let mut suggested_overrides = std::collections::HashMap::new();
    if let Some(runtime) = &suggested_runtime {
        suggested_overrides.insert("runtime".to_string(), runtime.clone());
    }
    if let Some(jar) = server_jar {
        suggested_overrides.insert("server_jar".to_string(), jar);
    }
    let suggested_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let has_server_properties = dir.join("server.properties").exists();
    let has_world = dir.join("world").is_dir();

    Ok(FolderInspection {
        path,
        jars,
        start_scripts,
        has_server_properties,
        eula_declined,
        has_world,
        suggested_runtime,
        suggested_overrides,
        suggested_name,
    })
}

/// Maps the files present in a folder to a plugin runtime + jar hint.
/// Pure so it can be unit-tested.
fn detect_server_flavor(
    jars: &[String],
    start_scripts: &[String],
) -> (Option<String>, Option<String>) {
    let find = |needle: &str| -> Option<String> {
        jars.iter()
            .find(|j| j.to_ascii_lowercase().contains(needle))
            .cloned()
    };

    if let Some(jar) = find("fabric-server-launch") {
        return (Some("fabric".to_string()), Some(jar));
    }
    if let Some(jar) = find("quilt-server-launcher") {
        return (Some("quilt".to_string()), Some(jar));
    }
    if let Some(jar) = find("neoforge") {
        return (Some("neoforge".to_string()), Some(jar));
    }
    if let Some(jar) = find("forge") {
        return (Some("forge".to_string()), Some(jar));
    }
    if let Some(jar) = find("purpur") {
        return (Some("purpur".to_string()), Some(jar));
    }
    if let Some(jar) = find("paper") {
        return (Some("paper".to_string()), Some(jar));
    }
    if let Some(jar) = jars
        .iter()
        .find(|j| j.to_ascii_lowercase().contains("server"))
        .cloned()
    {
        return (Some("vanilla".to_string()), Some(jar));
    }
    // Unknown/modded layouts: if there's a launch script, let Forge-style
    // shell handling take over with no jar override.
    if !start_scripts.is_empty() {
        return (None, None);
    }
    (None, jars.first().cloned())
}

/// Runs an arbitrary lifecycle step (install, build, test, etc.) from the
/// instance's plugin manifest. The step name is resolved with runtime
/// qualification (e.g. `install.rust` when the instance has `runtime=rust`).
///
/// Unlike `launch_server_instance`, the status is set to `{stepName}-ing`
/// rather than "running", since non-start steps are expected to exit on
/// their own. The frontend should listen for the Exited event to reconcile.
#[tauri::command]
pub fn run_lifecycle_step(
    app_handle: AppHandle,
    id: String,
    step_name: String,
) -> Result<(), String> {
    run_step(&app_handle, &id, &step_name)
}

/// Runs the "install" lifecycle step (e.g. `npm install`, `cargo build`).
/// Convenience wrapper around `run_lifecycle_step`.
#[tauri::command]
pub fn install_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    run_step(&app_handle, &id, "install")
}

/// Restarts a running instance: stops the current process, then starts it
/// again via the "start" lifecycle step.
///
/// If the instance isn't running, returns an error rather than silently
/// starting — callers should check `is_server_running` first. Runs on a
/// blocking thread so the graceful-stop wait never freezes the UI.
#[tauri::command]
pub async fn restart_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || restart_instance_blocking(&handle, &id))
        .await
        .map_err(|e| format!("restart task failed: {e}"))?
}

/// Blocking restart (also used by the scheduler): stop, brief settle, then
/// start with a few retries for slow port release.
pub fn restart_instance_blocking(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    if !process::is_running(app_handle, id) && !process::is_task_running(app_handle, id) {
        return Err(format!("instance '{id}' is not running"));
    }

    stop_instance_blocking(app_handle, id)?;

    // Brief pause lets the OS release the port/socket before re-spawning.
    std::thread::sleep(std::time::Duration::from_millis(300));

    // Retry the re-spawn a few times: on a slow host the OS may not have
    // finished releasing resources yet, and a single attempt can fail
    // spuriously even though nothing is actually wrong.
    const RESTART_MAX_ATTEMPTS: u32 = 3;
    const RESTART_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(250);
    let mut last_err: Option<String> = None;
    for _ in 0..RESTART_MAX_ATTEMPTS {
        match run_step(app_handle, id, "start") {
            Ok(_) => {
                crate::audit::record(
                    app_handle,
                    "restart",
                    &format!("restarted '{}'", audit_name(app_handle, id)),
                    Some(id),
                );
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(RESTART_RETRY_DELAY);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "restart failed for unknown reason".to_string()))
}

/// Resolved graceful-stop behaviour for an instance.
struct StopStrategy {
    /// Text sent to the server's stdin (`None` = skip; e.g. servers without a
    /// console).
    stdin_command: Option<String>,
    /// Optional manifest `stop` lifecycle step to run before signalling.
    manifest_step: Option<manifest::LifecycleStep>,
}

/// Picks the graceful-stop behaviour for an instance:
///   1. instance `stop_command` override (empty string disables stdin),
///   2. manifest `stopCommand`,
///   3. when the manifest declares a `stop` lifecycle step, that step only,
///   4. otherwise the Minecraft-style default `"stop"`.
fn resolve_stop_strategy(
    app_handle: &AppHandle,
    instance: &ServerInstance,
) -> Result<StopStrategy, String> {
    let non_empty = |s: String| -> Option<String> {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_string())
    };

    if instance.server_type == "custom" {
        let cmd = instance
            .stop_command
            .clone()
            .unwrap_or_else(|| "stop".to_string());
        return Ok(StopStrategy {
            stdin_command: non_empty(process::resolve_variables(
                &cmd,
                &instance.user_overrides,
            )),
            manifest_step: None,
        });
    }

    let manifest = manifest::load(&manifest_path_for(app_handle, &instance.server_type)?)?;
    let runtime = instance.user_overrides.get("runtime").map(String::as_str);
    let step = lifecycle_step(&manifest, "stop", runtime).ok().cloned();

    let stdin_command = match &instance.stop_command {
        Some(s) => non_empty(process::resolve_variables(s, &instance.user_overrides)),
        None => match manifest.stop_command.as_deref() {
            Some(s) => non_empty(process::resolve_variables(s, &instance.user_overrides)),
            None if step.is_some() => None,
            None => Some("stop".to_string()),
        },
    };

    Ok(StopStrategy {
        stdin_command,
        manifest_step: step,
    })
}

/// Blocking stop shared by the stop command, restart, delete, and web remote.
///
/// Handles three cases: an owned/adopted server process (staged graceful →
/// forced tree-kill), a tracked one-shot task (hard cancel), or nothing
/// running (idempotent no-op). Persists "stopped"/"stopped-forced" so the
/// sidebar is correct even before the UI event arrives.
pub fn stop_instance_blocking(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    stop_instance_internal(app_handle, id, true)?;
    crate::audit::record(
        app_handle,
        "stop",
        &format!("stopped '{}'", audit_name(app_handle, id)),
        Some(id),
    );
    Ok(())
}

/// Stop implementation with an opt-out for post-stop hooks. `delete_server`
/// passes `run_hooks = false` so deleting an instance doesn't archive a world
/// into the directory it's about to remove.
fn stop_instance_internal(
    app_handle: &AppHandle,
    id: &str,
    run_hooks: bool,
) -> Result<(), String> {
    let cfg = config::load_config(app_handle)?;
    let instance = cfg
        .servers
        .get(id)
        .cloned()
        .ok_or_else(|| format!("server '{id}' not found"))?;

    // One Stop covers both a server and a running install/ad-hoc task.
    if !process::is_running(app_handle, id) {
        if process::is_task_running(app_handle, id) {
            set_status(app_handle, id, "stopping")?;
            process::stop_task(app_handle, id)?;
            set_status(app_handle, id, "stopped")?;
        }
        return Ok(());
    }

    set_status(app_handle, id, "stopping")?;

    let strategy = resolve_stop_strategy(app_handle, &instance)?;
    let timeout = std::time::Duration::from_secs(instance.stop_timeout_secs.max(1));

    // Manifest stop step (e.g. an RCON/helper command) runs first, bounded.
    if let Some(step) = &strategy.manifest_step {
        let helper_timeout = timeout.min(std::time::Duration::from_secs(15));
        if let Err(e) = process::run_stop_step(
            app_handle,
            id,
            std::path::Path::new(&instance.path),
            step,
            helper_timeout,
        ) {
            let _ = app_handle.emit(
                &format!("log:{id}:stream"),
                format!("{} [stop] stop step failed: {e}", timestamp()),
            );
        }
    }

    let outcome =
        process::stop_managed(app_handle, id, timeout, strategy.stdin_command.as_deref())?;
    let final_status = match outcome {
        process::StopOutcome::Graceful => "stopped",
        process::StopOutcome::Forced => "stopped-forced",
    };
    set_status(app_handle, id, final_status)?;

    // The instance is down — honor the scheduled "snapshot when stopped" hook.
    if run_hooks && instance.backup_schedule.on_stop {
        match backup_world_impl(app_handle, id) {
            Ok(relative) => crate::watchdog::notify(
                app_handle,
                "success",
                "On-stop backup saved",
                Some(relative),
                Some(id),
            ),
            Err(e) => crate::watchdog::notify(
                app_handle,
                "error",
                "On-stop backup failed",
                Some(e),
                Some(id),
            ),
        }
    }
    Ok(())
}

/// Stops a running instance. Idempotent — Ok if it wasn't running.
///
/// Asks the server to shut down gracefully first (per-instance `stop_command`
/// or plugin `stop` step), then force-kills the whole process tree if it
/// doesn't exit within the instance's `stop_timeout_secs`. Runs on a blocking
/// thread so the wait never freezes the UI.
#[tauri::command]
pub async fn stop_server_instance(app_handle: AppHandle, id: String) -> Result<(), String> {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || stop_instance_blocking(&handle, &id))
        .await
        .map_err(|e| format!("stop task failed: {e}"))?
}

/// Runs an arbitrary command inside an instance's working directory and waits
/// for it to complete. All stdout/stderr is streamed to `log:<id>:stream`
/// events and appended to `latest.log`, exactly like a lifecycle step.
///
/// This is a synchronous (blocking) command — the frontend awaits it. It's
/// designed for one-shot setup tasks such as running Fabric/Forge installers,
/// or any plugin-driven installation step that needs to run a process and
/// see its output in the terminal.
///
/// The process inherits the instance's `.env` environment variables. On
/// failure the persisted status is set to "error" before the error is returned.
#[tauri::command]
pub async fn run_instance_command(
    app_handle: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_instance_command_blocking(app_handle, id, command, args)
    })
    .await
    .map_err(|e| format!("command task failed: {e}"))?
}

fn run_instance_command_blocking(
    app_handle: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    // 1. Load instance config.
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?
        .clone();
    if instance.is_orphaned {
        return Err(format!(
            "instance '{id}' is orphaned (path missing): {}",
            instance.path
        ));
    }

    let working_dir = std::path::Path::new(&instance.path);
    let log_path = working_dir.join("latest.log");

    // 2. Build the command.
    let mut cmd = process::silent_command(&command);
    cmd.current_dir(working_dir);
    cmd.args(&args);
    // Inherit host env and layer the instance's .env on top.
    let env_path = working_dir.join(".env");
    for (k, v) in parse_env_file(&env_path) {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // 3. Set transient status.
    set_status(&app_handle, &id, "setup")?;

    // 4. Spawn.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{command}': {e}"))?;

    // Track the child so the Stop control can cancel a hung installer.
    let task = match process::register_task(&app_handle, &id, child.id()) {
        Ok(task) => task,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "spawned child has no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "spawned child has no stderr pipe".to_string())?;

    let event_name = format!("log:{id}:stream");

    // 5. Read stdout and stderr concurrently using threads, forward to log.
    //    We merge them into a single stream (same as the lifecycle process).
    let handle = app_handle.clone();
    let log_path_stdout = log_path.clone();
    let event_out = event_name.clone();
    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let stamped = forward_to_log(&handle, &event_out, &log_path_stdout, &line);
            let _ = handle.emit(&event_out, stamped);
        }
    });

    let handle_err = app_handle.clone();
    let log_path_stderr = log_path.clone();
    let event_err = event_name.clone();
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let stamped = forward_to_log(&handle_err, &event_err, &log_path_stderr, &line);
            let _ = handle_err.emit(&event_err, stamped);
        }
    });

    // 6. Wait for both readers to finish, then wait for the child to exit.
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait for child: {e}"))?;
    process::unregister_task(&app_handle, &id);

    // A cancel via the Stop control is not a failure exit.
    if task.was_forced() {
        set_status(&app_handle, &id, "stopped")?;
        return Ok(());
    }

    // 7. Report result.
    if status.success() {
        set_status(&app_handle, &id, "stopped")?;
        Ok(())
    } else {
        let code = status.code().map_or("unknown".to_string(), |c| c.to_string());
        set_status(&app_handle, &id, "error")?;
        Err(format!("command exited with code {code}"))
    }
}

/// Runs an ad-hoc command line in an instance's working directory (used when
/// the user types something that isn't a lifecycle keyword while the server is
/// idle — see `ServerDetailView.tsx` ad-hoc terminal path).
///
/// Unlike [`run_instance_command`], this does **not** flip the instance status
/// (the server isn't actually running — we're just running a one-off helper
/// command like `ls`, `cat`, or `git status`). Output is streamed live to the
/// same `log:<id>:stream` channel and appended to `latest.log`, so it appears
/// inline in the terminal the user typed into.
///
/// `line` is the full trimmed input, run through the OS shell (`cmd.exe /C` on
/// Windows, `sh -c` on Unix) so builtins like `dir`, `echo`, `type`, `set`,
/// `ls`, pipes, and redirects all resolve — typing into the terminal behaves
/// the way a user expects. The shell runs scoped to the instance directory.
#[tauri::command]
pub async fn run_terminal_command(
    app_handle: AppHandle,
    id: String,
    line: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_terminal_command_blocking(app_handle, id, line))
        .await
        .map_err(|e| format!("command task failed: {e}"))?
}

fn run_terminal_command_blocking(
    app_handle: AppHandle,
    id: String,
    line: String,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    // 1. Load + validate instance.
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?
        .clone();
    if instance.is_orphaned {
        return Err(format!(
            "instance '{id}' is orphaned (path missing): {}",
            instance.path
        ));
    }

    let working_dir = std::path::Path::new(&instance.path);
    let log_path = working_dir.join("latest.log");

    // 2. Build the command via the OS shell so builtins/pipes/redirects work.
    let mut cmd = process::build_adhoc_shell_command(&line);
    cmd.current_dir(working_dir);
    let env_path = working_dir.join(".env");
    for (k, v) in parse_env_file(&env_path) {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // 3. Spawn.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{line}': {e}"))?;

    // Track the child so the Stop control can cancel a hung ad-hoc command.
    let task = match process::register_task(&app_handle, &id, child.id()) {
        Ok(task) => task,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "spawned child has no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "spawned child has no stderr pipe".to_string())?;

    let event_name = format!("log:{id}:stream");

    // 4. Stream stdout + stderr concurrently to the terminal + latest.log.
    let handle = app_handle.clone();
    let log_path_stdout = log_path.clone();
    let event_out = event_name.clone();
    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let stamped = forward_to_log(&handle, &event_out, &log_path_stdout, &line);
            let _ = handle.emit(&event_out, stamped);
        }
    });

    let handle_err = app_handle.clone();
    let log_path_stderr = log_path.clone();
    let event_err = event_name.clone();
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let stamped = forward_to_log(&handle_err, &event_err, &log_path_stderr, &line);
            let _ = handle_err.emit(&event_err, stamped);
        }
    });

    // 5. Wait for readers + child. Status is intentionally left untouched —
    //    this is an ad-hoc command, not a server lifecycle transition.
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait for child: {e}"))?;
    process::unregister_task(&app_handle, &id);

    if task.was_forced() || status.success() {
        Ok(())
    } else {
        let code = status.code().map_or("unknown".to_string(), |c| c.to_string());
        Err(format!("command exited with code {code}"))
    }
}

/// Formats the current wall-clock time as `[HH:MM:SS]`.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut tod = secs % 86_400;
    let h = (tod / 3600) % 24;
    tod %= 3600;
    let m = (tod / 60) % 60;
    let s = tod % 60;
    format!("[{h:02}:{m:02}:{s:02}]")
}

/// Returns true if `line` already starts with a `[HH:MM:SS]`-style timestamp.
///
/// Mirrors process::has_timestamp — keeps the in-memory view in step with what
/// lands on disk so emulated console timestamps never double up.
//
// See process.rs — the optional second hour digit triggers a false positive
// `unused_assignments` warning; suppressed at function level since `i` is
// read by the subsequent `'':'` check in every branch that reaches here.
#[allow(unused_assignments)]
fn has_timestamp(line: &str) -> bool {
    use std::ops::ControlFlow;

    fn digits(bytes: &[u8], i: &mut usize, n: usize) -> ControlFlow<(), ()> {
        for _ in 0..n {
            if *i >= bytes.len() || !bytes[*i].is_ascii_digit() {
                return ControlFlow::Break(());
            }
            *i += 1;
        }
        ControlFlow::Continue(())
    }

    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < len && bytes[i] == b'[' {
        i += 1;
    }
    if digits(bytes, &mut i, 1).is_break() {
        return false;
    }
    if i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i >= len || bytes[i] != b':' || digits(bytes, &mut i, 2).is_break() {
        return false;
    }
    if i < len && bytes[i] == b':'
        && digits(bytes, &mut i, 2).is_break() {
            return false;
        }
    if i < len && bytes[i] == b'.' {
        i += 1;
        if digits(bytes, &mut i, 1).is_break() {
            return false;
        }
        while i < len && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    if matches!(bytes.get(i), Some(b) if *b == b'a' || *b == b'A' || *b == b'p' || *b == b'P')
        && matches!(bytes.get(i + 1), Some(b) if *b == b'm' || *b == b'M')
    {
        i += 2;
    } else if matches!(bytes.get(i), Some(b) if *b == b'm' || *b == b'M') {
        i += 1;
    }
    if i < len && bytes[i] == b']' {
        i += 1;
    }
    true
}

/// Appends a line to latest.log and returns a timestamped string for the event.
fn forward_to_log(_handle: &AppHandle, _event_name: &str, log_path: &std::path::Path, line: &str) -> String {
    let stamped = if has_timestamp(line) {
        line.to_string()
    } else {
        let ts = timestamp();
        format!("{ts} {line}")
    };
    // Write to latest.log (best-effort).
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{stamped}");
    }
    stamped
}

/// Parses a `.env` file into (key, value) pairs. Mirrors process.rs logic.
fn parse_env_file(path: &std::path::Path) -> Vec<(String, String)> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, val)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut val = val.trim().to_string();
        let bytes = val.as_bytes();
        if bytes.len() >= 2
            && (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'
                || bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
        {
            val = val[1..val.len() - 1].to_string();
        }
        out.push((key.to_string(), val));
    }
    out
}

/// Writes data to a running instance's stdin stream.
///
/// The frontend calls this when the user types a command into the terminal
/// input box. The data (already newline-terminated by the frontend) is piped
/// directly to the spawned child's stdin.
#[tauri::command]
pub fn write_stdin_to_instance(
    app_handle: AppHandle,
    id: String,
    data: String,
) -> Result<(), String> {
    process::write_stdin(&app_handle, &id, &data)
}

/// Returns the tail of an instance's latest.log (last `max_lines`).
///
/// Bounds memory: if the file exceeds `TAIL_BYTES_CAP`, only the trailing
/// `TAIL_BYTES_CAP` bytes are read (via a seek from EOF) and then split into
/// lines. A multi-GB `latest.log` no longer gets slurped into a single String.
/// The first line of a truncated tail is likely partial and is dropped.
#[tauri::command]
pub async fn get_log_tail(
    app_handle: AppHandle,
    id: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_log_tail_blocking(app_handle, id, max_lines))
        .await
        .map_err(|e| format!("log tail task failed: {e}"))?
}

fn get_log_tail_blocking(
    app_handle: AppHandle,
    id: String,
    max_lines: Option<usize>,
) -> Result<Vec<String>, String> {
    use std::io::{Read, Seek, SeekFrom};

    const TAIL_BYTES_CAP: u64 = 2 * 1024 * 1024; // 2 MiB

    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let log_path = PathBuf::from(&instance.path).join("latest.log");

    let mut file = match std::fs::File::open(&log_path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("failed to open '{}': {e}", log_path.display())),
    };

    let file_len = file
        .metadata()
        .map(|m| m.len())
        .unwrap_or(0);

    let raw: String = if file_len > TAIL_BYTES_CAP {
        // Seek to (EOF - cap) and read only the tail. The first line in that
        // slice is almost certainly cut mid-way, so drop it.
        file.seek(SeekFrom::End(-(TAIL_BYTES_CAP as i64)))
            .map_err(|e| format!("seek failed: {e}"))?;
        let mut buf = Vec::with_capacity(TAIL_BYTES_CAP as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| format!("read failed: {e}"))?;
        let s = String::from_utf8_lossy(&buf).into_owned();
        match s.find('\n') {
            Some(idx) => s[idx + 1..].to_string(),
            None => String::new(), // whole cap was one giant line
        }
    } else {
        let mut s = String::new();
        file.read_to_string(&mut s)
            .map_err(|e| format!("failed to read '{}': {e}", log_path.display()))?;
        s
    };

    let mut lines: Vec<&str> = raw.lines().collect();
    let limit = max_lines.unwrap_or(500);
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Ok(lines.iter().map(|s| s.to_string()).collect())
}

/// Helper: writes a new status for an instance and persists it.
///
/// Goes through `with_config_mut` so this background-thread write (from the
/// stdout reader) can't clobber a concurrent user-driven change — e.g. it
/// won't revert a server deletion that races it, or drop a sibling instance's
/// status update.
fn set_status(app_handle: &AppHandle, id: &str, status: &str) -> Result<(), String> {
    config::with_config_mut(app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(id) {
            instance.status = status.to_string();
        }
        Ok(())
    })
}

/// Reads a specific variable from an instance's .env file.
/// Returns None if the file or variable doesn't exist.
#[tauri::command]
pub fn read_env_file(app_handle: AppHandle, id: String, var_name: String) -> Result<Option<String>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let env_path = std::path::Path::new(&instance.path).join(".env");
    if !env_path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&env_path)
        .map_err(|e| format!("failed to read .env: {e}"))?;
    // Parse key=value lines (simple parser, no value quoting)
    for line in raw.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == var_name {
                return Ok(Some(value.trim().to_string()));
            }
        }
    }
    Ok(None)
}

/// Checks whether a relative file exists inside an instance's working directory.
/// Returns true if the file exists, false otherwise (missing file = not installed).
#[tauri::command]
pub fn server_file_exists(app_handle: AppHandle, id: String, rel_path: String) -> Result<bool, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    Ok(target.exists())
}

/// Writes content to a relative file inside an instance's working directory.
/// Creates parent directories if missing. Used for marker files like `.installed`.
///
/// Conflict detection: if `expected_mtime` is provided (epoch seconds, as
/// returned by a prior read/write), the file's current mtime is compared first.
/// A mismatch means the file changed on disk since the editor last saw it
/// (running server rewriting `server.properties`, external editor, or the live
/// watcher firing) — writing would clobber that. Returns `Err("conflict:...")`
/// so the frontend can prompt instead of silently overwriting.
///
/// Returns the new file mtime (epoch seconds) on success, so the editor can
/// update its conflict-detection baseline.
#[tauri::command]
pub fn write_server_file(
    app_handle: AppHandle,
    id: String,
    rel_path: String,
    content: String,
    expected_mtime: Option<f64>,
) -> Result<f64, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;

    // Conflict check: only when the caller knows the last-known mtime.
    if let Some(expected) = expected_mtime {
        if let Ok(meta) = std::fs::metadata(&target) {
            let current = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            if (current - expected).abs() > f64::EPSILON {
                return Err(format!(
                    "conflict: '{rel_path}' changed on disk since you last saved"
                ));
            }
        }
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dirs: {e}"))?;
    }
    // Auto-snapshot the previous content when the instance enables snapshots.
    if instance
        .features
        .get("snapshots")
        .copied()
        .unwrap_or(false)
    {
        let _ = crate::snapshots::capture(std::path::Path::new(&instance.path), &rel_path);
    }
    std::fs::write(&target, &content)
        .map_err(|e| format!("failed to write '{rel_path}': {e}"))?;

    // Return the fresh mtime so the editor updates its baseline.
    let mtime = std::fs::metadata(&target)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    Ok(mtime)
}

/// A single entry in a directory listing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// Security: resolve a relative path against the instance root and reject
/// paths that escape the instance directory (path traversal prevention).
/// Delegates to [`crate::paths::safe_join`], the single containment primitive
/// (lexical `..` rejection, symlink-aware, works for not-yet-existing files).
fn resolve_path(instance_root: &str, rel_path: &str) -> Result<std::path::PathBuf, String> {
    paths::safe_join(std::path::Path::new(instance_root), rel_path)
}

/// A file's content paired with its on-disk mtime (epoch seconds).
///
/// The mtime is the editor's conflict-detection baseline: on save it's passed
/// back as `expected_mtime`, and a mismatch means the file was changed
/// externally and shouldn't be silently overwritten.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub mtime: f64,
}

/// Reads a file's content from an instance's working directory.
#[tauri::command]
pub fn read_server_file(app_handle: AppHandle, id: String, rel_path: String) -> Result<FileContent, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.is_file() {
        return Err(format!("'{}' is not a file or does not exist", rel_path));
    }
    let content = std::fs::read_to_string(&target)
        .map_err(|e| format!("failed to read '{rel_path}': {e}"))?;
    let mtime = std::fs::metadata(&target)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    Ok(FileContent { content, mtime })
}

/// Lists the contents of a directory inside an instance's working directory.
/// Returns a sorted list of FileEntry values (directories first, then files).
#[tauri::command]
pub fn list_server_directory(app_handle: AppHandle, id: String, rel_path: String) -> Result<Vec<FileEntry>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.is_dir() {
        return Err(format!("'{}' is not a directory or does not exist", rel_path));
    }
    let mut entries: Vec<FileEntry> = std::fs::read_dir(&target)
        .map_err(|e| format!("failed to list directory '{rel_path}': {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = entry.metadata().ok()?;
            Some(FileEntry {
                name,
                is_dir: meta.is_dir(),
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            })
        })
        .collect();
    // Sort: directories first, then alphabetically within each group.
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir) // dirs first
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });
    Ok(entries)
}

/// Deletes a file or empty directory inside an instance's working directory.
/// Non-empty directories return an error — use a future recursive variant for that.
#[tauri::command]
pub fn delete_server_path(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.exists() {
        return Err(format!("'{}' does not exist", rel_path));
    }
    if target.is_dir() {
        // Only remove empty directories.
        let is_empty = target.read_dir().map_err(|e| format!("failed to read dir: {e}"))?.next().is_none();
        if !is_empty {
            return Err(format!("directory '{}' is not empty — delete files individually", rel_path));
        }
        std::fs::remove_dir(&target)
            .map_err(|e| format!("failed to remove directory '{rel_path}': {e}"))
    } else {
        std::fs::remove_file(&target)
            .map_err(|e| format!("failed to remove file '{rel_path}': {e}"))
    }
}

/// Creates a directory (and any missing parents) inside an instance's working directory.
#[tauri::command]
pub fn create_server_directory(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if target.exists() {
        return Err(format!("'{}' already exists", rel_path));
    }
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("failed to create directory '{rel_path}': {e}"))
}

/// Renames (or moves) a file or directory inside an instance's working directory.
/// Both old_rel_path and new_rel_path are relative to the instance root.
#[tauri::command]
pub fn rename_server_path(app_handle: AppHandle, id: String, old_rel_path: String, new_rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let source = resolve_path(&instance.path, &old_rel_path)?;
    let dest = resolve_path(&instance.path, &new_rel_path)?;
    if !source.exists() {
        return Err(format!("source '{}' does not exist", old_rel_path));
    }
    if dest.exists() {
        return Err(format!("destination '{}' already exists", new_rel_path));
    }
    // Create parent directories for the destination if needed.
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dirs: {e}"))?;
    }
    std::fs::rename(&source, &dest)
        .map_err(|e| format!("failed to rename '{}' -> '{}': {e}", old_rel_path, new_rel_path))
}

/// Deletes a file or directory recursively inside an instance's working directory.
/// Unlike `delete_server_path`, this removes non-empty directories and all their
/// contents — use with caution.
#[tauri::command]
pub fn delete_server_path_recursive(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.exists() {
        return Err(format!("'{}' does not exist", rel_path));
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("failed to remove directory '{rel_path}': {e}"))
    } else {
        std::fs::remove_file(&target)
            .map_err(|e| format!("failed to remove file '{rel_path}': {e}"))
    }
}

/// Opens a file or directory inside an instance in the system file manager
/// (Windows Explorer, macOS Finder, Linux xdg-open).
/// If the path is a file, its parent directory is opened with the file selected
/// where possible; if it's a directory, the directory itself is opened.
#[tauri::command]
pub fn open_server_path(app_handle: AppHandle, id: String, rel_path: String) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.exists() {
        return Err(format!("'{}' does not exist", rel_path));
    }
    let path_to_open = if target.is_file() {
        // Open the parent directory with the file highlighted where possible.
        target.parent().unwrap_or(&target).to_path_buf()
    } else {
        target
    };
    open::that(&path_to_open)
        .map_err(|e| format!("failed to open '{}': {e}", path_to_open.display()))
}

/// Copies one or more files from absolute source paths into a target directory
/// inside an instance's working directory. Used for drag-and-drop from the OS
/// file manager — the frontend passes the dropped file paths here.
#[tauri::command]
pub fn copy_files_to_server(
    app_handle: AppHandle,
    id: String,
    source_paths: Vec<String>,
    target_rel_path: String,
) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let target_dir = resolve_path(&instance.path, &target_rel_path)?;

    for source in &source_paths {
        let source_path = std::path::Path::new(source);
        if !source_path.exists() {
            return Err(format!("source path '{}' does not exist", source));
        }
        let file_name = source_path
            .file_name()
            .ok_or_else(|| format!("invalid source path: {}", source))?;
        let dest = target_dir.join(file_name);

        std::fs::copy(source_path, &dest)
            .map_err(|e| format!("failed to copy '{}': {}", source, e))?;
    }
    Ok(())
}

/// Lists every installed community plugin (manifest), sorted by id.
#[tauri::command]
pub fn list_plugins(app_handle: AppHandle) -> Result<Vec<manifest::Manifest>, String> {
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    Ok(manifest::discover(&plugins_dir))
}

/// Loads a single plugin manifest by id.
#[tauri::command]
pub fn get_plugin(
    app_handle: AppHandle,
    id: String,
) -> Result<manifest::Manifest, String> {
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    manifest::load_by_id(&plugins_dir, &id)
}

/// Returns the absolute path to a plugin's UI entry bundle, if the plugin
/// declares one. Used by the frontend to build an asset:// URL for Shadow DOM
/// mounting (ArchitecturePlan §4, PluginWrapper).
#[tauri::command]
pub fn get_plugin_ui_path(app_handle: AppHandle, id: String) -> Result<Option<String>, String> {
    paths::validate_plugin_id(&id)?;
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    let plugin_dir = plugins_dir.join(&id);
    let manifest = manifest::load_by_id(&plugins_dir, &id)?;
    match manifest.ui_entry {
        Some(entry) if !entry.is_empty() => {
            // The UI bundle path comes from the manifest and must stay inside
            // the plugin directory — `uiEntry: "../../evil.js"` would
            // otherwise be import()ed by the host webview.
            let ui_path = paths::safe_join(&plugin_dir, &entry)
                .map_err(|e| format!("plugin '{id}' has an unsafe uiEntry '{entry}': {e}"))?;
            Ok(Some(ui_path.to_string_lossy().to_string()))
        }
        _ => Ok(None),
    }
}

/// Copies a plugin directory (containing manifest.json) into the host's
/// plugin directory at `<app_data>/plugins/<id>/`.
///
/// The `source_path` should point at the plugin directory (or any file within
/// it — the parent directory is used). Returns the installed manifest on
/// success, or an error if the manifest is missing/invalid or a plugin with
/// the same id is already installed.
#[tauri::command]
pub fn install_plugin(
    app_handle: AppHandle,
    source_path: String,
) -> Result<manifest::Manifest, String> {
    let src = std::path::Path::new(&source_path);
    // If the user picked a file (manifest.json), use its parent directory.
    let plugin_dir = if src.is_file() {
        src.parent().ok_or_else(|| "could not resolve plugin directory".to_string())?
    } else {
        src
    };

    // Validate the manifest before copying anything.
    let manifest_path = plugin_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!(
            "'{}' does not contain a manifest.json",
            plugin_dir.display()
        ));
    }
    let manifest = manifest::load(&manifest_path)?;
    manifest::validate_installable(&manifest)?;

    // Check for id collision.
    let base = config::config_dir(&app_handle)?;
    let plugins_target = manifest::plugins_dir(&base);
    let target = plugins_target.join(&manifest.id);
    if target.exists() {
        return Err(format!(
            "plugin '{}' is already installed — uninstall it first",
            manifest.id
        ));
    }

    // Copy the entire plugin directory into the target.
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("failed to create plugin directory: {e}"))?;
    copy_dir_recursive(plugin_dir, &target).map_err(|e| {
        // Best-effort cleanup on failure.
        let _ = std::fs::remove_dir_all(&target);
        format!("failed to copy plugin directory: {e}")
    })?;

    crate::audit::record(
        &app_handle,
        "plugin-install",
        &format!("installed plugin '{}' v{}", manifest.id, manifest.version),
        None,
    );
    Ok(manifest)
}

/// Recursively copies a directory tree. Used here for plugin installation
/// instead of pulling a crate for this one-shot operation.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let from = entry.path();
            let to = dst.join(entry.file_name());
            let file_type = entry.file_type()?;
            // Never follow symlinks: a plugin source directory could otherwise
            // pull arbitrary files (SSH keys, browser data) into the plugin.
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                copy_dir_recursive(&from, &to)?;
            } else {
                std::fs::copy(&from, &to)?;
            }
        }
    }
    Ok(())
}

/// Removes an installed plugin by id from the host's plugin directory.
///
/// Returns an error if the plugin is not found, or if any registered server
/// instance still references it. The caller should confirm before calling.
///
/// If `upgrade` is true and the plugin exists, it will be removed to allow
/// a fresh install (used by .kern package upgrades).
#[tauri::command]
pub fn uninstall_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    // The id becomes a directory name — reject traversal before any FS access
    // (a malicious plugin could otherwise invoke `uninstall_plugin` with
    // `id: ".."` and recursively delete `<app_data>`).
    paths::validate_plugin_id(&id)?;
    let base = config::config_dir(&app_handle)?;
    let plugins_dir = manifest::plugins_dir(&base);
    let target = plugins_dir.join(&id);

    if !target.exists() {
        return Err(format!("plugin '{id}' is not installed"));
    }

    // Check for server instances that depend on this plugin.
    let cfg = config::load_config(&app_handle)?;
    let dependents: Vec<&str> = cfg
        .servers
        .values()
        .filter(|s| s.server_type == id)
        .map(|s| s.name.as_str())
        .collect();
    if !dependents.is_empty() {
        return Err(format!(
            "cannot uninstall '{id}' — {} server instance(s) still reference it: {}",
            dependents.len(),
            dependents.join(", ")
        ));
    }

    std::fs::remove_dir_all(&target)
        .map_err(|e| format!("failed to remove plugin '{id}': {e}"))?;
    // Drop the plugin's private key-value store too.
    crate::plugin_kv::clear_plugin_data(&app_handle, &id);
    crate::audit::record(
        &app_handle,
        "plugin-uninstall",
        &format!("uninstalled plugin '{id}'"),
        None,
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// .kern file support (plugin packages)
// ---------------------------------------------------------------------------

/// Validates a .kern file and returns its manifest without installing.
/// Used to preview plugin info before installation.
#[tauri::command]
pub fn validate_kern_file(path: String) -> Result<manifest::Manifest, String> {
    let p = std::path::Path::new(&path);

    // Check file extension
    if p.extension().and_then(|e| e.to_str()) != Some("kern") {
        return Err(format!(
            "file '{}' is not a .kern file",
            p.display()
        ));
    }

    if !p.exists() {
        return Err(format!("file '{}' does not exist", p.display()));
    }

    // Extract manifest from the .kern (zip) archive to a temp directory
    let temp_dir = tempfile::tempdir()
        .map_err(|e| format!("failed to create temp directory: {e}"))?;

    extract_kern_archive(p, temp_dir.path())?;

    // Load and validate manifest
    let manifest_path = temp_dir.path().join("manifest.json");
    if !manifest_path.exists() {
        return Err("plugin package does not contain a manifest.json".to_string());
    }

    manifest::load(&manifest_path)
}

/// Installs a plugin from a .kern file.
/// If a plugin with the same id exists, sets `force` to true to upgrade/reinstall.
#[tauri::command]
pub fn install_plugin_from_kern(
    app_handle: AppHandle,
    source_path: String,
    force: bool,
) -> Result<manifest::Manifest, String> {
    let p = std::path::Path::new(&source_path);

    // Validate it's a .kern file
    if p.extension().and_then(|e| e.to_str()) != Some("kern") {
        return Err(format!(
            "file '{}' is not a .kern file",
            p.display()
        ));
    }

    if !p.exists() {
        return Err(format!("file '{}' does not exist", p.display()));
    }

    // Extract to temp directory
    let temp_dir = tempfile::tempdir()
        .map_err(|e| format!("failed to create temp directory: {e}"))?;

    extract_kern_archive(p, temp_dir.path())?;

    // Load and validate manifest
    let manifest_path = temp_dir.path().join("manifest.json");
    if !manifest_path.exists() {
        return Err("plugin package does not contain a manifest.json".to_string());
    }
    let manifest = manifest::load(&manifest_path)?;
    manifest::validate_installable(&manifest)?;

    let base = config::config_dir(&app_handle)?;
    let plugins_target = manifest::plugins_dir(&base);
    let target = plugins_target.join(&manifest.id);

    // Check for existing plugin - upgrade if force is true
    if target.exists() && !force {
        return Err(format!(
            "plugin '{}' is already installed — uninstall it first or use force=true to upgrade",
            manifest.id
        ));
    }

    // Stage the new copy next to the plugins dir (same volume, not scanned by
    // `discover`), then swap it in. Unlike a remove-then-copy this cannot leave
    // the user without a working plugin if the copy fails half-way.
    let staging = base.join(format!(".kern-staging-{}", manifest.id));
    let backup = base.join(format!(".kern-backup-{}", manifest.id));
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(e) = copy_dir_recursive(temp_dir.path(), &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("failed to stage plugin directory: {e}"));
    }

    if target.exists() {
        let _ = std::fs::remove_dir_all(&backup);
        if let Err(e) = std::fs::rename(&target, &backup) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!(
                "failed to move existing plugin '{}' aside: {e}",
                manifest.id
            ));
        }
    }

    if let Err(e) = std::fs::rename(&staging, &target) {
        // Roll the previous version back so the plugin never disappears.
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("failed to install plugin '{}': {e}", manifest.id));
    }
    let _ = std::fs::remove_dir_all(&backup);

    Ok(manifest)
}

/// Creates a .kern package from a plugin directory.
/// Useful for plugin developers to package their plugins.
#[tauri::command]
pub fn create_plugin_package(
    source_path: String,
    output_path: Option<String>,
) -> Result<String, String> {
    let p = std::path::Path::new(&source_path);

    // Validate source directory exists
    if !p.is_dir() {
        return Err(format!(
            "source path '{}' is not a directory",
            p.display()
        ));
    }

    // Validate manifest exists in source
    let manifest_path = p.join("manifest.json");
    if !manifest_path.exists() {
        return Err(format!(
            "source directory '{}' does not contain a manifest.json",
            p.display()
        ));
    }

    // Determine output path
    let output = match output_path {
        Some(op) => std::path::Path::new(&op).to_path_buf(),
        None => {
            // Use source directory with .kern extension
            // Name: <plugin-id>.kern (no version in filename)
            let manifest: manifest::Manifest = manifest::load(&manifest_path)?;
            p.join(format!("{}.kern", manifest.id))
        }
    };

    // Create the zip archive
    let file = std::fs::File::create(&output)
        .map_err(|e| format!("failed to create output file: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut buffer = Vec::new();
    add_dir_to_zip(&mut zip, p, p, &mut buffer, options)
        .map_err(|e| format!("failed to create package: {e}"))?;

    zip.finish()
        .map_err(|e| format!("failed to finalize package: {e}"))?;

    Ok(output.to_string_lossy().to_string())
}

/// Recursively adds a directory to a zip archive.
fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    base: &std::path::Path,
    current: &std::path::Path,
    buffer: &mut Vec<u8>,
    options: zip::write::FileOptions<()>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(current)
        .map_err(|e| e.to_string())?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path.strip_prefix(base).unwrap_or(&path);

        if path.is_dir() {
            zip.add_directory(relative.to_string_lossy(), options)
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, base, &path, buffer, options)?;
        } else {
            zip.start_file(relative.to_string_lossy(), options)
                .map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(&path)
                .map_err(|e| e.to_string())?;
            f.read_to_end(buffer)
                .map_err(|e| e.to_string())?;
            zip.write_all(buffer)
                .map_err(|e| e.to_string())?;
            buffer.clear();
        }
    }
    Ok(())
}

/// Maximum uncompressed size of a single .kern archive entry (64 MiB).
/// Plugin bundles are small; a larger entry is either a mistake or a zip bomb.
const MAX_KERN_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

/// Extracts a .kern (zip) archive to the specified destination.
fn extract_kern_archive(archive_path: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    use std::io::Read;

    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("failed to open .kern file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("invalid .kern archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("failed to read archive entry: {e}"))?;

        // Zip-slip guard: enclosed_name() returns None for paths that would
        // escape `dst` (e.g. "../../Startup/foo.bat"). A malicious .kern
        // could otherwise write anywhere on disk — and .kern files are
        // installable via double-click/deep-link, so this is reachable by an
        // attacker. Reject such entries outright.
        let Some(safe_name) = entry.enclosed_name() else {
            return Err(format!(
                "archive entry '{}' is unsafe (path traversal) — refusing to extract",
                entry.name()
            ));
        };
        // Defense in depth: the lexical normaliser must also accept the name.
        paths::normalize_relative(&entry.name().replace('\\', "/")).map_err(|_| {
            format!(
                "archive entry '{}' is unsafe (path traversal) — refusing to extract",
                entry.name()
            )
        })?;
        let outpath = dst.join(safe_name);

        if entry.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("failed to create directory: {e}"))?;
        } else {
            if entry.size() > MAX_KERN_ENTRY_BYTES {
                return Err(format!(
                    "archive entry '{}' is too large ({} bytes) — refusing to extract",
                    entry.name(),
                    entry.size()
                ));
            }
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create parent dir: {e}"))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("failed to create file: {e}"))?;
            let written = std::io::copy(
                &mut entry.by_ref().take(MAX_KERN_ENTRY_BYTES + 1),
                &mut outfile,
            )
            .map_err(|e| format!("failed to write file: {e}"))?;
            if written > MAX_KERN_ENTRY_BYTES {
                drop(outfile);
                let _ = std::fs::remove_file(&outpath);
                return Err(format!(
                    "archive entry '{}' exceeded the size limit — refusing to extract",
                    entry.name()
                ));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// World backup & restore
// ---------------------------------------------------------------------------

/// Zips the `world/` directory (and its Nether/End variants if present) into a
/// timestamped archive under `backups/`. Returns the created archive's relative
/// path. The world is backed up live — no server stop required — but the user
/// should ideally run `save-all` first to flush chunk data to disk.
#[tauri::command]
pub async fn backup_world(app_handle: AppHandle, id: String) -> Result<String, String> {
    let handle = app_handle.clone();
    let id_owned = id.clone();
    let archive = tauri::async_runtime::spawn_blocking(move || backup_world_impl(&handle, &id_owned))
        .await
        .map_err(|e| format!("backup task failed: {e}"))??;
    crate::audit::record(
        &app_handle,
        "backup",
        &format!(
            "backed up '{}' → {archive}",
            audit_name(&app_handle, &id)
        ),
        Some(&id),
    );
    Ok(archive)
}

/// Implementation usable from non-command contexts (the scheduler thread).
/// Same behavior as the command; takes a borrowed handle + id.
pub fn backup_world_impl(app_handle: &AppHandle, id: &str) -> Result<String, String> {
    let cfg = config::load_config(app_handle)?;
    let instance = cfg
        .servers
        .get(id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let root = PathBuf::from(&instance.path);
    let world_dir = root.join("world");

    if !world_dir.exists() {
        return Err(format!(
            "no world directory found at '{}' — the server may not have been started yet",
            world_dir.display()
        ));
    }

    // Ensure the backups/ directory exists.
    let backups_dir = root.join("backups");
    std::fs::create_dir_all(&backups_dir)
        .map_err(|e| format!("failed to create backups dir: {e}"))?;

    // Disk-space guard: refuse a backup that clearly can't fit rather than
    // producing a truncated archive on a full disk. The world is measured
    // uncompressed (zip will usually be smaller) plus a safety margin.
    let world_bytes = crate::disk::dir_size_bytes(&world_dir);
    const BACKUP_HEADROOM_BYTES: u64 = 100 * 1024 * 1024;
    if let Some(free) = crate::disk::available_space_for(&backups_dir) {
        if free < world_bytes.saturating_add(BACKUP_HEADROOM_BYTES) {
            return Err(format!(
                "not enough free disk space for the backup: world is ~{} MB and only {} MB is free",
                world_bytes / (1024 * 1024),
                free / (1024 * 1024)
            ));
        }
    }

    // Timestamped archive name: world-2026-06-30T14-30-00.zip
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let archive_name = format!("world-{}.zip", timestamp);
    let archive_path = backups_dir.join(&archive_name);

    // Create the zip archive, walking the world directory tree.
    let file = std::fs::File::create(&archive_path)
        .map_err(|e| format!("failed to create archive: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut buffer = Vec::new();
    let world_prefix = world_dir.clone();

    for entry in WalkDir::new(&world_dir) {
        let entry = entry.map_err(|e| format!("walk error: {e}"))?;
        let path = entry.path();
        let relative = path
            .strip_prefix(&world_prefix)
            .map_err(|e| format!("path strip error: {e}"))?;

        if path.is_dir() {
            zip.add_directory(relative.to_string_lossy(), options)
                .map_err(|e| format!("zip add dir error: {e}"))?;
        } else {
            zip.start_file(relative.to_string_lossy(), options)
                .map_err(|e| format!("zip start file error: {e}"))?;
            let mut f = std::fs::File::open(path)
                .map_err(|e| format!("open file error: {e}"))?;
            f.read_to_end(&mut buffer)
                .map_err(|e| format!("read error: {e}"))?;
            zip.write_all(&buffer)
                .map_err(|e| format!("zip write error: {e}"))?;
            buffer.clear();
        }
    }

    zip.finish().map_err(|e| format!("zip finalize error: {e}"))?;

    Ok(format!("backups/{}", archive_name))
}

/// Lists existing world backups as { name, size } pairs, newest first.
#[tauri::command]
pub fn list_backups(app_handle: AppHandle, id: String) -> Result<Vec<serde_json::Value>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let backups_dir = PathBuf::from(&instance.path).join("backups");
    if !backups_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    for entry in std::fs::read_dir(&backups_dir)
        .map_err(|e| format!("read backups dir error: {e}"))?
    {
        let entry = entry.map_err(|e| format!("dir entry error: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push(serde_json::json!({ "name": name, "size": size }));
    }

    entries.sort_by(|a, b| {
        let a_name = a["name"].as_str().unwrap_or("");
        let b_name = b["name"].as_str().unwrap_or("");
        b_name.cmp(a_name) // newest first
    });

    Ok(entries)
}

/// Prunes old backups beyond `keep`, keeping the newest `keep` archives.
/// Used by the scheduler's rolling retention. Best-effort: logs failures.
pub fn prune_backups_impl(app_handle: &AppHandle, id: &str, keep: u32) {
    let Ok(cfg) = config::load_config(app_handle) else {
        return;
    };
    let Some(instance) = cfg.servers.get(id) else {
        return;
    };
    let backups_dir = PathBuf::from(&instance.path).join("backups");
    let Ok(entries) = std::fs::read_dir(&backups_dir) else {
        return;
    };
    // Collect zip names, newest first (epoch-second names sort monotonically).
    let mut zips: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("zip"))
        .collect();
    zips.sort_by(|a, b| b.cmp(a));
    for old in zips.into_iter().skip(keep as usize) {
        if let Err(e) = std::fs::remove_file(&old) {
            eprintln!("[backup] failed to prune '{}': {e}", old.display());
        }
    }
}

/// Restores a world from a backup archive. Backs up the current world first
/// (safety copy), then replaces `world/` contents with the archive's contents.
#[tauri::command]
pub async fn restore_world(
    app_handle: AppHandle,
    id: String,
    backup_name: String,
) -> Result<(), String> {
    let handle = app_handle.clone();
    let id_owned = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        restore_world_blocking(handle, id_owned, backup_name)
    })
    .await
    .map_err(|e| format!("restore task failed: {e}"))??;
    crate::audit::record(
        &app_handle,
        "restore",
        &format!("restored world for '{}'", audit_name(&app_handle, &id)),
        Some(&id),
    );
    Ok(())
}

fn restore_world_blocking(
    app_handle: AppHandle,
    id: String,
    backup_name: String,
) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let root = PathBuf::from(&instance.path);
    let backups_dir = root.join("backups");
    // `backup_name` is user-supplied — it must be a bare file name, otherwise
    // `join` would happily take `../../anything` or an absolute path.
    let backup_file = paths::safe_file_name(&backup_name)?;
    let archive_path = backups_dir.join(backup_file);

    if !archive_path.exists() {
        return Err(format!("backup '{}' not found", backup_name));
    }

    let world_dir = root.join("world");

    // Safety: if a current world exists, create a pre-restore snapshot first.
    if world_dir.exists() {
        let safety_name = format!(
            "pre-restore-{}.zip",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        );
        let safety_path = backups_dir.join(&safety_name);

        let file = std::fs::File::create(&safety_path)
            .map_err(|e| format!("failed to create safety backup: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut buffer = Vec::new();

        for entry in WalkDir::new(&world_dir) {
            let entry = entry.map_err(|e| format!("walk error: {e}"))?;
            let path = entry.path();
            let relative = path.strip_prefix(&world_dir).unwrap();
            if path.is_dir() {
                zip.add_directory(relative.to_string_lossy(), options)
                    .map_err(|e| format!("zip error: {e}"))?;
            } else {
                zip.start_file(relative.to_string_lossy(), options)
                    .map_err(|e| format!("zip error: {e}"))?;
                let mut f = std::fs::File::open(path).map_err(|e| format!("read error: {e}"))?;
                    f.read_to_end(&mut buffer).map_err(|e| format!("read error: {e}"))?;
                zip.write_all(&buffer).map_err(|e| format!("zip error: {e}"))?;
                buffer.clear();
            }
        }
        zip.finish().map_err(|e| format!("zip error: {e}"))?;

        // Remove the old world directory.
        std::fs::remove_dir_all(&world_dir)
            .map_err(|e| format!("failed to remove old world: {e}"))?;
    }

    // Extract the archive into a fresh world/ directory.
    std::fs::create_dir_all(&world_dir)
        .map_err(|e| format!("failed to create world dir: {e}"))?;

    let archive_file = std::fs::File::open(&archive_path)
        .map_err(|e| format!("failed to open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|e| format!("failed to read archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("archive error: {e}"))?;

        // Zip-slip guard (same as extract_kern_archive): a backup entry whose
        // path escapes world/ is rejected rather than written outside it.
        let Some(safe_name) = file.enclosed_name() else {
            return Err(format!(
                "backup entry '{}' is unsafe (path traversal) — refusing to restore",
                file.name()
            ));
        };
        paths::normalize_relative(&file.name().replace('\\', "/")).map_err(|_| {
            format!(
                "backup entry '{}' is unsafe (path traversal) — refusing to restore",
                file.name()
            )
        })?;
        let outpath = world_dir.join(safe_name);

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("mkdir error: {e}"))?;
        } else {
            if file.size() > MAX_KERN_ENTRY_BYTES {
                return Err(format!(
                    "backup entry '{}' is too large ({} bytes) — refusing to restore",
                    file.name(),
                    file.size()
                ));
            }
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir error: {e}"))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("create file error: {e}"))?;
            let written = std::io::copy(
                &mut file.by_ref().take(MAX_KERN_ENTRY_BYTES + 1),
                &mut outfile,
            )
            .map_err(|e| format!("write error: {e}"))?;
            if written > MAX_KERN_ENTRY_BYTES {
                drop(outfile);
                let _ = std::fs::remove_file(&outpath);
                return Err(format!(
                    "backup entry '{}' exceeded the size limit — refusing to restore",
                    file.name()
                ));
            }
        }
    }

    Ok(())
}

/// Deletes a backup archive from disk.
#[tauri::command]
pub fn delete_backup(
    app_handle: AppHandle,
    id: String,
    backup_name: String,
) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let backup_file = paths::safe_file_name(&backup_name)?;
    let archive_path = PathBuf::from(&instance.path)
        .join("backups")
        .join(backup_file);

    if !archive_path.exists() {
        return Err(format!("backup '{}' not found", backup_name));
    }

    std::fs::remove_file(&archive_path)
        .map_err(|e| format!("failed to delete backup: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Backup scheduling + health alerts + metrics history + energy
// ---------------------------------------------------------------------------

/// Updates an instance's backup schedule (interval / retention / on-stop).
#[tauri::command]
pub fn update_backup_schedule(
    app_handle: AppHandle,
    id: String,
    schedule: config::BackupSchedule,
) -> Result<(), String> {
    config::with_config_mut(&app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(&id) {
            instance.backup_schedule = schedule;
        }
        Ok(())
    })
}

/// Updates an instance's scheduled tasks, preserving host-managed last-run
/// stamps for tasks that kept their id.
#[tauri::command]
pub fn update_server_tasks(
    app_handle: AppHandle,
    id: String,
    tasks: Vec<config::ScheduledTask>,
) -> Result<(), String> {
    config::with_config_mut(&app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(&id) {
            let last_runs: HashMap<String, u64> = instance
                .tasks
                .iter()
                .map(|t| (t.id.clone(), t.last_run_secs))
                .collect();
            instance.tasks = tasks
                .into_iter()
                .map(|mut t| {
                    if let Some(prev) = last_runs.get(&t.id) {
                        t.last_run_secs = *prev;
                    }
                    t
                })
                .collect();
        }
        Ok(())
    })
}

/// Updates an instance's health-alert thresholds.
#[tauri::command]
pub fn update_alert_rules(
    app_handle: AppHandle,
    id: String,
    rules: config::AlertRules,
) -> Result<(), String> {
    config::with_config_mut(&app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(&id) {
            // Preserve the internal `crossed_since_secs` tracking field —
            // don't let a UI save clobber the alert timer mid-flight.
            let prev = instance.alert_rules.crossed_since_secs;
            let mut r = rules;
            r.crossed_since_secs = prev;
            instance.alert_rules = r;
        }
        Ok(())
    })
}

/// Returns historical metric samples for an instance within the window.
/// `window_secs` e.g. 86400 = last 24h, 604800 = last 7d.
#[tauri::command]
pub fn get_metrics_history(
    app_handle: AppHandle,
    id: String,
    window_secs: u64,
) -> Result<Vec<MetricSample>, String> {
    let history: tauri::State<'_, MetricsHistory> = app_handle.state();
    Ok(history.query(&id, window_secs))
}

/// Estimates the energy cost of an instance over its running lifetime.
///
/// Cost = (avg_cpu_fraction × machine_watts × hours_running × price_per_kwh) / 1000.
/// Idle baseline is ~30% of machine watts; load scales with CPU. Rough but
/// useful — the number that justifies (or kills) the homelab.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyCost {
    pub id: String,
    /// Hours the instance has been observed running (from uptime tracking).
    /// Falls back to an estimate from logs if unavailable.
    pub hours: f64,
    pub est_watts: f64,
    pub cost: f64,
    pub currency_note: String,
}

#[tauri::command]
pub fn get_instance_energy(
    app_handle: AppHandle,
    id: String,
) -> Result<EnergyCost, String> {
    let cfg = config::load_config(&app_handle)?;
    let price = cfg.settings.power_price_per_kwh;
    let watts = cfg.settings.machine_watts;

    // Estimate running hours from latest.log mtime (rough proxy): if the log
    // is recent, assume running since the file's creation window. Absent a
    // real uptime counter, use the log file's age capped to a sane max.
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let log_path = PathBuf::from(&instance.path).join("latest.log");
    let hours = estimate_running_hours(&log_path);

    // Approximate draw: idle floor 30% + CPU-scaled 70%. We don't have a live
    // cpu reading here cheaply, so assume a blended 50% load for the estimate.
    let est_watts = watts * (0.3 + 0.7 * 0.5);
    let kwh = (est_watts * hours) / 1000.0;
    let cost = kwh * price;

    Ok(EnergyCost {
        id,
        hours,
        est_watts,
        cost,
        currency_note: "cost uses your local price/kWh from settings".to_string(),
    })
}

/// Rough running-hours estimate from a log file's mtime. Caps at 720h (30d)
/// so a stale ancient log doesn't inflate the figure absurdly.
fn estimate_running_hours(log_path: &std::path::Path) -> f64 {
    let Ok(meta) = std::fs::metadata(log_path) else {
        return 0.0;
    };
    let Some(mtime) = meta.modified().ok() else {
        return 0.0;
    };
    let age_secs = SystemTime::now()
        .duration_since(mtime)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // If the log was touched in the last hour, assume recently active; use the
    // file size as a crude activity proxy (1KB ≈ ~6 min of typical logging).
    let size_kb = meta.len() as f64 / 1024.0;
    let from_size = (size_kb * 0.1).min(720.0); // ~6min/KB, cap 720h
    if age_secs < 3600 {
        from_size.max(1.0)
    } else {
        from_size
    }
}

/// Updates an instance's saved command snippets (pinned terminal buttons).
#[tauri::command]
pub fn update_command_snippets(
    app_handle: AppHandle,
    id: String,
    snippets: Vec<String>,
) -> Result<(), String> {
    config::with_config_mut(&app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(&id) {
            instance.command_snippets = snippets;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Smart JAR detection
// ---------------------------------------------------------------------------

/// Result of server JAR auto-detection.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JarDetectionResult {
    /// The filename that was found (or the user-specified one).
    pub detected_jar: Option<String>,
    /// Whether the resolved file actually exists on disk.
    pub exists: bool,
    /// All candidate filenames that were checked, in priority order.
    pub candidates: Vec<String>,
    /// Human-readable explanation of what happened.
    pub message: String,
}

/// Detects which server JAR (or launch script) exists in the instance directory.
///
/// Priority order:
///   1. User-specified `server_jar` override (if non-empty)
///   2. `server.jar` — produced by Vanilla, Paper, Purpur
///   3. `fabric-server-launch.jar` — Fabric
///   4. `quilt-server-launcher.jar` — Quilt
///   5. `run.sh` / `run.bat` — Forge / NeoForge generated scripts
///   6. Any `*.jar` in the root (excluding installer/library jars)
///
/// Returns a structured result so the frontend can display status without
/// needing to duplicate the detection logic.
#[tauri::command]
pub fn detect_server_jar(app_handle: AppHandle, id: String) -> Result<JarDetectionResult, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;

    let root = std::path::Path::new(&instance.path);
    let runtime = instance.user_overrides.get("runtime").map(String::as_str).unwrap_or("purpur");

    // If the user explicitly set a jar name, just check that one.
    if let Some(custom) = instance.user_overrides.get("server_jar") {
        let custom = custom.trim();
        if !custom.is_empty() {
            let exists = root.join(custom).exists();
            return Ok(JarDetectionResult {
                detected_jar: Some(custom.to_string()),
                exists,
                candidates: vec![custom.to_string()],
                message: if exists {
                    format!("Using custom JAR: {custom}")
                } else {
                    format!("Custom JAR not found: {custom}")
                },
            });
        }
    }

    // Build the candidate list based on runtime.
    let mut candidates: Vec<String> = vec!["server.jar".to_string()];
    match runtime {
        "fabric" => candidates.push("fabric-server-launch.jar".to_string()),
        "quilt" => candidates.push("quilt-server-launcher.jar".to_string()),
        "forge" | "neoforge" => {
            // Forge/NeoForge don't use -jar; they use generated run scripts.
            #[cfg(target_os = "windows")]
            {
                candidates.push("kern_start.bat".to_string());
                candidates.push("run.bat".to_string());
                candidates.push("start.bat".to_string());
            }
            #[cfg(not(target_os = "windows"))]
            {
                candidates.push("kern_start.sh".to_string());
                candidates.push("run.sh".to_string());
                candidates.push("start.sh".to_string());
            }
        }
        _ => {
            // Vanilla/Paper/Purpur already have server.jar; add common alternatives.
        }
    }

    // Check each candidate in order.
    for name in &candidates {
        if root.join(name).exists() {
            let found = name.clone();
            return Ok(JarDetectionResult {
                detected_jar: Some(found.clone()),
                exists: true,
                candidates,
                message: format!("Found: {found}"),
            });
        }
    }

    // Final fallback: scan for any *.jar (excluding installers and libraries).
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut fallbacks: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jar") {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                // Skip installer jars and anything in subdirectories.
                if name.ends_with("-installer.jar")
                    || name.ends_with("-libraries.jar")
                    || name.contains("installer")
                {
                    continue;
                }
                fallbacks.push(name);
            }
        }
        // Sort alphabetically so the result is deterministic.
        fallbacks.sort();
        if let Some(first) = fallbacks.first() {
            candidates.push(first.clone());
            return Ok(JarDetectionResult {
                detected_jar: Some(first.clone()),
                exists: true,
                candidates,
                message: format!("Found: {first}"),
            });
        }
    }

    Ok(JarDetectionResult {
        detected_jar: None,
        exists: false,
        candidates,
        message: "No server JAR found. Run 'install' first, or set a custom JAR name in settings.".to_string(),
    })
}
// ---------------------------------------------------------------------------
// File search
// ---------------------------------------------------------------------------

/// Check if a path matches a simple glob pattern (supports * wildcard).
fn glob_match(path: &str, pattern: &str) -> bool {
    if pattern == "*" { return true; }
    // Simple implementation: if pattern contains *, check if path contains the non-star parts
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        // No wildcard, do exact match
        return path.contains(parts[0]);
    }
    // Check if all parts exist in order
    let mut pos = 0;
    for part in parts {
        if part.is_empty() { continue; }
        if let Some(idx) = path[pos..].find(part) {
            pos += idx + part.len();
        } else {
            return false;
        }
    }
    true
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub rel_path: String,
    pub line_number: Option<u32>,
    pub line_preview: Option<String>,
}

#[tauri::command]
pub async fn search_files(
    app_handle: AppHandle,
    id: String,
    query: String,
    mode: String,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<SearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_files_blocking(app_handle, id, query, mode, include, exclude)
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?
}

fn search_files_blocking(
    app_handle: AppHandle,
    id: String,
    query: String,
    mode: String,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<SearchMatch>, String> {
    // Bounded to keep the (synchronous) command responsive and memory-safe:
    //   - MAX_RESULTS: stop once we have enough hits for a useful preview.
    //   - MAX_DEPTH: don't descend into arbitrarily deep nested trees.
    //   - MAX_CONTENT_BYTES: skip files larger than this when reading content
    //     (avoids slurping multi-GB logs/jars into a String).
    const MAX_RESULTS: usize = 1000;
    const MAX_DEPTH: usize = 15;
    const MAX_CONTENT_BYTES: u64 = 1024 * 1024; // 1 MiB

    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{}' not found", id))?;
    let root = std::path::Path::new(&instance.path);
    let include_pattern = include.as_deref().unwrap_or("*");
    let exclude_patterns: Vec<&str> = exclude
        .as_deref()
        .map(|e| e.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let mut results: Vec<SearchMatch> = Vec::new();
    let query_lower = query.to_lowercase();
    for entry in WalkDir::new(root).max_depth(MAX_DEPTH).into_iter().filter_map(|e| e.ok()) {
        // Stop early once we have enough — a huge repo shouldn't keep scanning.
        if results.len() >= MAX_RESULTS { break; }
        let path = entry.path();
        if !path.is_file() { continue; }
        let rel_path = path.strip_prefix(root)
            .map(|p| p.to_string_lossy().replace("\\", "/"))
            .unwrap_or_default();
        let path_lower = rel_path.to_lowercase();
        if !glob_match(&path_lower, include_pattern) { continue; }
        if exclude_patterns.iter().any(|p| glob_match(&path_lower, p)) { continue; }
        if (mode == "filenames" || mode == "both")
            && path_lower.contains(&query_lower)
                && !results.iter().any(|r| r.rel_path == rel_path) {
                    results.push(SearchMatch { rel_path: rel_path.clone(), line_number: None, line_preview: None });
                }
        if mode == "contents" || mode == "both" {
            // Skip oversized files — reading a multi-GB log into a String would
            // stall the command pool and risk OOM.
            let size_ok = std::fs::metadata(path).map(|m| m.len() <= MAX_CONTENT_BYTES).unwrap_or(false);
            if !size_ok { continue; }
            if let Ok(content) = std::fs::read_to_string(path) {
                let mut line_num: u32 = 1;
                for line in content.lines() {
                    if results.len() >= MAX_RESULTS { break; }
                    if line.to_lowercase().contains(&query_lower) {
                        // Truncate by *char* boundary, not byte index — slicing a
                        // &str at an arbitrary byte can split a multibyte UTF-8
                        // sequence and panic. take(197) is always char-safe.
                        let preview: String = if line.chars().count() > 200 {
                            let mut s: String = line.chars().take(197).collect();
                            s.push_str("...");
                            s
                        } else {
                            line.to_string()
                        };
                        if !results.iter().any(|r| r.rel_path == rel_path && r.line_number == Some(line_num)) {
                            results.push(SearchMatch { rel_path: rel_path.clone(), line_number: Some(line_num), line_preview: Some(preview) });
                        }
                    }
                    line_num = line_num.saturating_add(1);
                }
            }
        }
    }
    Ok(results)
}

/// Result of a find-and-replace-across-files operation.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: u32,
    pub replacements: u32,
}

/// Finds `query` across the instance's files (content mode) and replaces each
/// occurrence with `replacement`. Respects the same size/depth caps as search
/// so a giant file can't stall it. Returns the count of files changed and
/// total replacements. Case-sensitive.
#[tauri::command]
pub async fn find_replace_in_files(
    app_handle: AppHandle,
    id: String,
    query: String,
    replacement: String,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<ReplaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        find_replace_in_files_blocking(app_handle, id, query, replacement, include, exclude)
    })
    .await
    .map_err(|e| format!("replace task failed: {e}"))?
}

fn find_replace_in_files_blocking(
    app_handle: AppHandle,
    id: String,
    query: String,
    replacement: String,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<ReplaceResult, String> {
    const MAX_DEPTH: usize = 15;
    const MAX_CONTENT_BYTES: u64 = 1024 * 1024; // 1 MiB
    const MAX_FILES: u32 = 500;

    if query.is_empty() {
        return Err("query must not be empty".to_string());
    }
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let root = std::path::Path::new(&instance.path);
    let include_pattern = include.as_deref().unwrap_or("*");
    let exclude_patterns: Vec<&str> = exclude
        .as_deref()
        .map(|e| e.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    let mut files_changed = 0u32;
    let mut replacements = 0u32;

    for entry in WalkDir::new(root).max_depth(MAX_DEPTH).into_iter().filter_map(|e| e.ok()) {
        if files_changed >= MAX_FILES {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let rel_path = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace("\\", "/"))
            .unwrap_or_default();
        let path_lower = rel_path.to_lowercase();
        if !glob_match(&path_lower, include_pattern) {
            continue;
        }
        if exclude_patterns.iter().any(|p| glob_match(&path_lower, p)) {
            continue;
        }
        let size_ok = std::fs::metadata(path).map(|m| m.len() <= MAX_CONTENT_BYTES).unwrap_or(false);
        if !size_ok {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        if !content.contains(&query) {
            continue;
        }
        let count = content.matches(&query).count() as u32;
        let next = content.replace(&query, &replacement);
        if std::fs::write(path, next).is_ok() {
            files_changed += 1;
            replacements += count;
        }
    }

    Ok(ReplaceResult {
        files_changed,
        replacements,
    })
}

#[tauri::command]
pub fn get_file_from_backup(
    app_handle: AppHandle,
    id: String,
    backup_name: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg.servers.get(&id).ok_or_else(|| format!("server '{}' not found", id))?;
    let backup_file = paths::safe_file_name(&backup_name)?;
    let backup_path = std::path::PathBuf::from(&instance.path).join("backups").join(backup_file);
    if !backup_path.exists() { return Err(format!("backup '{}' not found", backup_name)); }
    let file = std::fs::File::open(&backup_path).map_err(|e| format!("failed to open backup: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("invalid backup archive: {}", e))?;
    let entry_name = rel_path.replace("\\", "/");
    let mut found = None;
    for i in 0..archive.len() {
        if let Ok(f) = archive.by_index(i) {
            let name = f.name().replace("\\", "/");
            if name == entry_name { found = Some(i); break; }
        }
    }
    let index = match found { Some(i) => i, None => return Ok(None) };
    let mut file = archive.by_index(index).map_err(|e| format!("failed to read archive entry: {}", e))?;
    let mut content = String::new();
    std::io::Read::read_to_string(&mut file, &mut content).map_err(|e| format!("failed to read file from backup: {}", e))?;
    Ok(Some(content))
}

#[tauri::command]
pub async fn read_file_bytes(app_handle: AppHandle, id: String, rel_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_bytes_blocking(app_handle, id, rel_path))
        .await
        .map_err(|e| format!("read task failed: {e}"))?
}

fn read_file_bytes_blocking(app_handle: AppHandle, id: String, rel_path: String) -> Result<String, String> {
    let cfg = config::load_config(&app_handle)?;
    let instance = cfg.servers.get(&id).ok_or_else(|| format!("server '{}' not found", id))?;
    let target = resolve_path(&instance.path, &rel_path)?;
    if !target.is_file() { return Err(format!("'{}' is not a file or does not exist", rel_path)); }
    let bytes = std::fs::read(&target).map_err(|e| format!("failed to read '{}': {}", rel_path, e))?;
    Ok(base64_encode(&bytes))
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i] as usize;
        if i + 1 >= bytes.len() {
            result.push(ALPHABET[b0 >> 2] as char);
            result.push(ALPHABET[(b0 & 0x3) << 4] as char);
            result.push('=');
            result.push('=');
        } else if i + 2 >= bytes.len() {
            let b1 = bytes[i + 1] as usize;
            result.push(ALPHABET[b0 >> 2] as char);
            result.push(ALPHABET[((b0 & 0x3) << 4) | (b1 >> 4)] as char);
            result.push(ALPHABET[(b1 & 0xf) << 2] as char);
            result.push('=');
        } else {
            let b1 = bytes[i + 1] as usize;
            let b2 = bytes[i + 2] as usize;
            result.push(ALPHABET[b0 >> 2] as char);
            result.push(ALPHABET[((b0 & 0x3) << 4) | (b1 >> 4)] as char);
            result.push(ALPHABET[((b1 & 0xf) << 2) | (b2 >> 6)] as char);
            result.push(ALPHABET[b2 & 0x3f] as char);
        }
        i += 3;
    }
    result
}

#[cfg(test)]
mod listening_socket_tests {
    use super::{extract_pid, extract_port, parse_listening};

    #[test]
    fn parses_windows_netstat_local_port_not_foreign() {
        // Regression: the foreign address column used to win, reporting port 0.
        let line = "  tcp        0.0.0.0:25565          0.0.0.0:0              listening       1234";
        assert_eq!(extract_port(line), Some(25565));
        assert_eq!(extract_pid(line), Some(1234));
    }

    #[test]
    fn parses_ss_style_line() {
        let line = "listen 0 4096 0.0.0.0:25565 0.0.0.0:* users:((\"java\",pid=1234,fd=70))";
        assert_eq!(extract_port(line), Some(25565));
        assert_eq!(extract_pid(line), Some(1234));
    }

    #[test]
    fn parses_lsof_style_line() {
        let line = "java 1234 user 123u ipv6 0x1234 0t0 tcp *:25565 (listen)";
        assert_eq!(extract_port(line), Some(25565));
        assert_eq!(extract_pid(line), Some(1234));
    }

    #[test]
    fn parses_ipv6_local_address() {
        let line = "tcp [::]:7440 [::]:0 listening 42";
        assert_eq!(extract_port(line), Some(7440));
    }

    #[test]
    fn ignores_non_listening_rows() {
        let rows = parse_listening("tcp 0.0.0.0:25565 0.0.0.0:0 established 1");
        assert!(rows.is_empty());
    }

    #[test]
    fn port_conflicts_ignore_the_instances_own_tree() {
        use super::find_port_conflicts;
        use std::collections::HashSet;

        let listening = vec![(100, 25565u16), (200, 8080u16), (300, 25575u16)];
        let own: HashSet<u32> = [100].into_iter().collect();
        let conflicts = find_port_conflicts(&[25565, 8080, 25575, 9999], &listening, &own);
        // 25565 is ours (pid 100) → not a conflict; 8080 held by 200 → conflict;
        // 25575 held by 300 → conflict; 9999 not listening → ignored.
        assert_eq!(conflicts, vec![(8080, 200), (25575, 300)]);
    }

    #[test]
    fn eula_detection_is_case_insensitive() {
        use super::eula_declined;
        assert!(eula_declined("eula=false\n"));
        assert!(eula_declined("# comment\nEULA = FALSE\n"));
        assert!(!eula_declined("eula=true\n"));
        assert!(!eula_declined(""));
    }

    #[test]
    fn server_flavor_detection_prefers_specific_runtimes() {
        use super::detect_server_flavor;

        let jars = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        let (runtime, jar) =
            detect_server_flavor(&jars(&["server.jar"]), &[]);
        assert_eq!(runtime.as_deref(), Some("vanilla"));
        assert_eq!(jar.as_deref(), Some("server.jar"));

        let (runtime, _) = detect_server_flavor(
            &jars(&["server.jar", "fabric-server-launch.jar"]),
            &[],
        );
        assert_eq!(runtime.as_deref(), Some("fabric"));

        let (runtime, _) = detect_server_flavor(
            &jars(&["paper-1.21.jar"]),
            &[],
        );
        assert_eq!(runtime.as_deref(), Some("paper"));

        // A launch script with no recognizable jar → no runtime/jar override.
        let (runtime, jar) = detect_server_flavor(&[], &["run.bat".to_string()]);
        assert_eq!(runtime, None);
        assert_eq!(jar, None);
    }
}
