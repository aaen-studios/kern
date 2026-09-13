//! Cloudflare tunnels for the web remote.
//!
//! Two flavours, both run `cloudflared` as a hidden child process:
//!
//!   * **quick** — `cloudflared tunnel --url https://localhost:<port>
//!     --no-tls-verify` publishes a random `*.trycloudflare.com` URL. No
//!     account, no port forwarding; the connector dials out to Cloudflare.
//!   * **named** — `cloudflared tunnel run --token <token>` connects a tunnel
//!     created in the Cloudflare Zero Trust dashboard, so the panel lives at
//!     a stable hostname on the user's own domain. The connector token lives
//!     in the OS credential vault, never in config.json.
//!
//! Binary resolution: a `cloudflared` on PATH is used as-is; otherwise kern
//! downloads the official release binary into `<app_data>/bin/` on request
//! (`tunnel_download_binary`). Nothing is downloaded without that call.
//!
//! Isolation: cloudflared defaults to `~/.cloudflared/config.yml`. A user with
//! a named tunnel there would have it loaded instead of the quick tunnel (the
//! connector registers the named tunnel while the banner advertises a quick
//! hostname that never routes → endless 404s). kern passes its own
//! `--config <app_data>/tunnel.yml` so user config is never touched.
//!
//! Resilience: an unexpected exit restarts the connector with backoff (the
//! tunnel is expected to stay up while the setting is on), and the exit is
//! surfaced in the settings UI / panel while it happens.
//!
//! Security: a public URL is a public credential. The web remote's device
//! tokens still gate every request, but tunnel URLs are exposed, so the tunnel
//! is opt-in and off by default. Named tunnels can additionally be protected
//! with Cloudflare Access at the edge.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::process;

const NAMED_KEYRING_SERVICE: &str = "kern.cftunnel";
const NAMED_KEYRING_USER: &str = "token";

/// Shared tunnel state. `generation` invalidates reader/watcher threads from a
/// previous start so quick toggles can't cross-wire their state.
#[derive(Default)]
pub struct TunnelState {
    generation: AtomicU64,
    running: AtomicBool,
    /// Consecutive restart attempts (reset after a healthy run).
    restart_attempts: AtomicU32,
    url: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    child: Mutex<Option<Arc<Mutex<Child>>>>,
    port: Mutex<u16>,
    mode: Mutex<String>,
    started_at: Mutex<Option<Instant>>,
}

/// Snapshot for the settings UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    /// Setting on *and* the web remote on — i.e. the tunnel should be up.
    pub enabled: bool,
    pub running: bool,
    pub url: Option<String>,
    pub error: Option<String>,
    /// Whether a cloudflared binary was found (PATH or managed).
    pub binary_found: bool,
    pub binary: Option<String>,
    /// True when the binary came from our managed `<app_data>/bin` copy.
    pub managed: bool,
    /// `"quick"` or `"named"`.
    pub mode: String,
    /// Configured hostname for named tunnels (display only).
    pub hostname: Option<String>,
    /// True when a named-tunnel connector token is stored.
    pub named_token_set: bool,
}

fn state_generation(app: &AppHandle) -> u64 {
    app.state::<TunnelState>().generation.load(Ordering::SeqCst)
}

fn set_url(app: &AppHandle, url: Option<String>) {
    let state: tauri::State<'_, TunnelState> = app.state();
    if let Ok(mut guard) = state.url.lock() {
        *guard = url.clone();
    }
    if let Some(url) = &url {
        // Remember the last URL so the panel can show it while reconnecting.
        let url_owned = url.clone();
        let _ = config::with_config_mut(app, |cfg| {
            cfg.settings.cf_tunnel_url = url_owned.clone();
            Ok(())
        });
    }
    let _ = app.emit("kern://tunnel-state", ());
}

fn set_error(app: &AppHandle, message: Option<String>) {
    let state: tauri::State<'_, TunnelState> = app.state();
    if let Ok(mut guard) = state.error.lock() {
        *guard = message;
    }
    let _ = app.emit("kern://tunnel-state", ());
}

/// Managed binary path (inside the app data dir so downloads are allowed).
fn managed_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = config::config_dir(app)?.join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create bin dir: {e}"))?;
    let name = if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    Ok(dir.join(name))
}

