//! Optional web remote — self-signed HTTPS + pairing + a mobile-first
//! control panel.
//!
//! Design decisions:
//!   - Served over **HTTPS** with a self-signed certificate generated on first
//!     run (stored under `<app_data>/web_remote/`), so the browser treats it
//!     as a secure context. Via the Cloudflare tunnel the edge terminates
//!     TLS with a real certificate.
//!   - **Pairing + device tokens**, not a single shared secret: the desktop
//!     generates single-use invite codes; redeeming one creates a named device
//!     token with a role (`admin`/`operator`/`viewer`) and optional per-server
//!     scope. The original keyring token keeps working as the owner (admin).
//!     See `remote_auth`.
//!   - The panel is a purpose-built static app (`src-tauri/remote/`, embedded
//!     into the binary) rather than the desktop React app — the desktop UI
//!     depends on the Tauri IPC bridge, which a browser doesn't have.
//!   - The API is the same router the loopback automation API uses
//!     (`automation_api::route`), gated by a per-route scope policy. One
//!     implementation, no drift between CLI, desktop, and panel.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer, PrivateKeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::metrics::MetricsState;
use crate::process;
use crate::remote_auth::{self, AuthContext, Scope};

const KEYRING_SERVICE: &str = "kern.webremote";
const KEYRING_USER: &str = "token";

/// Maximum request line / header size accepted (bytes).
const MAX_HEADER_BYTES: u64 = 8 * 1024;
/// Maximum JSON request body (bytes).
const MAX_BODY_BYTES: u64 = 2 * 1024 * 1024;
/// Maximum single upload (bytes).
const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Maximum simultaneously handled connections.
const MAX_CONNECTIONS: usize = 64;
/// Maximum bytes read from latest.log for the initial console tail.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
/// Console follow read cap per poll (bytes).
const FOLLOW_READ_BYTES: u64 = 256 * 1024;
/// Console initial tail line count.
const CONSOLE_TAIL_LINES: usize = 200;
/// How long one SSE stream may stay open before the client must reconnect.
const STREAM_MAX_SECS: u64 = 12 * 3600;
/// Auth failures per IP before a cool-down.
const AUTH_FAILURE_LIMIT: u32 = 10;
/// Cool-down window for repeated auth failures.
const AUTH_FAILURE_WINDOW: Duration = Duration::from_secs(300);

/// Shared remote state (token cache + live status for the Settings UI).
#[derive(Default)]
pub struct WebRemoteState {
    token: Mutex<Option<String>>,
    pub running: AtomicBool,
    pub port: Mutex<u16>,
    /// Address the listener is bound to (the settings value at last start).
    bind: Mutex<String>,
    /// Last listener error (invalid address, bind failure, TLS) so the
    /// settings UI can show why the panel isn't reachable.
    error: Mutex<Option<String>>,
    /// Invalidates the accept loop when settings change (start/stop/restart).
    generation: std::sync::atomic::AtomicU64,
    /// Failed auth attempts keyed by peer ip.
    auth_failures: Mutex<HashMap<String, (u32, Instant)>>,
}

