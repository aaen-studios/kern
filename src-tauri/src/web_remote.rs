//! Optional web remote — self-signed HTTPS + token pairing + a mobile-first
//! control UI.
//!
//! Design decisions (per product spec):
//!   - Served over **HTTPS** with a self-signed certificate generated on first
//!     run (stored under `<app_data>/web_remote/`), so the browser treats it
//!     as a secure context.
//!   - **Token auth**, not a passphrase: a random 48-hex token is generated
//!     once and kept in the OS credential vault; the desktop shows a QR code
//!     that embeds it for one-scan pairing.
//!   - Bound to the LAN (`0.0.0.0:<port>`), enabled explicitly in Settings.
//!
//! The web UI is a purpose-built mobile page (server cards, start/stop/
//! restart, live log tail) rather than the desktop React app — the desktop UI
//! depends on the Tauri IPC bridge, which a browser doesn't have.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer, PrivateKeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::metrics::MetricsState;
use crate::process;

const KEYRING_SERVICE: &str = "kern.webremote";
const KEYRING_USER: &str = "token";

/// Maximum request line / header size accepted (bytes).
const MAX_HEADER_BYTES: u64 = 8 * 1024;
/// Maximum simultaneously handled connections.
const MAX_CONNECTIONS: usize = 48;
/// Maximum bytes read from latest.log for a tail request.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// Shared remote state (token cache + live status for the Settings UI).
#[derive(Default)]
pub struct WebRemoteState {
    token: Mutex<Option<String>>,
    pub running: AtomicBool,
    pub port: Mutex<u16>,
    /// Invalidates the accept loop when settings change (start/stop/restart).
    generation: std::sync::atomic::AtomicU64,
}

/// Brings the web remote up/down to match the saved settings. Safe to call on
/// every settings save and at startup; no-op when already in the right state.
pub fn apply_settings(app_handle: &AppHandle) {
    let cfg = match config::load_config(app_handle) {
        Ok(c) => c,
        Err(_) => return,
    };
    let enabled = cfg.settings.web_remote_enabled;
    let port = cfg.settings.web_remote_port;
    let state: tauri::State<'_, WebRemoteState> = app_handle.state();
    let running = state.running.load(Ordering::SeqCst);
    let active_port = state.port.lock().map(|p| *p).unwrap_or(0);

    if !enabled {
        if running {
            // Bump the generation; the accept loop notices and exits.
            state
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = app_handle.emit("kern://web-remote-state", ());
        }
        return;
    }
    if running && active_port == port {
        return;
    }

    // Restart: invalidate the old loop, wait for it to release the port, spawn.
    state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..20 {
        if !state.running.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    // Ensure a token exists before the server accepts connections.
    if let Err(e) = load_or_create_token(app_handle) {
        eprintln!("[web-remote] could not initialise auth token: {e}");
        return;
    }
    let _ = state.port.lock().map(|mut p| *p = port);
    let generation = state.generation.load(std::sync::atomic::Ordering::SeqCst);
    let handle = app_handle.clone();
    std::thread::spawn(move || serve(&handle, port, generation));
}

/// Legacy entry point kept for setup; delegates to [`apply_settings`].
pub fn maybe_spawn(app_handle: &AppHandle) {
    apply_settings(app_handle);
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("credential store unavailable: {e}"))
}

fn new_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Extremely unlikely fallback; still plenty of entropy for a LAN token.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((now >> (i % 16 * 8)) & 0xff) as u8;
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn load_or_create_token(app_handle: &AppHandle) -> Result<String, String> {
    let state: tauri::State<'_, WebRemoteState> = app_handle.state();
    let cached = state.token.lock().ok().and_then(|guard| guard.clone());
    if let Some(token) = cached {
        return Ok(token);
    }
    let entry = token_entry()?;
    let token = match entry.get_password() {
        Ok(existing) if !existing.trim().is_empty() => existing,
        _ => {
            let fresh = new_token();
            entry
                .set_password(&fresh)
                .map_err(|e| format!("failed to store web-remote token: {e}"))?;
            fresh
        }
    };
    let _ = state.token.lock().map(|mut guard| *guard = Some(token.clone()));
    Ok(token)
}

