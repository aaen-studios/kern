//! Automation API v2 route handlers.
//!
//! Split out of `automation.rs` (which owns the loopback listener + auth) so
//! the route table can grow without turning the server core into a monolith.
//! Every handler is synchronous and reuses the same command functions the
//! desktop UI calls, so behavior can't drift between app and CLI.
//!
//! Conventions:
//!   - JSON in, JSON out. Errors are `{ "error": "..." }` with an HTTP status.
//!   - Lifecycle-ish actions (stop/restart/backup/restore/delete) are long
//!     running: they answer `202 Accepted` and finish on a background task,
//!     exactly like the web remote does for stop/restart.
//!   - Path segments are percent-decoded (backup names may contain spaces).
//!   - No app capability is exposed here that isn't already reachable from the
//!     desktop UI; the API is loopback + bearer-token only.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::audit;
use crate::commands;
use crate::config;
use crate::crash;
use crate::metrics::{MetricsHistory, MetricsState};
use crate::process;
use crate::scheduler;
use crate::web_remote;

/// Public API version reported by `/status`. Bumped when shapes change.
pub(crate) const API_VERSION: u32 = 2;

/// Initial tail read window when `offset=0`.
const TAIL_READ_BYTES: u64 = 2 * 1024 * 1024;
/// Incremental follow read cap per request.
const FOLLOW_READ_BYTES: u64 = 256 * 1024;
/// Hard cap on log lines returned by one request.
const MAX_LOG_LINES: usize = 2000;
/// Longest `/events` long-poll wait.
const MAX_EVENT_WAIT_SECS: u64 = 30;
/// How often the long-poll checks for new events.
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(500);

type R = (u16, &'static str, String);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn ok_json(value: Value) -> R {
    (200, "application/json", value.to_string())
}

fn created_json(value: Value) -> R {
    (201, "application/json", value.to_string())
}

fn accepted_json(action: &str) -> R {
    (
        202,
        "application/json",
        json!({ "action": action, "status": "accepted" }).to_string(),
    )
}

fn bad_request(message: &str) -> R {
    (400, "application/json", web_remote::err(message))
}

fn not_found(message: &str) -> R {
    (404, "application/json", web_remote::err(message))
}

fn internal(message: &str) -> R {
    (500, "application/json", web_remote::err(message))
}

/// Routes an authenticated request. Returns (status, content-type, body).
pub(crate) fn route(
    app: &AppHandle,
    method: &str,
    path: &str,
    query: &str,
    body: &str,
) -> R {
    let segments: Vec<String> = path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .map(percent_decode)
        .collect();
    let seg: Vec<&str> = segments.iter().map(String::as_str).collect();

    match (method, seg.as_slice()) {
        ("GET", ["status"]) | ("GET", ["health"]) => status(app),
        ("GET", ["servers"]) => servers(app, query),
        ("POST", ["servers"]) => create_server(app, body),
        ("GET", ["servers", id]) => server_detail(app, id),
        ("PATCH", ["servers", id]) => patch_server(app, id, body),
        ("DELETE", ["servers", id]) => delete_server(app, id, query),
        ("POST", ["servers", id, "stdin"]) => stdin(app, id, body),
        ("GET", ["servers", id, "log"]) => log(app, id, query),
        ("GET", ["servers", id, "metrics"]) => metrics_history(app, id, query),
        ("GET", ["servers", id, "energy"]) => energy(app, id),
        ("GET", ["servers", id, "preflight"]) => preflight(app, id),
        ("GET", ["servers", id, "crash"]) => last_crash(app, id),
        ("GET", ["servers", id, "tasks"]) => tasks(app, id),
        ("POST", ["servers", id, "tasks", task_id, "run"]) => run_task(app, id, task_id),
        ("GET", ["servers", id, "backups"]) => backups_list(app, id),
        ("POST", ["servers", id, "backup"]) => backup_create(app, id),
        ("POST", ["servers", id, "backups", name, "restore"]) => backup_restore(app, id, name),
        ("DELETE", ["servers", id, "backups", name]) => backup_delete(app, id, name),
        ("POST", ["servers", id, action])
            if matches!(*action, "start" | "stop" | "restart" | "install") =>
        {
            lifecycle(app, id, action)
        }
        ("GET", ["host", "metrics"]) => host_metrics(app),
        ("GET", ["inspect"]) => inspect_folder(query),
        ("GET", ["plugins"]) => plugins(app),
        ("POST", ["plugins", "install"]) => plugin_install(app, body),
        ("POST", ["plugins", "validate"]) => plugin_validate(body),
        ("DELETE", ["plugins", id]) => plugin_remove(app, id),
        ("GET", ["audit"]) => audit_entries(app, query),
        ("GET", ["events"]) => events(app, query),
        _ => not_found("not found"),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// status / metrics
// ──────────────────────────────────────────────────────────────────────────

fn status(app: &AppHandle) -> R {
    let host = app.state::<MetricsState>().host_metrics();
    ok_json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "pid": std::process::id(),
        "host": { "cpu": host.cpu, "ram": host.ram },
    }))
}