/// True when `cloudflared --version` runs from PATH.
fn path_binary_works() -> bool {
    process::silent_command("cloudflared")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resolution order: managed copy, then PATH.
fn find_binary(app: &AppHandle) -> Option<(PathBuf, bool)> {
    if let Ok(path) = managed_path(app) {
        if path.is_file() {
            return Some((path, true));
        }
    }
    if path_binary_works() {
        return Some((PathBuf::from("cloudflared"), false));
    }
    None
}

// ── named tunnel connector token (credential vault) ─────────────────────────

fn named_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(NAMED_KEYRING_SERVICE, NAMED_KEYRING_USER)
        .map_err(|e| format!("credential store unavailable: {e}"))
}

pub fn named_token() -> Option<String> {
    named_entry()
        .ok()?
        .get_password()
        .ok()
        .filter(|t| !t.trim().is_empty())
}

fn set_named_token(token: &str) -> Result<(), String> {
    named_entry()?
        .set_password(token.trim())
        .map_err(|e| format!("failed to store tunnel token: {e}"))
}

fn clear_named_token() -> Result<(), String> {
    let entry = named_entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Missing is fine — clearing an unset token is a no-op.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to remove tunnel token: {e}")),
    }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/// Official release asset name for this platform.
fn release_asset() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("cloudflared-windows-amd64.exe"),
        ("windows", "aarch64") => Ok("cloudflared-windows-arm64.exe"),
        ("linux", "x86_64") => Ok("cloudflared-linux-amd64"),
        ("linux", "aarch64") => Ok("cloudflared-linux-arm64"),
        ("macos", "aarch64") => Ok("cloudflared-darwin-arm64.tgz"),
        ("macos", "x86_64") => Ok("cloudflared-darwin-amd64.tgz"),
        (os, arch) => Err(format!("no cloudflared build for {os}/{arch}")),
    }
}