fn current_token(app_handle: &AppHandle) -> Option<String> {
    let state: tauri::State<'_, WebRemoteState> = app_handle.state();
    let token = state.token.lock().ok().and_then(|guard| guard.clone());
    token
}

/// Picks the machine's preferred outbound LAN IP (no traffic is sent).
fn local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

/// Connection info for the Settings UI: URLs + a QR SVG embedding the token.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebRemoteInfo {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub token: String,
    pub urls: Vec<String>,
    pub qr_svg: String,
    /// Cloudflare quick-tunnel status (see [`crate::tunnel`]).
    pub tunnel: crate::tunnel::TunnelInfo,
    /// Pairing QR for the public tunnel URL (empty until the tunnel is up).
    pub tunnel_qr_svg: String,
}

fn qr_svg_for(url: &str) -> String {
    qrcode::QrCode::new(url.as_bytes())
        .map(|code| {
            code.render::<qrcode::render::svg::Color>()
                .min_dimensions(220, 220)
                .dark_color(qrcode::render::svg::Color("#e4e4e7"))
                .light_color(qrcode::render::svg::Color("#050506"))
                .build()
        })
        .unwrap_or_default()
}

fn build_info(app_handle: &AppHandle) -> Result<WebRemoteInfo, String> {
    let cfg = config::load_config(app_handle)?;
    let token = load_or_create_token(app_handle)?;
    let state: tauri::State<'_, WebRemoteState> = app_handle.state();
    let running = state.running.load(Ordering::SeqCst);
    let port = state
        .port
        .lock()
        .map(|p| *p)
        .unwrap_or(cfg.settings.web_remote_port);

    let mut urls = Vec::new();
    if let Some(ip) = local_ip() {
        urls.push(format!("https://{ip}:{port}"));
    }
    urls.push(format!("https://localhost:{port}"));

    let pair_url = format!("{}/?token={token}", urls[0]);
    let qr_svg = qr_svg_for(&pair_url);

    let tunnel = crate::tunnel::info(app_handle);
    let tunnel_qr_svg = tunnel
        .url
        .as_ref()
        .map(|url| qr_svg_for(&format!("{url}/?token={token}")))
        .unwrap_or_default();

    Ok(WebRemoteInfo {
        enabled: cfg.settings.web_remote_enabled,
        running,
        port,
        token,
        urls,
        qr_svg,
        tunnel,
        tunnel_qr_svg,
    })
}

/// Returns the current remote status + QR for pairing.
#[tauri::command]
pub fn web_remote_info(app_handle: AppHandle) -> Result<WebRemoteInfo, String> {
    build_info(&app_handle)
}

/// Rotates the access token (invalidates every paired device).
#[tauri::command]
pub fn web_remote_regenerate_token(app_handle: AppHandle) -> Result<WebRemoteInfo, String> {
    let fresh = new_token();
    token_entry()?
        .set_password(&fresh)
        .map_err(|e| format!("failed to store web-remote token: {e}"))?;
    {
        let state: tauri::State<'_, WebRemoteState> = app_handle.state();
        let _ = state.token.lock().map(|mut guard| *guard = Some(fresh));
    }
    build_info(&app_handle)
}

// ---------------------------------------------------------------------------
// TLS material
// ---------------------------------------------------------------------------

fn cert_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = config::config_dir(app_handle)?.join("web_remote");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create cert dir: {e}"))?;
    Ok(dir)
}