fn set_bind_error(app: &AppHandle, message: Option<String>) {
    let state: tauri::State<'_, WebRemoteState> = app.state();
    if let Ok(mut guard) = state.error.lock() {
        *guard = message;
    }
    let _ = app.emit("kern://web-remote-state", ());
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
    let bind = cfg.settings.web_remote_bind.trim().to_string();
    let bind = if bind.is_empty() {
        "0.0.0.0".to_string()
    } else {
        bind
    };
    let state: tauri::State<'_, WebRemoteState> = app_handle.state();
    let running = state.running.load(Ordering::SeqCst);
    let active_port = state.port.lock().map(|p| *p).unwrap_or(0);
    let active_bind = state.bind.lock().map(|b| b.clone()).unwrap_or_default();

    let stop_listener = |app: &AppHandle| {
        let state: tauri::State<'_, WebRemoteState> = app.state();
        state
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..20 {
            if !state.running.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };

    if !enabled {
        if running {
            // Bump the generation; the accept loop notices and exits.
            stop_listener(app_handle);
            set_bind_error(app_handle, None);
        }
        return;
    }

    // Validate the configured address before touching the listener so a typo
    // can't silently leave the panel unreachable.
    let parsed: std::net::IpAddr = match bind.parse() {
        Ok(ip) => ip,
        Err(_) => {
            if running {
                stop_listener(app_handle);
            }
            set_bind_error(
                app_handle,
                Some(format!(
                    "'{bind}' is not a valid IP — use 0.0.0.0 (all interfaces), 127.0.0.1 (localhost only), or one of your interface addresses"
                )),
            );
            return;
        }
    };

    if running && active_port == port && active_bind == bind {
        return;
    }

    // Restart: invalidate the old loop, wait for it to release the port, spawn.
    stop_listener(app_handle);

    // Ensure a token exists before the server accepts connections.
    if let Err(e) = load_or_create_token(app_handle) {
        eprintln!("[web-remote] could not initialise auth token: {e}");
        set_bind_error(app_handle, Some(format!("auth token unavailable: {e}")));
        return;
    }

    // A concrete bind address should be covered by the certificate; regenerate
    // when it isn't (wildcard binds are handled by the manual regenerate
    // action so a transient VPN/docker interface can't rotate the cert).
    if !cert_covers(&parsed, app_handle) {
        if let Err(e) = regenerate_cert(app_handle) {
            eprintln!("[web-remote] cert regeneration failed: {e}");
        }
    }

    set_bind_error(app_handle, None);
    let _ = state.port.lock().map(|mut p| *p = port);
    let _ = state.bind.lock().map(|mut b| *b = bind.clone());
    let generation = state.generation.load(std::sync::atomic::Ordering::SeqCst);
    let handle = app_handle.clone();
    std::thread::spawn(move || serve(&handle, parsed, port, generation));
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

/// Formats a host for use in a URL (brackets for IPv6).
fn url_host(ip: &std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(v4) => v4.to_string(),
        std::net::IpAddr::V6(v6) => format!("[{v6}]"),
    }
}

/// URLs the panel is reachable at, honoring the configured bind address.
fn display_urls(bind: &str, port: u16) -> Vec<String> {
    let mut urls = Vec::new();
    match bind.parse::<std::net::IpAddr>() {
        Ok(ip) if ip.is_unspecified() => {
            for (_, addr) in interface_ips() {
                if !addr.is_loopback() {
                    urls.push(format!("https://{}:{port}", url_host(&addr)));
                }
            }
            urls.push(format!("https://localhost:{port}"));
        }
        Ok(ip) if ip.is_loopback() => {
            urls.push(format!("https://localhost:{port}"));
        }
        Ok(ip) => {
            urls.push(format!("https://{}:{port}", url_host(&ip)));
        }
        Err(_) => {
            urls.push(format!("https://localhost:{port}"));
        }
    }
    urls
}

/// Connection info for the Settings UI: URLs + a QR SVG embedding the token.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebRemoteInfo {
    pub enabled: bool,
    pub running: bool,
    /// Address the listener is bound to (`0.0.0.0` = all interfaces).
    pub bind: String,
    pub port: u16,
    /// Non-fatal listener error (invalid address, bind failure, TLS).
    pub bind_error: Option<String>,
    /// SANs the current certificate was generated with.
    pub cert_sans: Vec<String>,
    pub token: String,
    pub urls: Vec<String>,
    pub qr_svg: String,
    /// Cloudflare tunnel status (see [`crate::tunnel`]).
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
    let bind_error = state.error.lock().ok().and_then(|e| e.clone());

    let bind = {
        let value = cfg.settings.web_remote_bind.trim().to_string();
        if value.is_empty() {
            "0.0.0.0".to_string()
        } else {
            value
        }
    };
    let urls = display_urls(&bind, port);

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
        bind,
        port,
        bind_error,
        cert_sans: stored_sans(app_handle),
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

/// Renders any string as a QR SVG (used by the settings UI for invite links).
#[tauri::command]
pub fn web_remote_qr(text: String) -> String {
    qr_svg_for(&text)
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
// Interfaces + TLS material
// ---------------------------------------------------------------------------

/// One non-link-local interface address with a coarse classification.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceInfo {
    pub name: String,
    pub ip: String,
    /// `"loopback"`, `"private"` (rfc1918 / ULA), or `"public"`.
    pub kind: String,
}

fn is_link_local(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_link_local(),
        std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

fn classify(ip: &std::net::IpAddr) -> &'static str {
    if ip.is_loopback() {
        "loopback"
    } else {
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_private() {
                    "private"
                } else {
                    "public"
                }
            }
            std::net::IpAddr::V6(v6) => {
                if (v6.segments()[0] & 0xfe00) == 0xfc00 {
                    "private"
                } else {
                    "public"
                }
            }
        }
    }
}

/// Every usable interface address on the machine (loopback first).
fn interface_ips() -> Vec<(String, std::net::IpAddr)> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut out: Vec<(String, std::net::IpAddr)> = Vec::new();
    for (name, data) in &networks {
        for network in data.ip_networks() {
            let ip = network.addr;
            if ip.is_unspecified() || is_link_local(&ip) {
                continue;
            }
            if out.iter().any(|(_, existing)| *existing == ip) {
                continue;
            }
            out.push((name.clone(), ip));
        }
    }
    out.sort_by_key(|(_, ip)| if ip.is_loopback() { 0 } else { 1 });
    out
}

/// Lists the machine's interface addresses for the bind picker.
#[tauri::command]
pub fn web_remote_interfaces() -> Vec<InterfaceInfo> {
    interface_ips()
        .into_iter()
        .map(|(name, ip)| InterfaceInfo {
            name,
            ip: ip.to_string(),
            kind: classify(&ip).to_string(),
        })
        .collect()
}

fn cert_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = config::config_dir(app_handle)?.join("web_remote");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create cert dir: {e}"))?;
    Ok(dir)
}

/// SANs a fresh certificate should carry: localhost, loopback, and every
/// current interface address.
fn default_sans() -> Vec<String> {
    let mut sans = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    for (_, ip) in interface_ips() {
        let value = ip.to_string();
        if !sans.contains(&value) {
            sans.push(value);
        }
    }
    sans
}

fn sans_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(cert_dir(app_handle)?.join("cert.sans"))
}