/// Downloads the official cloudflared release into the managed bin dir.
/// Async command: the frontend gets `download:cloudflared:progress` events.
#[tauri::command]
pub async fn tunnel_download_binary(app: AppHandle) -> Result<TunnelInfo, String> {
    let asset = release_asset()?;
    let url = format!("https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}");
    let dest = managed_path(&app)?;
    let temp = dest.with_extension("download");

    crate::download::download_url(
        app.clone(),
        url,
        temp.to_string_lossy().to_string(),
        "cloudflared".to_string(),
    )
    .await?;

    if asset.ends_with(".tgz") {
        extract_tgz_binary(&temp, &dest)?;
        let _ = std::fs::remove_file(&temp);
    } else {
        std::fs::rename(&temp, &dest)
            .map_err(|e| format!("failed to move cloudflared into place: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }

    // Start immediately if the settings say the tunnel should be up.
    apply_settings(&app);
    Ok(info(&app))
}

#[cfg(target_os = "macos")]
fn extract_tgz_binary(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("failed to open archive: {e}"))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    for entry in tar.entries().map_err(|e| format!("invalid archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("invalid archive entry: {e}"))?;
        let is_binary = entry
            .path()
            .map(|p| p.file_name().map(|n| n == "cloudflared").unwrap_or(false))
            .unwrap_or(false);
        if is_binary {
            entry
                .unpack(dest)
                .map_err(|e| format!("failed to extract cloudflared: {e}"))?;
            return Ok(());
        }
    }
    Err("cloudflared binary not found inside the archive".to_string())
}

#[cfg(not(target_os = "macos"))]
fn extract_tgz_binary(_archive: &Path, _dest: &Path) -> Result<(), String> {
    Err("tgz archives are only used on macOS".to_string())
}

/// Current tunnel status for the settings panel.
#[tauri::command]
pub fn tunnel_info(app_handle: AppHandle) -> TunnelInfo {
    info(&app_handle)
}

/// Re-applies the saved settings (start/stop/restart) and returns the status.
/// Used by the panel's retry button after an error.
#[tauri::command]
pub fn tunnel_apply(app_handle: AppHandle) -> TunnelInfo {
    apply_settings(&app_handle);
    info(&app_handle)
}

/// Stores a named-tunnel connector token, switches the mode to `named`, and
/// brings the tunnel up. The token never touches config.json.
#[tauri::command]
pub fn tunnel_set_named(
    app_handle: AppHandle,
    token: String,
    hostname: String,
) -> Result<TunnelInfo, String> {
    if token.trim().is_empty() {
        return Err("paste the connector token from the Cloudflare dashboard".to_string());
    }
    set_named_token(&token)?;
    config::with_config_mut(&app_handle, |cfg| {
        cfg.settings.cf_tunnel_enabled = true;
        cfg.settings.cf_tunnel_mode = "named".to_string();
        if !hostname.trim().is_empty() {
            cfg.settings.cf_tunnel_hostname =
                hostname.trim().trim_end_matches('/').to_string();
        }
        Ok(())
    })?;
    apply_settings(&app_handle);
    Ok(info(&app_handle))
}

/// Forgets the named-tunnel token and falls back to quick-tunnel mode.
#[tauri::command]
pub fn tunnel_clear_named(app_handle: AppHandle) -> Result<TunnelInfo, String> {
    let _ = clear_named_token();
    config::with_config_mut(&app_handle, |cfg| {
        cfg.settings.cf_tunnel_mode = "quick".to_string();
        Ok(())
    })?;
    apply_settings(&app_handle);
    Ok(info(&app_handle))
}

pub fn info(app: &AppHandle) -> TunnelInfo {
    let cfg = config::load_config(app).ok();
    let enabled = cfg
        .as_ref()
        .map(|c| c.settings.web_remote_enabled && c.settings.cf_tunnel_enabled)
        .unwrap_or(false);
    let mode = cfg
        .as_ref()
        .map(|c| c.settings.cf_tunnel_mode.clone())
        .unwrap_or_else(|| "quick".to_string());
    let hostname = cfg
        .as_ref()
        .map(|c| c.settings.cf_tunnel_hostname.clone())
        .filter(|h| !h.trim().is_empty());
    let state: tauri::State<'_, TunnelState> = app.state();
    let url = state.url.lock().ok().and_then(|g| g.clone());
    let error = state.error.lock().ok().and_then(|g| g.clone());
    let binary = find_binary(app);
    TunnelInfo {
        enabled,
        running: state.running.load(Ordering::SeqCst),
        url,
        error,
        binary_found: binary.is_some(),
        binary: binary.as_ref().map(|(p, _)| p.display().to_string()),
        managed: binary.map(|(_, m)| m).unwrap_or(false),
        mode,
        hostname,
        named_token_set: named_token().is_some(),
    }
}

/// True while the saved settings still ask for a tunnel.
fn restart_intent(app: &AppHandle) -> bool {
    config::load_config(app)
        .map(|c| c.settings.web_remote_enabled && c.settings.cf_tunnel_enabled)
        .unwrap_or(false)
}

/// Start/stop the tunnel to match the current settings. Safe to call often;
/// a no-op when already in the desired state.
pub fn apply_settings(app: &AppHandle) {
    let Ok(cfg) = config::load_config(app) else {
        return;
    };
    let wants = cfg.settings.web_remote_enabled && cfg.settings.cf_tunnel_enabled;
    let port = cfg.settings.web_remote_port;
    let mode = cfg.settings.cf_tunnel_mode.clone();
    let hostname = cfg.settings.cf_tunnel_hostname.clone();

    let state: tauri::State<'_, TunnelState> = app.state();
    let running = state.running.load(Ordering::SeqCst);
    let active_port = state.port.lock().map(|p| *p).unwrap_or(0);
    let active_mode = state.mode.lock().map(|m| m.clone()).unwrap_or_default();

    if !wants {
        if running {
            stop(app);
        }
        return;
    }
    if running && active_port == port && active_mode == mode {
        return;
    }

    stop(app);
    // Let the previous process fully die before rebinding/reconnecting.
    for _ in 0..20 {
        if !state.running.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let Some((binary, managed)) = find_binary(app) else {
        set_error(
            app,
            Some("cloudflared not found — download it from the panel, or install it on PATH".into()),
        );
        return;
    };

    let token = if mode == "named" {
        match named_token() {
            Some(token) => token,
            None => {
                set_error(
                    app,
                    Some(
                        "named tunnel selected but no connector token is saved — add one in settings"
                            .into(),
                    ),
                );
                return;
            }
        }
    } else {
        String::new()
    };

    // The connector dials the web remote's origin. Honor the bind address: a
    // loopback-only or interface-specific bind is not reachable on `localhost`
    // (or vice versa), and `--no-tls-verify` already tolerates the cert.
    let origin = match cfg.settings.web_remote_bind.trim().parse::<std::net::IpAddr>() {
        Ok(ip) if ip.is_unspecified() => "127.0.0.1".to_string(),
        Ok(std::net::IpAddr::V6(v6)) => format!("[{v6}]"),
        Ok(ip) => ip.to_string(),
        Err(_) => "127.0.0.1".to_string(),
    };

    start(
        app,
        TunnelLaunch {
            binary: &binary,
            managed,
            port,
            mode: &mode,
            token: &token,
            hostname: &hostname,
            origin: &origin,
        },
    );
}

/// Everything one cloudflared launch needs (grouped to keep `start` tidy).
struct TunnelLaunch<'a> {
    binary: &'a Path,
    managed: bool,
    port: u16,
    mode: &'a str,
    /// Connector token for named tunnels; empty for quick tunnels.
    token: &'a str,
    hostname: &'a str,
    /// Web-remote origin the connector dials (`127.0.0.1` for wildcard binds).
    origin: &'a str,
}

fn start(app: &AppHandle, launch: TunnelLaunch<'_>) {
    let TunnelLaunch {
        binary,
        managed,
        port,
        mode,
        token,
        hostname,
        origin,
    } = launch;
    let state: tauri::State<'_, TunnelState> = app.state();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    set_error(app, None);
    set_url(app, None);

    if let Ok(mut active) = state.mode.lock() {
        *active = mode.to_string();
    }
    if let Ok(mut started) = state.started_at.lock() {
        *started = Some(Instant::now());
    }

    // Isolated config so a user's `~/.cloudflared/config.yml` (named tunnels)
    // can't be loaded in place of the quick tunnel. See the module docs.
    let isolated_config = config::config_dir(app).ok().map(|dir| dir.join("tunnel.yml"));
    if let Some(path) = &isolated_config {
        if !path.exists() {
            let _ = std::fs::write(path, "protocol: quic\n");
        }
    }

    let mut args: Vec<String> = vec!["tunnel".to_string()];
    if let Some(path) = &isolated_config {
        args.push("--config".to_string());
        args.push(path.display().to_string());
    }
    if mode == "named" {
        args.push("run".to_string());
        args.push("--token".to_string());
        args.push(token.to_string());
    } else {
        args.push("--url".to_string());
        args.push(format!("https://{origin}:{port}"));
        args.push("--no-tls-verify".to_string());
    }
    args.push("--no-autoupdate".to_string());

    let mut command = process::silent_command(binary);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            set_error(app, Some(format!("failed to start cloudflared: {e}")));
            return;
        }
    };
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let child = Arc::new(Mutex::new(child));

    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child.clone());
    }
    if let Ok(mut guard) = state.port.lock() {
        *guard = port;
    }
    state.running.store(true, Ordering::SeqCst);
    let _ = app.emit("kern://tunnel-state", ());
    eprintln!(
        "[tunnel] cloudflared started ({binary:?}, managed={managed}, mode={mode})"
    );

    // Named tunnels have a known public hostname; publish it immediately so
    // the panel QR is usable without waiting for connector log lines.
    if mode == "named" && !hostname.trim().is_empty() {
        set_url(
            app,
            Some(format!("https://{}", hostname.trim().trim_end_matches('/'))),
        );
    }

    // Parse the quick-tunnel URL from cloudflared's output (stderr banner).
    if let Some(stderr) = stderr {
        let app = app.clone();
        std::thread::spawn(move || consume_lines(app, generation, BufReader::new(stderr)));
    }
    if let Some(stdout) = stdout {
        let app = app.clone();
        std::thread::spawn(move || consume_lines(app, generation, BufReader::new(stdout)));
    }

    // Watch for exit; surface it and restart while the setting is still on.
    let app_watch = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            if generation != state_generation(&app_watch) {
                return;
            }
            let status = {
                let mut guard = match child.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                guard.try_wait()
            };
            match status {
                Ok(Some(status)) => {
                    let state: tauri::State<'_, TunnelState> = app_watch.state();
                    state.running.store(false, Ordering::SeqCst);
                    if generation != state_generation(&app_watch) {
                        return;
                    }

                    if !restart_intent(&app_watch) {
                        set_url(&app_watch, None);
                        set_error(&app_watch, Some(format!("cloudflared exited ({status})")));
                        return;
                    }

                    // Backoff, but treat a long healthy run as a fresh start.
                    let ran_for = state
                        .started_at
                        .lock()
                        .ok()
                        .and_then(|g| *g)
                        .map(|t| t.elapsed())
                        .unwrap_or_default();
                    if ran_for.as_secs() > 120 {
                        state.restart_attempts.store(0, Ordering::SeqCst);
                    }
                    let attempt = state.restart_attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    let delay = Duration::from_secs((1u64 << attempt.min(5)).min(30));
                    set_error(
                        &app_watch,
                        Some(format!(
                            "cloudflared exited ({status}) — reconnecting in {}s",
                            delay.as_secs()
                        )),
                    );
                    std::thread::sleep(delay);
                    if generation == state_generation(&app_watch) && restart_intent(&app_watch) {
                        apply_settings(&app_watch);
                    }
                    return;
                }
                Ok(None) => {}
                Err(e) => {
                    set_error(&app_watch, Some(format!("cloudflared wait failed: {e}")));
                    return;
                }
            }
        }
    });
}