/// Loads the persisted DER cert/key, generating a self-signed pair on first
/// use (SANs: localhost, 127.0.0.1, and the machine's LAN IP).
fn load_or_create_cert(app_handle: &AppHandle) -> Result<(Vec<u8>, Vec<u8>), String> {
    let dir = cert_dir(app_handle)?;
    let cert_path = dir.join("cert.der");
    let key_path = dir.join("key.der");
    if cert_path.is_file() && key_path.is_file() {
        let cert = std::fs::read(&cert_path).map_err(|e| format!("failed to read cert: {e}"))?;
        let key = std::fs::read(&key_path).map_err(|e| format!("failed to read key: {e}"))?;
        return Ok((cert, key));
    }

    let mut sans = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    if let Some(ip) = local_ip() {
        sans.push(ip);
    }
    let certified = rcgen::generate_simple_self_signed(sans)
        .map_err(|e| format!("failed to generate TLS certificate: {e}"))?;
    let cert = certified.cert.der().to_vec();
    let key = certified.key_pair.serialize_der();
    std::fs::write(&cert_path, &cert).map_err(|e| format!("failed to write cert: {e}"))?;
    std::fs::write(&key_path, &key).map_err(|e| format!("failed to write key: {e}"))?;
    Ok((cert, key))
}

fn tls_config(app_handle: &AppHandle) -> Result<Arc<ServerConfig>, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (cert_der, key_der) = load_or_create_cert(app_handle)?;
    let cert = CertificateDer::from(cert_der);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der));
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .map_err(|e| format!("failed to build TLS config: {e}"))?;
    Ok(Arc::new(config))
}

// ---------------------------------------------------------------------------
// Server loop
// ---------------------------------------------------------------------------

