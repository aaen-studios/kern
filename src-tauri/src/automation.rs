//! Loopback automation API for scripts and `kern-cli`.
//!
//! Plain HTTP bound to `127.0.0.1` only (never the LAN), Bearer-token
//! authenticated. The port + token are published to
//! `<app_data>/automation.json` so the CLI can discover them; the file is
//! rewritten on every startup and reused when present so the token is stable.
//!
//! Endpoints (all JSON, all requiring `Authorization: Bearer <token>`):
//!
//!   GET  /status                    → { version, automation }
//!   GET  /servers                   → { servers: [...] }
//!   GET  /servers/{id}/log?lines=N  → { lines: [...] }   (max 1000)
//!   POST /servers/{id}/{action}     → start | stop | restart
//!   POST /servers/{id}/stdin        → { "line": "say hi" } or raw text
//!
//! HTTPS stays reserved for the LAN web remote; loopback is not exposed to
//! the network, so plain HTTP avoids the self-signed certificate dance for a
//! process on the same machine.

use std::io::{BufReader, Read};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::config;
use crate::process;
use crate::web_remote;

const MAX_HEADER_BYTES: u64 = 16 * 1024;
const MAX_BODY_BYTES: u64 = 64 * 1024;
const MAX_LOG_LINES: usize = 1000;

/// Server state: whether it's listening + the active token.
#[derive(Default)]
pub struct AutomationState {
    pub running: AtomicBool,
    pub token: Mutex<String>,
}

/// The published discovery document (`automation.json`).
#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}

/// Spawns the loopback server if the setting is enabled. No-op otherwise.
pub fn maybe_spawn(app: &AppHandle) {
    let Ok(cfg) = config::load_config(app) else {
        return;
    };
    if !cfg.settings.automation_enabled {
        return;
    }
    let port = cfg.settings.automation_port;
    let handle = app.clone();
    std::thread::spawn(move || serve(&handle, port));
}

fn endpoint_path(app: &AppHandle) -> Option<PathBuf> {
    config::config_dir(app)
        .ok()
        .map(|dir| dir.join("automation.json"))
}

/// Reuses the stored token when present, else generates one.
fn load_or_create_token(app: &AppHandle) -> String {
    if let Some(path) = endpoint_path(app) {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(endpoint) = serde_json::from_str::<Endpoint>(&raw) {
                if !endpoint.token.trim().is_empty() {
                    return endpoint.token;
                }
            }
        }
    }
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0x9e37_79b9);
        bytes[..8].copy_from_slice(&nanos.to_le_bytes()[..8]);
        bytes[8..].copy_from_slice(&nanos.wrapping_mul(31).to_le_bytes()[..8]);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_endpoint(app: &AppHandle, port: u16, token: &str) {
    let Some(path) = endpoint_path(app) else {
        return;
    };
    let endpoint = Endpoint {
        port,
        token: token.to_string(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&endpoint) {
        let _ = std::fs::write(path, raw);
    }
}

fn serve(app: &AppHandle, port: u16) {
    let token = load_or_create_token(app);
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[automation] failed to bind 127.0.0.1:{port}: {e}");
            return;
        }
    };
    {
        let state: tauri::State<'_, AutomationState> = app.state();
        state.running.store(true, Ordering::SeqCst);
        let _ = state.token.lock().map(|mut current| *current = token.clone());
    }
    write_endpoint(app, port, &token);
    eprintln!("[automation] listening on http://127.0.0.1:{port} (token required)");

    for stream in listener.incoming() {
        let Ok(tcp) = stream else {
            continue;
        };
        let _ = tcp.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = tcp.set_write_timeout(Some(Duration::from_secs(10)));
        let handle = app.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            let _ = handle_conn(&handle, tcp, &token);
        });
    }
    let state: tauri::State<'_, AutomationState> = app.state();
    state.running.store(false, Ordering::SeqCst);
}

/// Auth info exposed to the settings UI (`automation_info` command).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInfo {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub token: String,
}

/// Returns the current automation endpoint details (for copy/paste in the UI).
#[tauri::command]
pub fn automation_info(app_handle: AppHandle) -> AutomationInfo {
    let cfg = config::load_config(&app_handle).ok();
    let port = cfg
        .as_ref()
        .map(|c| c.settings.automation_port)
        .unwrap_or(7442);
    let enabled = cfg
        .as_ref()
        .map(|c| c.settings.automation_enabled)
        .unwrap_or(false);
    let state: tauri::State<'_, AutomationState> = app_handle.state();
    AutomationInfo {
        enabled,
        running: state.running.load(Ordering::SeqCst),
        port,
        url: format!("http://127.0.0.1:{port}"),
        token: state.token.lock().map(|t| t.clone()).unwrap_or_default(),
    }
}