/// Reads cloudflared output, publishing the first quick-tunnel URL it sees.
/// Returns when the stream ends or a newer tunnel generation takes over.
fn consume_lines(app: AppHandle, generation: u64, reader: impl BufRead) {
    let patterns = Regex::new(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com").unwrap();
    for line in reader.lines().map_while(Result::ok) {
        if generation != state_generation(&app) {
            return;
        }
        append_tunnel_log(&app, &line);
        if let Some(found) = patterns.find(&line) {
            let url = found.as_str().to_string();
            if current_url(&app).as_deref() != Some(url.as_str()) {
                eprintln!("[tunnel] public url: {url}");
                let state: tauri::State<'_, TunnelState> = app.state();
                state.restart_attempts.store(0, Ordering::SeqCst);
                set_url(&app, Some(url));
            }
        }
    }
}

/// Appends one cloudflared output line to `<app_data>/tunnel.log`, capped so a
/// misbehaving tunnel can't grow the file without bound. The settings panel
/// points users at this file when a tunnel fails to come up.
fn append_tunnel_log(app: &AppHandle, line: &str) {
    const MAX_BYTES: u64 = 512 * 1024;
    let Ok(dir) = config::config_dir(app) else {
        return;
    };
    let path = dir.join("tunnel.log");
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        let _ = std::fs::write(&path, b"");
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(file, "{line}");
    }
}