fn host_metrics(app: &AppHandle) -> R {
    match commands::get_host_metrics(app.clone()) {
        Ok(metrics) => ok_json(json!(metrics)),
        Err(e) => internal(&e),
    }
}

fn metrics_history(app: &AppHandle, id: &str, query: &str) -> R {
    let window = query_u64(query, "window").unwrap_or(3600).clamp(60, 7 * 24 * 3600);
    let history: tauri::State<'_, MetricsHistory> = app.state();
    ok_json(json!({ "windowSecs": window, "samples": history.query(id, window) }))
}

fn energy(app: &AppHandle, id: &str) -> R {
    match commands::get_instance_energy(app.clone(), id.to_string()) {
        Ok(cost) => ok_json(json!(cost)),
        Err(e) => not_found(&e),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// servers
// ──────────────────────────────────────────────────────────────────────────

fn servers(app: &AppHandle, query: &str) -> R {
    let include_ports = matches!(query_value(query, "ports").as_deref(), Some("1") | Some("true"));
    (200, "application/json", web_remote::servers_json_opts(app, include_ports))
}

fn server_detail(app: &AppHandle, id: &str) -> R {
    let cfg = match config::load_config(app) {
        Ok(c) => c,
        Err(e) => return internal(&e),
    };
    let Some(instance) = cfg.servers.get(id) else {
        return not_found(&format!("server '{id}' not found"));
    };

    let running = process::is_running(app, id);
    let adopted = process::is_adopted(app, id);
    let pid = process::pid_for(app, id);
    let uptime = pid.and_then(uptime_secs);
    let metrics_state: tauri::State<'_, MetricsState> = app.state();
    let metrics = if running {
        pid.and_then(|p| metrics_state.instance_metrics(p, &instance.status))
    } else {
        None
    };
    let ports = if running {
        match tauri::async_runtime::block_on(commands::get_instance_ports(
            app.clone(),
            id.to_string(),
        )) {
            Ok(ports) => serde_json::to_value(ports).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        }
    } else {
        Value::Null
    };
    let last_crash = crash::read(app, id);

    ok_json(json!({
        "id": instance.id,
        "name": instance.name,
        "type": instance.server_type,
        "path": instance.path,
        "group": instance.group,
        "tags": instance.tags,
        "status": instance.status,
        "running": running,
        "adopted": adopted,
        "orphaned": instance.is_orphaned,
        "autoStart": instance.auto_start,
        "pid": pid,
        "uptimeSecs": uptime,
        "metrics": metrics,
        "ports": ports,
        "lastCrash": last_crash,
    }))
}

fn create_server(app: &AppHandle, body: &str) -> R {
    let input: commands::NewServerInput = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return bad_request(&format!("invalid body: {e}")),
    };
    match commands::create_server(app.clone(), input) {
        Ok(instance) => created_json(json!(instance)),
        Err(e) => bad_request(&e),
    }
}

/// PATCH applies a sparse update: only the keys present in the body change.
/// The merged instance goes through `update_server` so host-owned fields
/// (status, pid, task timers) are preserved and tags are normalized.
fn patch_server(app: &AppHandle, id: &str, body: &str) -> R {
    let patch: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return bad_request(&format!("invalid body: {e}")),
    };
    let Some(patch) = patch.as_object() else {
        return bad_request("body must be a JSON object");
    };
    let cfg = match config::load_config(app) {
        Ok(c) => c,
        Err(e) => return internal(&e),
    };
    let Some(mut instance) = cfg.servers.get(id).cloned() else {
        return not_found(&format!("server '{id}' not found"));
    };

    if let Some(name) = patch.get("name").and_then(Value::as_str) {
        instance.name = name.to_string();
    }
    match patch.get("group") {
        Some(Value::Null) => instance.group = None,
        Some(Value::String(g)) => instance.group = Some(g.clone()),
        _ => {}
    }
    if let Some(tags) = patch.get("tags").and_then(Value::as_array) {
        instance.tags = tags
            .iter()
            .filter_map(|t| t.as_str().map(str::to_string))
            .collect();
    }
    if let Some(auto_start) = patch.get("autoStart").and_then(Value::as_bool) {
        instance.auto_start = auto_start;
    }
    match patch.get("stopCommand") {
        Some(Value::Null) => instance.stop_command = None,
        Some(Value::String(cmd)) => instance.stop_command = Some(cmd.clone()),
        _ => {}
    }
    if let Some(timeout) = patch.get("stopTimeoutSecs").and_then(Value::as_u64) {
        instance.stop_timeout_secs = timeout;
    }
    if let Some(overrides) = patch.get("userOverrides").and_then(Value::as_object) {
        instance.user_overrides = overrides
            .iter()
            .map(|(k, v)| {
                let value = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                (k.clone(), value)
            })
            .collect();
    }

    match commands::update_server(app.clone(), instance) {
        Ok(updated) => ok_json(json!(updated)),
        Err(e) => bad_request(&e),
    }
}