/// SAN list the current certificate was generated with (empty when unknown).
pub fn stored_sans(app_handle: &AppHandle) -> Vec<String> {
    sans_path(app_handle)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|raw| {
            raw.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// True when the persisted cert already covers `bind`. Wildcard binds are
/// always "covered": any interface IP is served, and rotating the certificate
/// whenever a transient adapter appears would make users re-accept it
/// constantly (the settings UI offers a manual regenerate instead).
fn cert_covers(bind: &std::net::IpAddr, app_handle: &AppHandle) -> bool {
    let cert_path = cert_dir(app_handle).map(|d| d.join("cert.der"));
    let Ok(cert_path) = cert_path else {
        return false;
    };
    if !cert_path.is_file() {
        return false;
    }
    if bind.is_unspecified() {
        return true;
    }
    let sans = stored_sans(app_handle);
    if sans.is_empty() {
        // Old cert without a recorded SAN list — regenerate to be sure.
        return false;
    }
    sans.iter().any(|s| s == &bind.to_string())
}

/// Regenerates the self-signed certificate/key with the current interface set.
pub fn regenerate_cert(app_handle: &AppHandle) -> Result<(), String> {
    let dir = cert_dir(app_handle)?;
    let cert_path = dir.join("cert.der");
    let key_path = dir.join("key.der");
    let _ = std::fs::remove_file(&cert_path);
    let _ = std::fs::remove_file(&key_path);
    let sans = default_sans();
    let certified = rcgen::generate_simple_self_signed(sans.clone())
        .map_err(|e| format!("failed to generate TLS certificate: {e}"))?;
    let cert = certified.cert.der().to_vec();
    let key = certified.key_pair.serialize_der();
    std::fs::write(&cert_path, &cert).map_err(|e| format!("failed to write cert: {e}"))?;
    std::fs::write(&key_path, &key).map_err(|e| format!("failed to write key: {e}"))?;
    std::fs::write(sans_path(app_handle)?, sans.join("\n"))
        .map_err(|e| format!("failed to write cert sans: {e}"))?;
    Ok(())
}

/// Loads the persisted DER cert/key, generating a self-signed pair on first
/// use (SANs: localhost, loopback, and every interface address).
fn load_or_create_cert(app_handle: &AppHandle) -> Result<(Vec<u8>, Vec<u8>), String> {
    let dir = cert_dir(app_handle)?;
    let cert_path = dir.join("cert.der");
    let key_path = dir.join("key.der");
    if cert_path.is_file() && key_path.is_file() {
        let cert = std::fs::read(&cert_path).map_err(|e| format!("failed to read cert: {e}"))?;
        let key = std::fs::read(&key_path).map_err(|e| format!("failed to read key: {e}"))?;
        return Ok((cert, key));
    }

    regenerate_cert(app_handle)?;
    let cert = std::fs::read(&cert_path).map_err(|e| format!("failed to read cert: {e}"))?;
    let key = std::fs::read(&key_path).map_err(|e| format!("failed to read key: {e}"))?;
    Ok((cert, key))
}

/// Regenerates the certificate and restarts the listener so it takes effect.
#[tauri::command]
pub fn web_remote_regenerate_cert(app_handle: AppHandle) -> Result<WebRemoteInfo, String> {
    regenerate_cert(&app_handle)?;
    apply_settings(&app_handle);
    build_info(&app_handle)
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

fn serve(handle: &AppHandle, bind: std::net::IpAddr, port: u16, generation: u64) {
    let tls = match tls_config(handle) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("[web-remote] TLS setup failed: {e}");
            set_bind_error(handle, Some(format!("TLS setup failed: {e}")));
            return;
        }
    };
    let listener = match TcpListener::bind(std::net::SocketAddr::new(bind, port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[web-remote] failed to bind {bind}:{port}: {e}");
            set_bind_error(
                handle,
                Some(format!("failed to bind {bind}:{port} — {e}")),
            );
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
    eprintln!("[web-remote] listening on https://{bind}:{port} (paired devices only)");
    let _ = handle.emit("kern://web-remote-state", ());

    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    loop {
        let state: tauri::State<'_, WebRemoteState> = handle.state();
        if state.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
            break;
        }
        match listener.accept() {
            Ok((tcp, peer)) => {
                let _ = tcp.set_nonblocking(false);
                let current = active.load(Ordering::SeqCst);
                if current >= MAX_CONNECTIONS {
                    continue; // shed load; the handshake would fail anyway
                }
                let _ = tcp.set_read_timeout(Some(Duration::from_secs(10)));
                let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));
                let tls = tls.clone();
                let h = handle.clone();
                let active = active.clone();
                active.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    if let Ok(conn) = ServerConnection::new(tls) {
                        let stream = StreamOwned::new(conn, tcp);
                        let _ = handle_conn(&h, stream, peer);
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
pub(crate) fn read_line_capped<R: BufRead>(
    reader: &mut R,
    out: &mut String,
    cap: u64,
) -> std::io::Result<u64> {
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

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

struct RequestHead {
    method: String,
    target: String,
    auth_header: Option<String>,
    content_length: Option<u64>,
}

/// Outcome of the header/body phase. Response writing happens after the
/// BufReader drops, so the raw stream is free again.
enum Phase {
    Ready {
        method: String,
        path: String,
        query: String,
        body: String,
        auth: AuthContext,
    },
    Asset {
        content_type: &'static str,
        bytes: Vec<u8>,
    },
    Json {
        status: u16,
        body: String,
    },
    Uploaded {
        bytes: u64,
    },
    Console {
        id: String,
        auth: AuthContext,
    },
    Events {
        auth: AuthContext,
    },
    Download {
        id: String,
        query: String,
        auth: AuthContext,
    },
    Fail {
        status: u16,
        message: &'static str,
        auth_failure: bool,
    },
}

fn handle_conn<S: Read + Write>(
    handle: &AppHandle,
    mut stream: S,
    peer: SocketAddr,
) -> std::io::Result<()> {
    let peer_key = peer.ip().to_string();

    // Header + body phase. The BufReader borrows the stream, so everything
    // that touches the body happens in `handle_request`; responses are written
    // after the reader drops.
    let phase = {
        let mut reader = BufReader::new(&mut stream);
        handle_request(handle, &mut reader, &peer_key)
    };

    match phase {
        Phase::Ready {
            method,
            path,
            query,
            body,
            auth,
        } => {
            let (status, content_type, response) =
                dispatch(handle, &method, &path, &query, &body, &auth);
            respond(&mut stream, status, content_type, &response)
        }
        Phase::Asset {
            content_type,
            bytes,
        } => respond_bytes(&mut stream, 200, content_type, &bytes),
        Phase::Json { status, body } => {
            respond(&mut stream, status, "application/json", &body)
        }
        Phase::Uploaded { bytes } => respond(
            &mut stream,
            200,
            "application/json",
            &serde_json::json!({ "ok": true, "bytes": bytes }).to_string(),
        ),
        Phase::Console { id, auth } => console_stream(handle, &mut stream, &auth, &id),
        Phase::Events { auth } => events_stream(handle, &mut stream, &auth),
        Phase::Download { id, query, auth } => {
            download_file(handle, &mut stream, &auth, &id, &query)
        }
        Phase::Fail {
            status,
            message,
            auth_failure,
        } => {
            if auth_failure {
                note_auth_failure(handle, &peer_key);
            }
            fail(stream, (status, message))
        }
    }
}

fn handle_request<R: BufRead>(
    handle: &AppHandle,
    reader: &mut R,
    peer_key: &str,
) -> Phase {
    let head = match parse_head(reader) {
        Ok(head) => head,
        Err((status, message, _)) => {
            return Phase::Fail {
                status,
                message,
                auth_failure: false,
            }
        }
    };
    let path = head.target.split('?').next().unwrap_or("").to_string();
    let query = head
        .target
        .split_once('?')
        .map(|(_, q)| q.to_string())
        .unwrap_or_default();

    // Public surface: the panel shell, assets, health, pairing.
    if is_public_path(&head.method, &path) {
        match (head.method.as_str(), path.as_str()) {
            ("POST", "/api/pair") => {
                let body = match read_body(reader, head.content_length) {
                    Ok(b) => b,
                    Err((status, message)) => {
                        return Phase::Fail {
                            status,
                            message,
                            auth_failure: false,
                        }
                    }
                };
                if is_rate_limited(handle, peer_key) {
                    return Phase::Fail {
                        status: 429,
                        message: "too many attempts — wait a few minutes",
                        auth_failure: false,
                    };
                }
                let (status, body) = pair_device(handle, &body);
                if status >= 400 {
                    note_auth_failure(handle, peer_key);
                }
                return Phase::Json { status, body };
            }
            ("GET", "/api/invite") => {
                let code = query_value(&query, "code").unwrap_or_default();
                let (status, body) = invite_preview(handle, &code);
                return Phase::Json { status, body };
            }
            ("GET", "/health") => {
                return Phase::Json {
                    status: 200,
                    body: r#"{"status":"ok"}"#.to_string(),
                }
            }
            ("GET", _) => {
                if let Some((content_type, bytes)) = asset(&path) {
                    return Phase::Asset {
                        content_type,
                        bytes,
                    };
                }
                return Phase::Fail {
                    status: 404,
                    message: "not found",
                    auth_failure: false,
                };
            }
            _ => {
                return Phase::Fail {
                    status: 404,
                    message: "not found",
                    auth_failure: false,
                }
            }
        }
    }

    // Everything else needs an identity.
    let auth = match resolve_auth(handle, provided_token(&head, &query)) {
        Some(auth) => auth,
        None => {
            return Phase::Fail {
                status: 401,
                message: "unauthorized — pair this device from kern settings",
                auth_failure: true,
            }
        }
    };
    note_auth_success(handle, peer_key);

    // Streaming + binary endpoints need the raw stream, not a buffered body.
    let seg = segments(&path);
    match (head.method.as_str(), seg.as_slice()) {
        ("GET", ["api", "servers", id, "console"]) => Phase::Console {
            id: id.to_string(),
            auth,
        },
        ("GET", ["api", "events"]) => Phase::Events { auth },
        ("GET", ["api", "servers", id, "download"]) => Phase::Download {
            id: id.to_string(),
            query,
            auth,
        },
        ("POST", ["api", "servers", id, "upload"]) => {
            let rel = query_value(&query, "path").unwrap_or_default();
            match stream_upload(reader, handle, &auth, id, rel, head.content_length) {
                Ok(bytes) => Phase::Uploaded { bytes },
                Err((status, message)) => Phase::Fail {
                    status,
                    message,
                    auth_failure: false,
                },
            }
        }
        _ => {
            let body = match read_body(reader, head.content_length) {
                Ok(b) => b,
                Err((status, message)) => {
                    return Phase::Fail {
                        status,
                        message,
                        auth_failure: false,
                    }
                }
            };
            Phase::Ready {
                method: head.method,
                path,
                query,
                body,
                auth,
            }
        }
    }
}

fn parse_head<R: BufRead>(reader: &mut R) -> Result<RequestHead, (u16, &'static str, &'static str)> {
    let mut request_line = String::new();
    let read = read_line_capped(reader, &mut request_line, MAX_HEADER_BYTES)
        .map_err(|_| (400, "bad request", ""))?;
    if read == 0 || read >= MAX_HEADER_BYTES || !request_line.ends_with('\n') {
        return Err((400, "bad request", ""));
    }
    let mut auth_header: Option<String> = None;
    let mut content_length: Option<u64> = None;
    let mut header_bytes = read;
    loop {
        let mut header = String::new();
        let n = read_line_capped(reader, &mut header, MAX_HEADER_BYTES)
            .map_err(|_| (400, "bad request", ""))?;
        header_bytes += n;
        if n == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        if header_bytes >= MAX_HEADER_BYTES {
            return Err((431, "headers too large", ""));
        }
        let lower = header.to_ascii_lowercase();
        if lower.starts_with("authorization:") {
            auth_header = header.split(':').nth(1).map(|v| v.trim().to_string());
        } else if lower.starts_with("content-length:") {
            content_length = header
                .split(':')
                .nth(1)
                .and_then(|v| v.trim().parse::<u64>().ok());
        }
    }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    Ok(RequestHead {
        method: parts.first().copied().unwrap_or("").to_string(),
        target: parts.get(1).copied().unwrap_or("").to_string(),
        auth_header,
        content_length,
    })
}

fn read_body<R: BufRead>(reader: &mut R, length: Option<u64>) -> Result<String, (u16, &'static str)> {
    let Some(len) = length else {
        return Ok(String::new());
    };
    if len > MAX_BODY_BYTES {
        return Err((413, "body too large"));
    }
    let mut buf = vec![0u8; len as usize];
    reader
        .read_exact(&mut buf)
        .map_err(|_| (400, "incomplete body"))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn provided_token(head: &RequestHead, query: &str) -> Option<String> {
    head.auth_header
        .as_deref()
        .map(|h| h.strip_prefix("Bearer ").unwrap_or(h).trim().to_string())
        .or_else(|| query_value(query, "token"))
}

fn resolve_auth(handle: &AppHandle, provided: Option<String>) -> Option<AuthContext> {
    let provided = provided?;
    if provided.trim().is_empty() {
        return None;
    }
    // Owner: the keyring token keeps working as an implicit admin.
    if let Some(expected) = current_token(handle) {
        if constant_eq(provided.trim().as_bytes(), expected.as_bytes()) {
            return Some(remote_auth::owner_context());
        }
    }
    // Managed devices: users + scoped roles.
    remote_auth::authenticate(handle, provided.trim())
}

fn is_rate_limited(handle: &AppHandle, ip: &str) -> bool {
    let state: tauri::State<'_, WebRemoteState> = handle.state();
    let Ok(map) = state.auth_failures.lock() else {
        return false;
    };
    match map.get(ip) {
        Some((count, at)) if at.elapsed() < AUTH_FAILURE_WINDOW => *count >= AUTH_FAILURE_LIMIT,
        _ => false,
    }
}

fn note_auth_failure(handle: &AppHandle, ip: &str) {
    let state: tauri::State<'_, WebRemoteState> = handle.state();
    if let Ok(mut map) = state.auth_failures.lock() {
        let entry = map.entry(ip.to_string()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= AUTH_FAILURE_WINDOW {
            *entry = (1, Instant::now());
        } else {
            entry.0 += 1;
        }
    };
}

fn note_auth_success(handle: &AppHandle, ip: &str) {
    let state: tauri::State<'_, WebRemoteState> = handle.state();
    if let Ok(mut map) = state.auth_failures.lock() {
        map.remove(ip);
    };
}

// ---------------------------------------------------------------------------
// Public endpoints: pairing, session, assets
// ---------------------------------------------------------------------------

// Embedded panel assets (generated by build.rs from `remote-dist/`).
mod embedded {
    include!(concat!(env!("OUT_DIR"), "/remote_assets.rs"));
}

fn mime_for(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".webmanifest") || path.ends_with(".json") {
        "application/manifest+json"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".txt") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn pair_device(handle: &AppHandle, body: &str) -> (u16, String) {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (400, err("invalid JSON body")),
    };
    let Some(code) = parsed.get("code").and_then(|v| v.as_str()) else {
        return (400, err("code is required"));
    };
    let device = parsed
        .get("device")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown device");
    match remote_auth::redeem_invite(handle, code, device) {
        Ok((context, token)) => (
            200,
            serde_json::json!({ "token": token, "user": context }).to_string(),
        ),
        Err(e) => (401, err(&e)),
    }
}

fn invite_preview(handle: &AppHandle, code: &str) -> (u16, String) {
    if code.trim().is_empty() {
        return (400, err("code is required"));
    }
    match remote_auth::invite_info(handle, code) {
        Ok(info) => (200, serde_json::to_string(&info).unwrap_or_default()),
        Err(e) => (404, err(&e)),
    }
}

fn fail<S: Write>(mut stream: S, (status, message): (u16, &'static str)) -> std::io::Result<()> {
    let body = err(message);
    respond(&mut stream, status, "application/json", &body)
}

/// Loads a panel asset. Debug builds read from `src-tauri/remote-dist/` so a
/// `remote:build` (or watch) applies without recompiling the Rust side;
/// release builds serve the bytes embedded by `build.rs`.
fn asset(path: &str) -> Option<(&'static str, Vec<u8>)> {
    let rel = if path == "/" || path.is_empty() {
        "/index.html"
    } else {
        path
    };
    if rel.contains("..") {
        return None;
    }

    #[cfg(debug_assertions)]
    {
        let disk = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("remote-dist")
            .join(rel.trim_start_matches('/'));
        if let Ok(bytes) = std::fs::read(&disk) {
            return Some((mime_for(rel), bytes));
        }
    }

    embedded::REMOTE_ASSETS
        .iter()
        .find(|(name, _)| *name == rel)
        .map(|(_, bytes)| (mime_for(rel), bytes.to_vec()))
}

/// True when the request targets the public panel shell (no data inside) or
/// the unauthenticated pairing endpoints; everything under `/api/` otherwise
/// requires a device token.
fn is_public_path(method: &str, path: &str) -> bool {
    if method == "POST" && path == "/api/pair" {
        return true;
    }
    if method == "GET" && path == "/api/invite" {
        return true;
    }
    method == "GET" && !path.starts_with("/api/")
}

// ---------------------------------------------------------------------------
// API dispatch: scope policy + automation router
// ---------------------------------------------------------------------------

fn segments(path: &str) -> Vec<&str> {
    path.trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| percent_decode(v))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
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
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Minimum scope required for a route. Unknown routes default to admin so a
/// new API endpoint can never leak to a viewer by accident.
fn required_scope(method: &str, seg: &[&str]) -> Scope {
    use Scope::*;
    match (method, seg) {
        ("GET", ["status"]) | ("GET", ["health"]) => View,
        ("GET", ["servers"]) => View,
        ("GET", ["servers", _]) => View,
        (
            "GET",
            [
                "servers",
                _,
                "log" | "metrics" | "energy" | "preflight" | "crash" | "tasks" | "backups"
                | "files" | "file" | "search" | "snapshots" | "snapshot",
            ],
        ) => View,
        ("GET", ["host", "metrics"]) => View,
        ("GET", ["inspect"]) => View,
        ("GET", ["plugins"]) => View,
        ("GET", ["audit"]) => View,
        ("GET", ["events"]) => View,
        ("POST", ["servers", _, "stdin"]) => Control,
        ("POST", ["servers", _, "start" | "stop" | "restart" | "install"]) => Control,
        ("POST", ["servers", _, "backup"]) => Control,
        ("POST", ["servers", _, "tasks", _, "run"]) => Control,
        ("POST", ["servers", _, "backups", _, "restore"]) => Control,
        ("DELETE", ["servers", _, "backups", _]) => Control,
        ("PUT", ["servers", _, "file"]) => Control,
        ("POST", ["servers", _, "files"]) => Control,
        ("POST", ["servers", _, "snapshots"]) => Control,
        ("POST", ["servers", _, "snapshots", "restore"]) => Control,
        ("DELETE", ["servers", _, "snapshots"]) => Control,
        // Creating/removing instances, installing plugins: admin only.
        ("POST", ["servers"]) => Admin,
        ("PATCH", ["servers", _]) => Admin,
        ("DELETE", ["servers", _]) => Admin,
        ("POST", ["plugins", "install" | "validate"]) => Admin,
        ("DELETE", ["plugins", _]) => Admin,
        ("POST", ["plugins", _]) | ("GET", ["plugins", _]) => Admin,
        _ => Admin,
    }
}

fn dispatch(
    handle: &AppHandle,
    method: &str,
    path: &str,
    query: &str,
    body: &str,
    auth: &AuthContext,
) -> (u16, &'static str, String) {
    // Panel management endpoints live under /api/remote/* and never touch the
    // automation router.
    if let Some(rest) = path.strip_prefix("/api/remote") {
        return remote_admin(handle, method, rest, body, auth);
    }

    let Some(api_path) = path.strip_prefix("/api") else {
        return (404, "application/json", err("not found"));
    };
    let api_seg = segments(api_path);

    let needed = required_scope(method, &api_seg);
    if !auth.allows_scope(needed) {
        return (
            403,
            "application/json",
            err("your role doesn't allow this action"),
        );
    }
    if let ["servers", id, ..] = api_seg.as_slice() {
        if !id.is_empty() && !auth.allows_server(id) {
            return (
                403,
                "application/json",
                err("this device isn't scoped to that server"),
            );
        }
    }

    let (status, content_type, response) = crate::automation_api::route(handle, method, api_path, query, body);

    // Attribute every successful mutation in the audit log.
    if matches!(method, "POST" | "PUT" | "PATCH" | "DELETE") && status < 400 {
        let server_id = match api_seg.as_slice() {
            ["servers", id, ..] if !id.is_empty() => Some(*id),
            _ => None,
        };
        let detail = format!("{method} {api_path} by {}", auth.name);
        crate::audit::record(handle, "remote", &detail, server_id);
    }

    (status, content_type, response)
}

/// Panel-specific administration: session info, remote status, people,
/// invites, tunnel toggle.
fn remote_admin(
    handle: &AppHandle,
    method: &str,
    rest: &str,
    body: &str,
    auth: &AuthContext,
) -> (u16, &'static str, String) {
    let seg = segments(rest);
    let json = |v: serde_json::Value| (200, "application/json", v.to_string());

    match (method, seg.as_slice()) {
        ("GET", ["session"]) => json(serde_json::json!({ "user": auth })),
        ("GET", ["status"]) => {
            let tunnel = crate::tunnel::info(handle);
            let cfg = config::load_config(handle).ok();
            let state: tauri::State<'_, WebRemoteState> = handle.state();
            let bind_error = state.error.lock().ok().and_then(|e| e.clone());
            let bind = cfg
                .as_ref()
                .map(|c| c.settings.web_remote_bind.clone())
                .filter(|b| !b.trim().is_empty())
                .unwrap_or_else(|| "0.0.0.0".to_string());
            let port = cfg.as_ref().map(|c| c.settings.web_remote_port).unwrap_or(7440);
            json(serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "tunnel": tunnel,
                "registryUrl": cfg.as_ref().map(|c| c.settings.registry_url.clone()),
                "bind": bind,
                "port": port,
                "bindError": bind_error,
                "urls": display_urls(&bind, port),
            }))
        }
        ("POST", ["tunnel"]) => {
            if !auth.allows_scope(Scope::Admin) {
                return (403, "application/json", err("admins only"));
            }
            let parsed: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, "application/json", err("invalid JSON body")),
            };
            let Some(enabled) = parsed.get("enabled").and_then(|v| v.as_bool()) else {
                return (400, "application/json", err("enabled is required"));
            };
            if let Err(e) = config::with_config_mut(handle, |cfg| {
                cfg.settings.cf_tunnel_enabled = enabled;
                Ok(())
            }) {
                return (500, "application/json", err(&e));
            }
            crate::tunnel::apply_settings(handle);
            crate::audit::record(
                handle,
                "remote",
                &format!("tunnel {}", if enabled { "on" } else { "off" }),
                None,
            );
            let tunnel = crate::tunnel::info(handle);
            json(serde_json::json!({ "tunnel": tunnel }))
        }
        ("GET", ["people"]) => {
            if !auth.allows_scope(Scope::Admin) {
                return (403, "application/json", err("admins only"));
            }
            match remote_auth::people(handle) {
                Ok(people) => (200, "application/json", serde_json::to_string(&people).unwrap_or_default()),
                Err(e) => (500, "application/json", err(&e)),
            }
        }
        ("POST", ["invites"]) => {
            if !auth.allows_scope(Scope::Admin) {
                return (403, "application/json", err("admins only"));
            }
            let parsed: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, "application/json", err("invalid JSON body")),
            };
            let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("guest");
            let role = parsed.get("role").and_then(|v| v.as_str()).unwrap_or("viewer");
            let servers = parsed.get("servers").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<_>>()
            });
            let ttl = parsed.get("ttlSecs").and_then(|v| v.as_u64());
            match remote_auth::create_invite(handle, name, role, servers, ttl) {
                Ok(invite) => {
                    crate::audit::record(
                        handle,
                        "remote",
                        &format!("invite created for {} ({})", invite.name, role),
                        None,
                    );
                    (201, "application/json", serde_json::to_string(&invite).unwrap_or_default())
                }
                Err(e) => (400, "application/json", err(&e)),
            }
        }
        ("POST", ["invites", "revoke"]) => {
            if !auth.allows_scope(Scope::Admin) {
                return (403, "application/json", err("admins only"));
            }
            let parsed: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, "application/json", err("invalid JSON body")),
            };
            let Some(code) = parsed.get("code").and_then(|v| v.as_str()) else {
                return (400, "application/json", err("code is required"));
            };
            match remote_auth::revoke_invite(handle, code) {
                Ok(()) => json(serde_json::json!({ "ok": true })),
                Err(e) => (404, "application/json", err(&e)),
            }
        }
        ("POST", ["devices", "revoke"]) => {
            if !auth.allows_scope(Scope::Admin) {
                return (403, "application/json", err("admins only"));
            }
            let parsed: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, "application/json", err("invalid JSON body")),
            };
            let Some(id) = parsed.get("id").and_then(|v| v.as_str()) else {
                return (400, "application/json", err("id is required"));
            };
            match remote_auth::revoke_device(handle, id) {
                Ok(()) => json(serde_json::json!({ "ok": true })),
                Err(e) => (404, "application/json", err(&e)),
            }
        }
        ("POST", ["users", "remove"]) => {
            if !auth.allows_scope(Scope::Admin) {
                return (403, "application/json", err("admins only"));
            }
            let parsed: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, "application/json", err("invalid JSON body")),
            };
            let Some(id) = parsed.get("id").and_then(|v| v.as_str()) else {
                return (400, "application/json", err("id is required"));
            };
            match remote_auth::remove_user(handle, id) {
                Ok(()) => json(serde_json::json!({ "ok": true })),
                Err(e) => (404, "application/json", err(&e)),
            }
        }
        _ => (404, "application/json", err("not found")),
    }
}