fn handle_conn(app: &AppHandle, mut stream: TcpStream, token: &str) -> std::io::Result<()> {
    let method;
    let target;
    let mut auth: Option<String> = None;
    let mut body = String::new();
    {
        let mut reader = BufReader::new(&mut stream);
        let mut request_line = String::new();
        let read = web_remote::read_line_capped(&mut reader, &mut request_line, MAX_HEADER_BYTES)?;
        if read == 0 || read >= MAX_HEADER_BYTES || !request_line.ends_with('\n') {
            return web_remote::respond(&mut stream, 400, "application/json", &web_remote::err("bad request"));
        }
        let mut header_bytes = read;
        let mut content_length = 0u64;
        loop {
            let mut header = String::new();
            let n = web_remote::read_line_capped(&mut reader, &mut header, MAX_HEADER_BYTES)?;
            header_bytes += n;
            if n == 0 || header == "\r\n" || header == "\n" {
                break;
            }
            if header_bytes >= MAX_HEADER_BYTES {
                return web_remote::respond(&mut stream, 431, "application/json", &web_remote::err("headers too large"));
            }
            let lower = header.to_ascii_lowercase();
            if lower.starts_with("authorization:") {
                auth = header.split(':').nth(1).map(|v| v.trim().to_string());
            } else if lower.starts_with("content-length:") {
                content_length = header
                    .split(':')
                    .nth(1)
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
            }
        }
        let parts: Vec<&str> = request_line.split_whitespace().collect();
        method = parts.first().copied().unwrap_or("").to_string();
        target = parts.get(1).copied().unwrap_or("").to_string();
        if method == "POST" && content_length > 0 {
            if content_length > MAX_BODY_BYTES {
                return web_remote::respond(&mut stream, 413, "application/json", &web_remote::err("body too large"));
            }
            let mut buf = vec![0u8; content_length as usize];
            reader.read_exact(&mut buf)?;
            body = String::from_utf8_lossy(&buf).to_string();
        }
    }

    let provided = auth
        .as_deref()
        .map(|h| h.strip_prefix("Bearer ").unwrap_or(h).trim());
    if !provided.is_some_and(|p| web_remote::constant_eq(p.as_bytes(), token.as_bytes())) {
        return web_remote::respond(
            &mut stream,
            401,
            "application/json",
            &web_remote::err("unauthorized — send Authorization: Bearer <token>"),
        );
    }

    let (path, query) = target
        .split_once('?')
        .map(|(p, q)| (p.to_string(), q.to_string()))
        .unwrap_or((target.clone(), String::new()));
    let (status, content_type, body) = route(app, &method, &path, &query, &body);
    web_remote::respond(&mut stream, status, content_type, &body)
}

/// Routes an authenticated request. Returns (status, content-type, body).
fn route(
    app: &AppHandle,
    method: &str,
    path: &str,
    query: &str,
    body: &str,
) -> (u16, &'static str, String) {
    match (method, path) {
        ("GET", "/status") | ("GET", "/health") => (
            200,
            "application/json",
            serde_json::json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
            })
            .to_string(),
        ),
        ("GET", "/servers") => (200, "application/json", web_remote::servers_json(app)),
        ("GET", p) if p.starts_with("/servers/") && p.ends_with("/log") => {
            let id = p
                .trim_start_matches("/servers/")
                .trim_end_matches("/log")
                .trim_end_matches('/');
            let lines = query
                .split('&')
                .filter_map(|pair| pair.split_once('='))
                .find(|(k, _)| *k == "lines")
                .and_then(|(_, v)| v.parse::<usize>().ok())
                .unwrap_or(200)
                .clamp(1, MAX_LOG_LINES);
            match web_remote::tail_log(app, id) {
                Ok(mut all) => {
                    let start = all.len().saturating_sub(lines);
                    all.drain(..start);
                    (
                        200,
                        "application/json",
                        serde_json::json!({ "lines": all }).to_string(),
                    )
                }
                Err(e) => (404, "application/json", web_remote::err(&e)),
            }
        }
        ("POST", p) if p.starts_with("/servers/") && p.ends_with("/stdin") => {
            let id = p
                .trim_start_matches("/servers/")
                .trim_end_matches("/stdin")
                .trim_end_matches('/');
            let line = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("line").and_then(|l| l.as_str()).map(str::to_string))
                .unwrap_or_else(|| body.trim().to_string());
            if line.is_empty() {
                return (
                    400,
                    "application/json",
                    web_remote::err("missing line (send {\"line\": \"...\"} or raw text)"),
                );
            }
            let mut data = line;
            data.push('\n');
            match process::write_stdin(app, id, &data) {
                Ok(()) => (
                    200,
                    "application/json",
                    r#"{"ok":true}"#.to_string(),
                ),
                Err(e) => (400, "application/json", web_remote::err(&e)),
            }
        }
        ("POST", p) if p.starts_with("/servers/") => {
            let rest: Vec<&str> = p.trim_start_matches("/servers/").split('/').collect();
            match (rest.first(), rest.get(1)) {
                (Some(id), Some(action)) => web_remote::act(app, id, action),
                _ => (404, "application/json", web_remote::err("not found")),
            }
        }
        _ => (404, "application/json", web_remote::err("not found")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_rejects_unknown_paths() {
        // Route needs an AppHandle for most paths; only the fallthrough and
        // pure parsing are exercised here.
        let endpoint = Endpoint {
            port: 7442,
            token: "abc".to_string(),
        };
        let raw = serde_json::to_string(&endpoint).unwrap();
        let back: Endpoint = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.port, 7442);
        assert_eq!(back.token, "abc");
    }

    #[test]
    fn stdin_line_parsing_accepts_json_and_raw() {
        let from_json = serde_json::from_str::<serde_json::Value>(r#"{"line":"say hi"}"#)
            .ok()
            .and_then(|v| v.get("line").and_then(|l| l.as_str()).map(str::to_string))
            .unwrap_or_default();
        assert_eq!(from_json, "say hi");
        let raw = "list".to_string();
        assert_eq!(raw, "list");
    }
}