fn delete_server(app: &AppHandle, id: &str, query: &str) -> R {
    let with_folder = matches!(query_value(query, "folder").as_deref(), Some("1") | Some("true"));
    let handle = app.clone();
    let id_owned = id.to_string();
    // delete_server is async (it stops a running instance first); the route
    // runs on a dedicated connection thread, so blocking here is safe.
    if let Err(e) = tauri::async_runtime::block_on(commands::delete_server(handle.clone(), id_owned.clone())) {
        return bad_request(&e);
    }
    let folder_deleted = if with_folder {
        commands::delete_server_folder(handle, id_owned).is_ok()
    } else {
        false
    };
    ok_json(json!({ "ok": true, "folderDeleted": folder_deleted }))
}

fn lifecycle(app: &AppHandle, id: &str, action: &str) -> R {
    match action {
        "start" => match commands::launch_instance(app, id) {
            Ok(()) => ok_json(json!({ "action": "started" })),
            Err(e) => internal(&e),
        },
        "install" => match commands::install_server_instance(app.clone(), id.to_string()) {
            Ok(()) => ok_json(json!({ "action": "installed" })),
            Err(e) => internal(&e),
        },
        // stop/restart wait out the graceful window; answer immediately.
        _ => web_remote::act(app, id, action),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// logs / stdin
// ──────────────────────────────────────────────────────────────────────────

fn log(app: &AppHandle, id: &str, query: &str) -> R {
    let cfg = match config::load_config(app) {
        Ok(c) => c,
        Err(e) => return internal(&e),
    };
    let Some(instance) = cfg.servers.get(id) else {
        return not_found(&format!("server '{id}' not found"));
    };
    let path = Path::new(&instance.path).join("latest.log");
    let lines = (query_u64(query, "lines").unwrap_or(200) as usize).clamp(1, MAX_LOG_LINES);
    let offset = query_u64(query, "offset").unwrap_or(0);
    match read_log_since(&path, offset, lines) {
        Ok(chunk) => ok_json(json!({
            "lines": chunk.lines,
            "nextOffset": chunk.next_offset,
            "size": chunk.size,
            "reset": chunk.reset,
            "running": process::is_running(app, id),
        })),
        Err(e) => internal(&e),
    }
}

fn stdin(app: &AppHandle, id: &str, body: &str) -> R {
    let line = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("line").and_then(|l| l.as_str()).map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string());
    if line.is_empty() {
        return bad_request("missing line (send {\"line\": \"...\"} or raw text)");
    }
    let mut data = line;
    data.push('\n');
    match process::write_stdin(app, id, &data) {
        Ok(()) => ok_json(json!({ "ok": true })),
        Err(e) => bad_request(&e),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// crash / tasks / backups / preflight
// ──────────────────────────────────────────────────────────────────────────

fn last_crash(app: &AppHandle, id: &str) -> R {
    ok_json(json!({ "crash": crash::read(app, id) }))
}

fn tasks(app: &AppHandle, id: &str) -> R {
    let cfg = match config::load_config(app) {
        Ok(c) => c,
        Err(e) => return internal(&e),
    };
    let Some(instance) = cfg.servers.get(id) else {
        return not_found(&format!("server '{id}' not found"));
    };
    ok_json(json!({ "tasks": instance.tasks }))
}

fn run_task(app: &AppHandle, id: &str, task_id: &str) -> R {
    match scheduler::run_task_now(app.clone(), id.to_string(), task_id.to_string()) {
        Ok(()) => ok_json(json!({ "ok": true })),
        Err(e) => bad_request(&e),
    }
}

fn backups_list(app: &AppHandle, id: &str) -> R {
    match commands::list_backups(app.clone(), id.to_string()) {
        Ok(backups) => ok_json(json!({ "backups": backups })),
        Err(e) => not_found(&e),
    }
}

fn backup_create(app: &AppHandle, id: &str) -> R {
    let existing = config::load_config(app)
        .ok()
        .and_then(|cfg| cfg.servers.contains_key(id).then_some(()));
    if existing.is_none() {
        return not_found(&format!("server '{id}' not found"));
    }
    let handle = app.clone();
    let id_owned = id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = commands::backup_world(handle, id_owned).await {
            eprintln!("[automation] backup failed: {e}");
        }
    });
    accepted_json("backup")
}

fn backup_restore(app: &AppHandle, id: &str, name: &str) -> R {
    let existing = config::load_config(app)
        .ok()
        .and_then(|cfg| cfg.servers.contains_key(id).then_some(()));
    if existing.is_none() {
        return not_found(&format!("server '{id}' not found"));
    }
    let handle = app.clone();
    let id_owned = id.to_string();
    let name_owned = name.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = commands::restore_world(handle, id_owned, name_owned).await {
            eprintln!("[automation] restore failed: {e}");
        }
    });
    accepted_json("restore")
}