// ---------------------------------------------------------------------------
// Streaming endpoints
// ---------------------------------------------------------------------------

fn write_chunk<S: Write>(stream: &mut S, data: &[u8]) -> std::io::Result<()> {
    write!(stream, "{:x}\r\n", data.len())?;
    stream.write_all(data)?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

fn write_chunk_end<S: Write>(stream: &mut S) -> std::io::Result<()> {
    stream.write_all(b"0\r\n\r\n")?;
    stream.flush()
}

fn sse_event<S: Write>(stream: &mut S, event: &str, data: &str) -> std::io::Result<()> {
    let frame = format!("event: {event}\ndata: {data}\n\n");
    write_chunk(stream, frame.as_bytes())
}

fn start_stream<S: Write>(stream: &mut S, content_type: &str) -> std::io::Result<()> {
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(headers.as_bytes())?;
    stream.flush()
}

fn instance_log_path(handle: &AppHandle, id: &str) -> Option<PathBuf> {
    let cfg = config::load_config(handle).ok()?;
    let instance = cfg.servers.get(id)?;
    Some(Path::new(&instance.path).join("latest.log"))
}

fn server_status_json(handle: &AppHandle, id: &str) -> serde_json::Value {
    let cfg = config::load_config(handle).ok();
    let status = cfg
        .as_ref()
        .and_then(|c| c.servers.get(id))
        .map(|s| s.status.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let running = process::is_running(handle, id);
    serde_json::json!({ "id": id, "status": status, "running": running })
}

/// Reads new bytes from `offset`; returns (lines, next_offset, reset).
fn read_log_since(path: &Path, offset: u64) -> std::io::Result<(Vec<String>, u64, bool)> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len < offset {
        // Rotation: start from the beginning of the fresh file.
        let mut raw = String::new();
        file.read_to_string(&mut raw)?;
        let lines = raw
            .lines()
            .map(|s| s.to_string())
            .collect::<Vec<String>>();
        return Ok((lines, len, true));
    }
    if len == offset {
        return Ok((Vec::new(), offset, false));
    }
    file.seek(SeekFrom::Start(offset))?;
    let take = (len - offset).min(FOLLOW_READ_BYTES);
    let mut buf = vec![0u8; take as usize];
    let read = file.read(&mut buf)?;
    let raw = String::from_utf8_lossy(&buf[..read]).to_string();
    let complete = raw.ends_with('\n');
    let mut lines: Vec<String> = raw.lines().map(|s| s.to_string()).collect();
    let mut next = offset + read as u64;
    if !complete {
        // Leave the partial line for the next poll.
        if lines.pop().is_some() {
            next -= raw.rsplit('\n').next().map(|s| s.len() as u64).unwrap_or(0);
        }
    }
    Ok((lines, next, false))
}

fn console_stream<S: Read + Write>(
    handle: &AppHandle,
    stream: &mut S,
    auth: &AuthContext,
    id: &str,
) -> std::io::Result<()> {
    if !auth.allows_scope(Scope::View) || !auth.allows_server(id) {
        return respond(stream, 403, "application/json", &err("not allowed"));
    }
    let Some(log_path) = instance_log_path(handle, id) else {
        return respond(stream, 404, "application/json", &err("server not found"));
    };
    let state: tauri::State<'_, WebRemoteState> = handle.state();
    let generation = state.generation.load(Ordering::SeqCst);

    start_stream(stream, "text/event-stream")?;

    // Initial tail: the last N lines, then follow from the file end.
    let mut offset = 0u64;
    if let Ok(mut file) = std::fs::File::open(&log_path) {
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        offset = len;
        let start = len.saturating_sub(MAX_LOG_BYTES);
        let _ = file.seek(SeekFrom::Start(start));
        let mut raw = String::new();
        let _ = file.read_to_string(&mut raw);
        let lines: Vec<&str> = raw.lines().collect();
        let start = lines.len().saturating_sub(CONSOLE_TAIL_LINES);
        let tail: Vec<String> = lines[start..].iter().map(|s| s.to_string()).collect();
        sse_event(
            stream,
            "tail",
            &serde_json::json!({ "lines": tail }).to_string(),
        )?;
    }
    sse_event(stream, "status", &server_status_json(handle, id).to_string())?;

    let started = Instant::now();
    let mut last_status = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        if state.generation.load(Ordering::SeqCst) != generation
            || started.elapsed().as_secs() > STREAM_MAX_SECS
        {
            break;
        }
        if let Ok((lines, next, reset)) = read_log_since(&log_path, offset) {
            if reset {
                sse_event(stream, "reset", "{}")?;
            }
            offset = next;
            if !lines.is_empty() {
                sse_event(
                    stream,
                    "log",
                    &serde_json::json!({ "lines": lines }).to_string(),
                )?;
            }
        }
        if last_status.elapsed().as_secs() >= 2 {
            last_status = Instant::now();
            sse_event(stream, "status", &server_status_json(handle, id).to_string())?;
        }
        if last_ping.elapsed().as_secs() >= 15 {
            last_ping = Instant::now();
            write_chunk(stream, b": ping\n\n")?;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    let _ = write_chunk_end(stream);
    Ok(())
}

fn events_stream<S: Read + Write>(
    handle: &AppHandle,
    stream: &mut S,
    auth: &AuthContext,
) -> std::io::Result<()> {
    if !auth.allows_scope(Scope::View) {
        return respond(stream, 403, "application/json", &err("not allowed"));
    }
    let state: tauri::State<'_, WebRemoteState> = handle.state();
    let generation = state.generation.load(Ordering::SeqCst);

    start_stream(stream, "text/event-stream")?;

    let mut last_fingerprint = String::new();
    let mut last_audit = crate::audit::read(handle, 1)
        .first()
        .map(|e| e.at)
        .unwrap_or(0);
    let started = Instant::now();
    let mut last_ping = Instant::now();

    loop {
        if state.generation.load(Ordering::SeqCst) != generation
            || started.elapsed().as_secs() > STREAM_MAX_SECS
        {
            break;
        }
        // Status fingerprint (only send when it changes).
        let cfg = config::load_config(handle).ok();
        let mut entries: Vec<serde_json::Value> = Vec::new();
        if let Some(cfg) = cfg {
            let mut ids: Vec<&String> = cfg.servers.keys().collect();
            ids.sort();
            for id in ids {
                let running = process::is_running(handle, id);
                let status = cfg.servers.get(id).map(|s| s.status.clone());
                entries.push(serde_json::json!({
                    "id": id,
                    "status": status,
                    "running": running,
                }));
            }
        }
        let fingerprint = serde_json::to_string(&entries).unwrap_or_default();
        if fingerprint != last_fingerprint {
            last_fingerprint = fingerprint;
            sse_event(stream, "statuses", &serde_json::json!({ "servers": entries }).to_string())?;
        }
        // Audit deltas.
        let audits = crate::audit::read(handle, 50);
        let fresh: Vec<_> = audits.iter().filter(|e| e.at > last_audit).collect();
        if !fresh.is_empty() {
            last_audit = fresh.iter().map(|e| e.at).max().unwrap_or(last_audit);
            let payload = serde_json::to_string(&fresh).unwrap_or_default();
            sse_event(stream, "audit", &payload)?;
        }
        if last_ping.elapsed().as_secs() >= 15 {
            last_ping = Instant::now();
            write_chunk(stream, b": ping\n\n")?;
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    let _ = write_chunk_end(stream);
    Ok(())
}

fn download_file<S: Read + Write>(
    handle: &AppHandle,
    stream: &mut S,
    auth: &AuthContext,
    id: &str,
    query: &str,
) -> std::io::Result<()> {
    if !auth.allows_scope(Scope::View) || !auth.allows_server(id) {
        return respond(stream, 403, "application/json", &err("not allowed"));
    }
    let Some(rel) = query_value(query, "path").filter(|p| !p.trim().is_empty()) else {
        return respond(stream, 400, "application/json", &err("path is required"));
    };
    let Some(path) = resolve_instance_path(handle, id, &rel) else {
        return respond(stream, 400, "application/json", &err("invalid path"));
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return respond(stream, 404, "application/json", &err("file not found"));
    };
    if !meta.is_file() {
        return respond(stream, 400, "application/json", &err("not a file"));
    }
    let Ok(mut file) = std::fs::File::open(&path) else {
        return respond(stream, 500, "application/json", &err("failed to open file"));
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        meta.len(),
        name.replace('"', "")
    );
    stream.write_all(headers.as_bytes())?;
    std::io::copy(&mut file, stream)?;
    stream.flush()
}

fn stream_upload<R: BufRead>(
    reader: &mut R,
    handle: &AppHandle,
    auth: &AuthContext,
    id: &str,
    rel: String,
    content_length: Option<u64>,
) -> Result<u64, (u16, &'static str)> {
    if !auth.allows_scope(Scope::Control) || !auth.allows_server(id) {
        return Err((403, "not allowed"));
    }
    let Some(len) = content_length else {
        return Err((411, "content-length required"));
    };
    if len > MAX_UPLOAD_BYTES {
        return Err((413, "file too large"));
    }
    if rel.trim().is_empty() {
        return Err((400, "path query parameter is required"));
    }
    let Some(path) = resolve_instance_path(handle, id, &rel) else {
        return Err((400, "invalid path"));
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = std::fs::File::create(&path).map_err(|_| (500, "failed to create file"))?;
    let mut limited = reader.take(len);
    let copied = std::io::copy(&mut limited, &mut file).map_err(|_| (500, "upload failed"))?;
    if copied != len {
        return Err((400, "incomplete upload"));
    }
    Ok(copied)
}

/// Resolves a path inside an instance folder, rejecting traversal.
fn resolve_instance_path(handle: &AppHandle, id: &str, rel: &str) -> Option<PathBuf> {
    let cfg = config::load_config(handle).ok()?;
    let instance = cfg.servers.get(id)?;
    crate::paths::safe_join(Path::new(&instance.path), rel).ok()
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

pub(crate) fn respond<S: Write>(
    stream: &mut S,
    status: u16,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        400 => "Bad Request",
        411 => "Length Required",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
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

fn respond_bytes<S: Write>(
    stream: &mut S,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Status" };
    let out = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(out.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

pub(crate) fn err(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
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

// ---------------------------------------------------------------------------
// Server list + actions (shared with the automation router)
// ---------------------------------------------------------------------------

/// Server list JSON. `include_ports` adds a live port scan per running
/// instance (a netstat/ss call each), so it is opt-in.
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

