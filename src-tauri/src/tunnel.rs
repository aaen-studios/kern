//! Cloudflare quick tunnel for the web remote.
//!
//! When enabled (requires the web remote), kern runs
//! `cloudflared tunnel --url https://localhost:<port> --no-tls-verify` as a
//! hidden child process and publishes the random `*.trycloudflare.com` URL it
//! reports. That makes the mobile control panel reachable from anywhere
//! without port forwarding — the tunnel dials out to Cloudflare's edge.
//!
//! Binary resolution: a `cloudflared` on PATH is used as-is; otherwise kern
//! downloads the official release binary into `<app_data>/bin/` on request
//! (`tunnel_download_binary`). Nothing is downloaded without that call.
//!
//! Isolation: cloudflared defaults to `~/.cloudflared/config.yml`. A user with
//! a named tunnel there would have it loaded instead of the quick tunnel (the
//! connector registers the named tunnel while the banner advertises a quick
//! hostname that never routes → endless 404s). kern passes its own
//! `--config <app_data>/tunnel.yml` so quick tunnels never touch user config.
//!
//! Security: a public URL is a public credential. The web remote's bearer
//! token still gates every request, but the pair URL embeds it, so the UI
//! warns and the tunnel is opt-in and off by default.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::process;

/// Shared tunnel state. `generation` invalidates reader/watcher threads from a
/// previous start so quick toggles can't cross-wire their state.
#[derive(Default)]
pub struct TunnelState {
    generation: AtomicU64,
    running: AtomicBool,
    url: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    child: Mutex<Option<Arc<Mutex<Child>>>>,
    port: Mutex<u16>,
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

pub fn info(app: &AppHandle) -> TunnelInfo {
    let cfg = config::load_config(app).ok();
    let enabled = cfg
        .as_ref()
        .map(|c| c.settings.web_remote_enabled && c.settings.cf_tunnel_enabled)
        .unwrap_or(false);
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
    }
}

/// Start/stop the tunnel to match the current settings. Safe to call often;
/// a no-op when already in the desired state.
pub fn apply_settings(app: &AppHandle) {
    let Ok(cfg) = config::load_config(app) else {
        return;
    };
    let wants = cfg.settings.web_remote_enabled && cfg.settings.cf_tunnel_enabled;
    let port = cfg.settings.web_remote_port;

    let state: tauri::State<'_, TunnelState> = app.state();
    let running = state.running.load(Ordering::SeqCst);
    let active_port = state.port.lock().map(|p| *p).unwrap_or(0);

    if !wants {
        if running {
            stop(app);
        }
        return;
    }
    if running && active_port == port {
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
    start(app, &binary, managed, port);
}

fn start(app: &AppHandle, binary: &Path, managed: bool, port: u16) {
    let state: tauri::State<'_, TunnelState> = app.state();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    set_error(app, None);
    set_url(app, None);

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
    args.push("--url".to_string());
    args.push(format!("https://localhost:{port}"));
    args.push("--no-tls-verify".to_string());
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
    eprintln!("[tunnel] cloudflared started ({binary:?}, managed={managed}) → https://localhost:{port}");

    // Parse the quick-tunnel URL from cloudflared's output (stderr banner).
    if let Some(stderr) = stderr {
        let app = app.clone();
        std::thread::spawn(move || consume_lines(app, generation, BufReader::new(stderr)));
    }
    if let Some(stdout) = stdout {
        let app = app.clone();
        std::thread::spawn(move || consume_lines(app, generation, BufReader::new(stdout)));
    }

    // Watch for exit; surface it and decide whether it was expected.
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
                    if generation == state_generation(&app_watch) {
                        set_url(&app_watch, None);
                        set_error(
                            &app_watch,
                            Some(format!("cloudflared exited ({status})")),
                        );
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
}