fn backup_delete(app: &AppHandle, id: &str, name: &str) -> R {
    match commands::delete_backup(app.clone(), id.to_string(), name.to_string()) {
        Ok(()) => ok_json(json!({ "ok": true })),
        Err(e) => bad_request(&e),
    }
}

fn preflight(app: &AppHandle, id: &str) -> R {
    match commands::preflight_launch(app.clone(), id.to_string()) {
        Ok(report) => ok_json(json!(report)),
        Err(e) => not_found(&e),
    }
}

/// Read-only folder inspection for the `import` flow.
fn inspect_folder(query: &str) -> R {
    let Some(path) = query_value(query, "path") else {
        return bad_request("missing 'path' query parameter");
    };
    match commands::inspect_server_folder(path) {
        Ok(inspection) => ok_json(json!(inspection)),
        Err(e) => bad_request(&e),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// plugins
// ──────────────────────────────────────────────────────────────────────────

fn plugins(app: &AppHandle) -> R {
    match commands::list_plugins(app.clone()) {
        Ok(plugins) => ok_json(json!({ "plugins": plugins })),
        Err(e) => internal(&e),
    }
}

fn plugin_install(app: &AppHandle, body: &str) -> R {
    let value: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return bad_request(&format!("invalid body: {e}")),
    };
    let Some(path) = value.get("path").and_then(Value::as_str) else {
        return bad_request("missing 'path' (absolute path to a .kern file)");
    };
    let force = value.get("force").and_then(Value::as_bool).unwrap_or(false);
    match commands::install_plugin_from_kern(app.clone(), path.to_string(), force) {
        Ok(manifest) => created_json(json!(manifest)),
        Err(e) => bad_request(&e),
    }
}

fn plugin_validate(body: &str) -> R {
    let value: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return bad_request(&format!("invalid body: {e}")),
    };
    let Some(path) = value.get("path").and_then(Value::as_str) else {
        return bad_request("missing 'path' (absolute path to a .kern file)");
    };
    match commands::validate_kern_file(path.to_string()) {
        Ok(manifest) => ok_json(json!({ "valid": true, "manifest": manifest })),
        Err(e) => ok_json(json!({ "valid": false, "error": e })),
    }
}