fn current_url(app: &AppHandle) -> Option<String> {
    let state: tauri::State<'_, TunnelState> = app.state();
    state.url.lock().ok().and_then(|g| g.clone())
}

/// Stops the tunnel by invalidating its generation and killing the child.
pub fn stop(app: &AppHandle) {
    let state: tauri::State<'_, TunnelState> = app.state();
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.running.store(false, Ordering::SeqCst);
    state.restart_attempts.store(0, Ordering::SeqCst);
    let child = state.child.lock().ok().and_then(|mut guard| guard.take());
    if let Some(child) = child {
        if let Ok(mut guard) = child.lock() {
            let _ = guard.kill();
            let _ = guard.wait();
        }
    }
    set_url(app, None);
    let _ = app.emit("kern://tunnel-state", ());
    eprintln!("[tunnel] stopped");
}

/// Startup hook: bring the tunnel up if the saved settings ask for it.
pub fn maybe_spawn(app: &AppHandle) {
    apply_settings(app);
}

/// Fast shutdown path for app exit (children outlive the process otherwise).
pub fn shutdown(app: &AppHandle) {
    stop(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_asset_names_are_known_for_common_platforms() {
        let asset = release_asset();
        assert!(asset.is_ok(), "current platform must map to an asset");
        let name = asset.unwrap();
        assert!(
            name.starts_with("cloudflared-"),
            "unexpected asset name {name}"
        );
    }

    #[test]
    fn quick_tunnel_url_is_extracted_from_a_log_line() {
        let pattern = Regex::new(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com").unwrap();
        let line = "2026-09-12T21:00:00Z INF |  https://random-words-here.trycloudflare.com     |";
        assert_eq!(
            pattern.find(line).map(|m| m.as_str()),
            Some("https://random-words-here.trycloudflare.com")
        );
        assert!(pattern.find("no url here").is_none());
    }

    #[test]
    fn backed_off_restart_delay_is_bounded() {
        for attempt in 1..=10u32 {
            let delay = Duration::from_secs((1u64 << attempt.min(5)).min(30));
            assert!(delay >= Duration::from_secs(2));
            assert!(delay <= Duration::from_secs(30));
        }
    }
}