fn serve(handle: &AppHandle, port: u16, generation: u64) {
    let tls = match tls_config(handle) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("[web-remote] TLS setup failed: {e}");
            return;
        }
    };
    let listener = match TcpListener::bind(("0.0.0.0", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[web-remote] failed to bind :{port}: {e}");
            return;
        }
    };
    // Non-blocking accept so the loop can notice a settings change (generation
    // bump) without waiting for the next connection.
    let _ = listener.set_nonblocking(true);
    {
        let state: tauri::State<'_, WebRemoteState> = handle.state();
        state.running.store(true, Ordering::SeqCst);
    }
    eprintln!("[web-remote] listening on https://0.0.0.0:{port} (token required)");
    let _ = handle.emit("kern://web-remote-state", ());

    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    loop {
        let state: tauri::State<'_, WebRemoteState> = handle.state();
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
            break;
        }
        match listener.accept() {
            Ok((tcp, _)) => {
                let _ = tcp.set_nonblocking(false);
                let current = active.load(Ordering::SeqCst);
                if current >= MAX_CONNECTIONS {
                    continue; // shed load; the handshake would fail anyway
                }
                let _ = tcp.set_read_timeout(Some(Duration::from_secs(10)));
                let _ = tcp.set_write_timeout(Some(Duration::from_secs(10)));
                let tls = tls.clone();
                let h = handle.clone();
                let active = active.clone();
                active.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    if let Ok(conn) = ServerConnection::new(tls) {
                        let stream = StreamOwned::new(conn, tcp);
                        let _ = handle_conn(&h, stream);
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
    let state: tauri::State<'_, WebRemoteState> = handle.state();
    state.running.store(false, Ordering::SeqCst);
    let _ = handle.emit("kern://web-remote-state", ());
}

/// Reads one line into `out`, stopping once `cap` bytes have been consumed.
pub(crate) fn read_line_capped<R: BufRead>(reader: &mut R, out: &mut String, cap: u64) -> std::io::Result<u64> {
    let mut buf: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let remaining = cap.saturating_sub(total) as usize;
        if remaining == 0 {
            break;
        }
        let take = available.len().min(remaining);
        match available[..take].iter().position(|b| *b == b'\n') {
            Some(pos) => {
                buf.extend_from_slice(&available[..=pos]);
                reader.consume(pos + 1);
                total += (pos + 1) as u64;
                break;
            }
            None => {
                buf.extend_from_slice(&available[..take]);
                reader.consume(take);
                total += take as u64;
            }
        }
    }
    out.push_str(&String::from_utf8_lossy(&buf));
    Ok(total)
}

fn handle_conn<S: Read + Write>(handle: &AppHandle, mut stream: S) -> std::io::Result<()> {
    let mut request_line = String::new();
    let mut auth_header: Option<String> = None;
    let method;
    let target;
    {
        let mut reader = BufReader::new(&mut stream);
        let read = read_line_capped(&mut reader, &mut request_line, MAX_HEADER_BYTES)?;
        if read == 0 || read >= MAX_HEADER_BYTES || !request_line.ends_with('\n') {
            return respond(&mut stream, 400, "application/json", &err("bad request"));
        }
        let mut header_bytes = read;
        loop {
            let mut header = String::new();
            let n = read_line_capped(&mut reader, &mut header, MAX_HEADER_BYTES)?;
            header_bytes += n;
            if n == 0 || header == "\r\n" || header == "\n" {
                break;
            }
            if header_bytes >= MAX_HEADER_BYTES {
                return respond(&mut stream, 431, "application/json", &err("headers too large"));
            }
            if header.to_ascii_lowercase().starts_with("authorization:") {
                auth_header = header.split(':').nth(1).map(|v| v.trim().to_string());
            }
        }
        let parts: Vec<&str> = request_line.split_whitespace().collect();
        method = parts.first().copied().unwrap_or("").to_string();
        target = parts.get(1).copied().unwrap_or("").to_string();
    }

    let path = target.split('?').next().unwrap_or(&target).to_string();
    let query_token = target
        .split_once("?")
        .and_then(|(_, q)| {
            q.split('&')
                .filter_map(|pair| pair.split_once('='))
                .find(|(k, _)| *k == "token")
                .map(|(_, v)| v.to_string())
        });

    let provided = auth_header
        .as_deref()
        .map(|h| h.strip_prefix("Bearer ").unwrap_or(h).trim().to_string())
        .or(query_token);
    if !check_auth(handle, provided.as_deref()) {
        return respond(
            &mut stream,
            401,
            "application/json",
            r#"{"error":"unauthorized","hint":"pair via the QR code or send Authorization: Bearer <token>"}"#,
        );
    }

    let (status, content_type, body) = route(handle, &method, &path);
    respond(&mut stream, status, content_type, &body)
}

/// Constant-time token comparison.
pub(crate) fn check_auth(handle: &AppHandle, provided: Option<&str>) -> bool {
    let Some(expected) = current_token(handle) else {
        return false;
    };
    let Some(provided) = provided else {
        return false;
    };
    constant_eq(provided.as_bytes(), expected.as_bytes())
}

pub(crate) fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Routes a request. Returns (status, content-type, body).
fn route(handle: &AppHandle, method: &str, path: &str) -> (u16, &'static str, String) {
    match (method, path) {
        ("GET", "/") => (200, "text/html; charset=utf-8", MOBILE_HTML.to_string()),
        ("GET", "/servers") | ("GET", "/api/servers") => (200, "application/json", servers_json(handle)),
        ("GET", p) if p.starts_with("/log/") || p.starts_with("/api/log/") => {
            let id = p.rsplit('/').next().unwrap_or("");
            match tail_log(handle, id) {
                Ok(lines) => (
                    200,
                    "application/json",
                    serde_json::json!({ "lines": lines }).to_string(),
                ),
                Err(e) => (404, "application/json", err(&e)),
            }
        }
        ("POST", p) if p.starts_with("/api/servers/") => {
            let rest: Vec<&str> = p.trim_start_matches("/api/servers/").split('/').collect();
            match (rest.first(), rest.get(1)) {
                (Some(id), Some(action)) => act(handle, id, action),
                _ => (404, "application/json", err("not found")),
            }
        }
        ("POST", p) if p.starts_with("/start/") || p.starts_with("/stop/") || p.starts_with("/restart/") => {
            let mut parts = p.trim_start_matches('/').split('/');
            let action = parts.next().unwrap_or("");
            let id = parts.next().unwrap_or("");
            act(handle, id, action)
        }
        ("GET", "/health") => (200, "application/json", r#"{"status":"ok"}"#.to_string()),
        _ => (404, "application/json", err("not found")),
    }
}

pub(crate) fn servers_json(handle: &AppHandle) -> String {
    servers_json_opts(handle, false)
}

/// Server list JSON. `include_ports` adds a live port scan per running
/// instance (a netstat/ss call each), so it is opt-in — the automation API
/// exposes it via `GET /servers?ports=1` for `kern-cli list --ports`.
pub(crate) fn servers_json_opts(handle: &AppHandle, include_ports: bool) -> String {
    let cfg = match config::load_config(handle) {
        Ok(c) => c,
        Err(e) => return err(&e),
    };
    let metrics_state: tauri::State<'_, MetricsState> = handle.state();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // One process-table refresh drives every running instance (per-instance
    // refreshes would reset the CPU delta window and read ~0% for all but the
    // first). Metrics are keyed by pid.
    let running_pids: Vec<u32> = cfg
        .servers
        .iter()
        .filter(|(id, _)| process::is_running(handle, id))
        .filter_map(|(id, _)| process::pid_for(handle, id))
        .collect();
    let all_metrics = metrics_state.instances_metrics(&running_pids, "running");

    let mut out = Vec::new();
    for (id, s) in &cfg.servers {
        let running = process::is_running(handle, id);
        let adopted = process::is_adopted(handle, id);
        let pid = process::pid_for(handle, id);
        let metrics = pid
            .and_then(|pid| all_metrics.get(&pid))
            .map(|m| serde_json::json!({ "cpu": m.cpu, "ram": m.ram }));
        let uptime = pid
            .and_then(process::process_start_time)
            .map(|started| now.saturating_sub(started));
        let ports = if include_ports && running {
            tauri::async_runtime::block_on(crate::commands::get_instance_ports(
                handle.clone(),
                id.clone(),
            ))
            .ok()
            .and_then(|p| serde_json::to_value(p).ok())
            .unwrap_or(serde_json::Value::Null)
        } else {
            serde_json::Value::Null
        };
        out.push(serde_json::json!({
            "id": id,
            "name": s.name,
            "type": s.server_type,
            "group": s.group,
            "tags": s.tags,
            "status": s.status,
            "running": running,
            "adopted": adopted,
            "orphaned": s.is_orphaned,
            "autoStart": s.auto_start,
            "pid": pid,
            "uptimeSecs": uptime,
            "metrics": metrics,
            "ports": ports,
        }));
    }
    serde_json::json!({ "servers": out }).to_string()
}

/// Runs a lifecycle action, returning immediately for stop/restart (they wait
/// on the graceful window). Shared with the loopback automation server.
pub(crate) fn act(handle: &AppHandle, id: &str, action: &str) -> (u16, &'static str, String) {
    use crate::commands;
    match action {
        "start" => match commands::launch_instance(handle, id) {
            Ok(_) => (200, "application/json", r#"{"action":"started"}"#.to_string()),
            Err(e) => (500, "application/json", err(&e)),
        },
        "stop" | "restart" => {
            let h = handle.clone();
            let id = id.to_string();
            let act = action.to_string();
            std::thread::spawn(move || {
                let result = if act == "stop" {
                    tauri::async_runtime::block_on(commands::stop_server_instance(h, id))
                } else {
                    tauri::async_runtime::block_on(commands::restart_server_instance(h, id))
                };
                if let Err(e) = result {
                    eprintln!("[web-remote] {act} failed: {e}");
                }
            });
            (202, "application/json", r#"{"action":"accepted"}"#.to_string())
        }
        _ => (500, "application/json", err("unknown action")),
    }
}

/// Reads the tail of an instance's latest.log (last 200 lines, at most 2 MiB).
pub(crate) fn tail_log(handle: &AppHandle, id: &str) -> Result<Vec<String>, String> {
    let cfg = config::load_config(handle)?;
    let instance = cfg
        .servers
        .get(id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let log_path = Path::new(&instance.path).join("latest.log");
    if !log_path.exists() {
        return Ok(Vec::new());
    }
    let file = std::fs::File::open(&log_path).map_err(|e| format!("failed to open log: {e}"))?;
    let mut raw = String::new();
    file.take(MAX_LOG_BYTES)
        .read_to_string(&mut raw)
        .map_err(|e| format!("failed to read log: {e}"))?;
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(200);
    Ok(lines[start..].iter().map(|s| s.to_string()).collect())
}

pub(crate) fn respond<S: Write>(
    stream: &mut S,
    status: u16,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        401 => "Unauthorized",
        404 => "Not Found",
        400 => "Bad Request",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "Status",
    };
    let out = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(out.as_bytes())?;
    stream.flush()
}

pub(crate) fn err(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

/// Mobile control page (inline; no build step, no Tauri APIs).
const MOBILE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>kern remote</title>
<style>
  :root { --bg:#050506; --surf:#0b0c10; --grid:#161920; --green:#4cf5a0; --amber:#f5a04c; --red:#f54c4c; --dim:#4c525e; --text:#e4e4e7; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:12px calc(12px + env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left)); }
  header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
  h1 { font-size:13px; letter-spacing:.25em; text-transform:uppercase; margin:0; font-weight:600; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .card { background:var(--surf); border:1px solid var(--grid); margin-bottom:10px; }
  .card-head { padding:10px 12px; display:flex; align-items:center; gap:8px; width:100%; background:none; border:0; color:inherit; font:inherit; text-align:left; }
  .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta { font-size:11px; color:var(--dim); padding:0 12px 8px; }
  .meters { padding:0 12px 10px; font-size:11px; color:var(--dim); }
  .bar { height:4px; background:var(--grid); margin-top:4px; }
  .bar > i { display:block; height:100%; background:var(--green); width:0; transition:width .3s; }
  .bar.ram > i { background:var(--amber); }
  .actions { display:flex; border-top:1px solid var(--grid); }
  .actions button { flex:1; padding:12px 0; background:none; border:0; color:var(--text); font:600 13px ui-monospace,monospace; text-transform:uppercase; letter-spacing:.08em; }
  .actions button + button { border-left:1px solid var(--grid); }
  .actions .start { color:var(--green); }
  .actions .stop { color:var(--red); }
  button:active { opacity:.6; }
  pre.log { margin:0; padding:12px; background:#000; border:1px solid var(--grid); font-size:11px; line-height:1.5; max-height:60vh; overflow:auto; white-space:pre-wrap; word-break:break-all; }
  .empty { color:var(--dim); padding:16px 4px; font-size:12px; }
  .badge { font-size:10px; text-transform:uppercase; letter-spacing:.15em; color:var(--dim); border:1px solid var(--grid); padding:1px 5px; }
  .back { color:var(--green); background:none; border:0; font:inherit; padding:0 0 10px; }
</style>
</head>
<body>
<header>
  <h1><span class="dot" style="background:var(--green);box-shadow:0 0 6px var(--green)"></span> kern</h1>
  <span class="badge" id="conn">connecting…</span>
</header>
<main id="app"><p class="empty">loading…</p></main>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || sessionStorage.getItem('kern.token') || '';
  if (params.get('token')) {
    sessionStorage.setItem('kern.token', token);
    history.replaceState(null, '', location.pathname);
  }
  if (!token) { document.getElementById('app').innerHTML = '<p class="empty">not paired — scan the QR code from kern Settings.</p>'; return; }

  var viewing = null;
  var logTimer = null;

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + token }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('unauthorized'); }
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status); });
      return r.json();
    });
  }

  function color(status) {
    if (status === 'running') return 'var(--green)';
    if (status === 'error' || status === 'stopped-forced') return 'var(--red)';
    if (status === 'starting' || status === 'stopping' || status === 'installing') return 'var(--amber)';
    return 'var(--dim)';
  }

  function renderList(servers) {
    var app = document.getElementById('app');
    if (viewing) return;
    if (!servers.length) { app.innerHTML = '<p class="empty">no instances registered.</p>'; return; }
    var groups = {};
    servers.forEach(function (s) { var g = s.group || ''; (groups[g] = groups[g] || []).push(s); });
    var html = '';
    Object.keys(groups).sort(function (a, b) { return (a === '' ? 'zz' : a).localeCompare(b === '' ? 'zz' : b); }).forEach(function (g) {
      if (g) html += '<div class="meta" style="padding:6px 2px;text-transform:uppercase;letter-spacing:.2em">' + esc(g) + '</div>';
      groups[g].forEach(function (s) {
        var m = s.metrics || { cpu: 0, ram: 0 };
        html += '<div class="card">'
          + '<button class="card-head" data-open="' + esc(s.id) + '">'
          + '<span class="dot" style="background:' + color(s.status) + ';box-shadow:0 0 6px ' + color(s.status) + '"></span>'
          + '<span class="name">' + esc(s.name) + '</span>'
          + '<span class="badge">' + esc(s.orphaned ? 'orphan' : s.status) + '</span>'
          + '</button>'
          + '<div class="meters">cpu ' + Math.round((m.cpu || 0) * 100) + '%<div class="bar"><i style="width:' + Math.round((m.cpu || 0) * 100) + '%"></i></div>'
          + 'ram ' + Math.round((m.ram || 0) * 100) + '%<div class="bar ram"><i style="width:' + Math.round((m.ram || 0) * 100) + '%"></i></div></div>'
          + '<div class="actions">'
          + (s.running
              ? '<button data-act="restart" data-id="' + esc(s.id) + '">restart</button><button class="stop" data-act="stop" data-id="' + esc(s.id) + '">stop</button>'
              : '<button class="start" data-act="start" data-id="' + esc(s.id) + '" ' + (s.orphaned ? 'disabled' : '') + '>start</button>')
          + '</div></div>';
      });
    });
    app.innerHTML = html;
  }

  function renderLog(lines, name) {
    var html = '<button class="back" data-back="1">← back</button>'
      + '<div class="meta" style="padding:0 2px 8px">' + esc(name) + ' · latest.log</div>'
      + '<pre class="log" id="logbox">' + esc(lines.join('\n') || 'no output yet') + '</pre>';
    var app = document.getElementById('app');
    app.innerHTML = html;
    var box = document.getElementById('logbox');
    box.scrollTop = box.scrollHeight;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var lastServers = [];

  function poll() {
    api('/api/servers').then(function (data) {
      lastServers = data.servers || [];
      document.getElementById('conn').textContent = 'live';
      renderList(lastServers);
    }).catch(function () {
      document.getElementById('conn').textContent = 'offline';
    });
  }

  function pollLog(id) {
    api('/api/log/' + encodeURIComponent(id)).then(function (data) {
      var s = lastServers.find(function (x) { return x.id === id; });
      renderLog(data.lines || [], s ? s.name : id);
    }).catch(function () {});
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.open) {
      viewing = t.dataset.open;
      pollLog(viewing);
      if (logTimer) clearInterval(logTimer);
      logTimer = setInterval(function () { pollLog(viewing); }, 2500);
      return;
    }
    if (t.dataset.back) {
      viewing = null;
      if (logTimer) clearInterval(logTimer);
      renderList(lastServers);
      return;
    }
    if (t.dataset.act) {
      t.disabled = true;
      api('/api/servers/' + encodeURIComponent(t.dataset.id) + '/' + t.dataset.act, { method: 'POST' })
        .then(function () { setTimeout(poll, 800); })
        .catch(function (err) { alert(err.message); })
        .finally(function () { t.disabled = false; });
    }
  });

  poll();
  setInterval(function () { if (!viewing) poll(); }, 3000);
})();
</script>
</body>
</html>
"#;