fn plugin_remove(app: &AppHandle, id: &str) -> R {
    match commands::uninstall_plugin(app.clone(), id.to_string()) {
        Ok(()) => ok_json(json!({ "ok": true })),
        Err(e) => bad_request(&e),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// audit / events
// ──────────────────────────────────────────────────────────────────────────

fn audit_entries(app: &AppHandle, query: &str) -> R {
    let limit = query_u64(query, "limit").unwrap_or(100).clamp(1, 500) as usize;
    let since = query_u64(query, "since");
    let mut entries = audit::read(app, limit);
    if let Some(since) = since {
        entries.retain(|e| e.at >= since);
    }
    ok_json(json!({ "entries": entries, "now": now_secs() }))
}

/// Long-poll event feed: audit entries newer than `since`, plus the current
/// status map so clients can detect lifecycle transitions. Blocks up to
/// `wait` seconds (max 30) when there is nothing new, then returns anyway.
fn events(app: &AppHandle, query: &str) -> R {
    let since = query_u64(query, "since").unwrap_or(0);
    let wait = query_u64(query, "wait").unwrap_or(0).min(MAX_EVENT_WAIT_SECS);
    let deadline = std::time::Instant::now() + Duration::from_secs(wait);

    loop {
        let mut entries = audit::read(app, 500);
        entries.retain(|e| e.at > since);
        entries.reverse(); // oldest → newest for streaming consumers
        let statuses = status_map(app);
        if !entries.is_empty() || std::time::Instant::now() >= deadline {
            return ok_json(json!({
                "entries": entries,
                "statuses": statuses,
                "now": now_secs(),
            }));
        }
        std::thread::sleep(EVENT_POLL_INTERVAL);
    }
}

fn status_map(app: &AppHandle) -> Value {
    match config::load_config(app) {
        Ok(cfg) => Value::Object(
            cfg.servers
                .iter()
                .map(|(id, s)| (id.clone(), Value::String(s.status.clone())))
                .collect(),
        ),
        Err(_) => json!({}),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────

fn uptime_secs(pid: u32) -> Option<u64> {
    process::process_start_time(pid).map(|started| now_secs().saturating_sub(started))
}

/// Percent-decodes a single path segment (`%20` → space). Invalid escapes are
/// kept verbatim so IDs with literal `%` can't become unreachable.
fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// First value for `key` in a `a=1&b=2` query string.
fn query_value(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| percent_decode(v))
}

fn query_u64(query: &str, key: &str) -> Option<u64> {
    query_value(query, key).and_then(|v| v.parse().ok())
}

/// One slice of an instance log.
struct LogChunk {
    lines: Vec<String>,
    /// Byte offset to pass as `offset` next time.
    next_offset: u64,
    /// Current file size.
    size: u64,
    /// True when the previous offset was past the end (file rotated/truncated).
    reset: bool,
}

/// Reads `latest.log` incrementally.
///
/// `offset = 0` returns the last `lines` complete lines (tail mode) and points
/// `next_offset` after the last complete line. `offset > 0` returns every
/// complete line after that byte offset (follow mode); a trailing partial line
/// is left for the next call. If the file shrank past `offset` (rotation),
/// `reset` is set and the response falls back to tail mode.
fn read_log_since(path: &Path, offset: u64, lines: usize) -> Result<LogChunk, String> {
    if !path.exists() {
        return Ok(LogChunk {
            lines: Vec::new(),
            next_offset: 0,
            size: 0,
            reset: false,
        });
    }
    let size = std::fs::metadata(path)
        .map_err(|e| format!("failed to stat log: {e}"))?
        .len();
    let reset = offset > size;
    let tail_mode = reset || offset == 0;

    let (read_from, read_cap) = if tail_mode {
        (size.saturating_sub(TAIL_READ_BYTES), TAIL_READ_BYTES)
    } else {
        (offset, FOLLOW_READ_BYTES)
    };

    let mut buf = Vec::new();
    if read_from < size {
        let mut file = File::open(path).map_err(|e| format!("failed to open log: {e}"))?;
        file.seek(SeekFrom::Start(read_from))
            .map_err(|e| format!("failed to seek log: {e}"))?;
        file.take(read_cap)
            .read_to_end(&mut buf)
            .map_err(|e| format!("failed to read log: {e}"))?;
    }

    // Drop a partial first line when the window didn't start at a boundary.
    let mut abs_start = read_from;
    if read_from > 0 && !buf.is_empty() {
        let prev_is_newline = {
            let mut f = File::open(path).map_err(|e| format!("failed to open log: {e}"))?;
            f.seek(SeekFrom::Start(read_from - 1))
                .map_err(|e| format!("failed to seek log: {e}"))?;
            let mut prev = [0u8; 1];
            f.read_exact(&mut prev).is_ok() && prev[0] == b'\n'
        };
        if !prev_is_newline {
            if let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                abs_start += (nl + 1) as u64;
                buf.drain(..=nl);
            } else {
                buf.clear();
                abs_start = size;
            }
        }
    }

    // Only complete lines count; a trailing partial line stays unread.
    let mut complete_end = 0usize;
    if let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') {
        complete_end = last_nl + 1;
    }
    let next_offset = (abs_start + complete_end as u64).min(size).max(offset.min(size));
    let text = String::from_utf8_lossy(&buf[..complete_end]);
    let mut all: Vec<String> = text.lines().map(str::to_string).collect();

    let lines_out = if tail_mode {
        let keep = all.len().saturating_sub(lines);
        all.split_off(keep)
    } else {
        all
    };

    Ok(LogChunk {
        lines: lines_out,
        next_offset,
        size,
        reset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, data: &str) {
        let mut file = File::create(path).unwrap();
        file.write_all(data.as_bytes()).unwrap();
    }

    #[test]
    fn percent_decode_handles_spaces_and_literal_percent() {
        assert_eq!(percent_decode("backup%20one"), "backup one");
        assert_eq!(percent_decode("srv_123"), "srv_123");
        assert_eq!(percent_decode("50%"), "50%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn query_parsing_takes_first_match() {
        assert_eq!(query_value("a=1&b=2&a=3", "a").as_deref(), Some("1"));
        assert_eq!(query_value("a=1&b=2", "b").as_deref(), Some("2"));
        assert_eq!(query_value("a=1", "missing"), None);
        assert_eq!(query_u64("lines=250", "lines"), Some(250));
        assert_eq!(query_u64("lines=x", "lines"), None);
        assert_eq!(query_value("name=my%20server", "name").as_deref(), Some("my server"));
    }

    #[test]
    fn log_tail_mode_returns_last_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latest.log");
        write(&path, "a\nb\nc\n");
        let chunk = read_log_since(&path, 0, 2).unwrap();
        assert_eq!(chunk.lines, vec!["b", "c"]);
        assert_eq!(chunk.next_offset, 6);
        assert_eq!(chunk.size, 6);
        assert!(!chunk.reset);
    }

    #[test]
    fn log_follow_reads_only_new_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latest.log");
        write(&path, "a\nb\n");
        let chunk = read_log_since(&path, 4, 10).unwrap();
        assert!(chunk.lines.is_empty());
        assert_eq!(chunk.next_offset, 4);

        write(&path, "a\nb\nc\nd");
        let chunk = read_log_since(&path, 4, 10).unwrap();
        assert_eq!(chunk.lines, vec!["c"]);
        assert_eq!(chunk.next_offset, 6);

        write(&path, "a\nb\nc\nd\n");
        let chunk = read_log_since(&path, 6, 10).unwrap();
        assert_eq!(chunk.lines, vec!["d"]);
        assert_eq!(chunk.next_offset, 8);
    }

    #[test]
    fn log_rotation_resets_offset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latest.log");
        write(&path, "fresh\n");
        let chunk = read_log_since(&path, 9999, 10).unwrap();
        assert!(chunk.reset);
        assert_eq!(chunk.lines, vec!["fresh"]);
        assert_eq!(chunk.next_offset, 6);
    }

    #[test]
    fn log_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let chunk = read_log_since(&dir.path().join("nope.log"), 0, 10).unwrap();
        assert!(chunk.lines.is_empty());
        assert_eq!(chunk.next_offset, 0);
        assert_eq!(chunk.size, 0);
    }

    #[test]
    fn log_partial_first_line_is_dropped_in_follow_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latest.log");
        write(&path, "a\nb\nc\n");
        // Offset 1 lands mid-line ("\nb\nc\n" → first fragment "\n"? no: byte 1 is '\n').
        let chunk = read_log_since(&path, 1, 10).unwrap();
        assert_eq!(chunk.lines, vec!["b", "c"]);
    }
}
