//! Global config.json registry: persistence + orphaned-state detection.
//!
//! Spec: documentation/ArchitecturePlan.md §2 (Core Registry Schema).
//! The config document lives at `<app_data_dir>/config.json` and tracks every
//! server instance. If an instance's path is no longer accessible, the core
//! marks it `is_orphaned` rather than deleting it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Config schema version. Bumped on incompatible document changes.
pub const CONFIG_VERSION: &str = "2.0.0";

/// Root config.json document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub version: String,
    pub settings: AppSettings,
    pub servers: HashMap<String, ServerInstance>,
}

/// Global application settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_sandbox_path: String,
    /// Launch kern automatically when the user signs in to the OS.
    /// Mirrors the OS-level autostart registration (kept in sync by the
    /// enable/disable commands) so the UI reflects the persisted intent even
    /// before the OS entry is (de)registered.
    #[serde(default)]
    pub launch_on_login: bool,
    /// When true, the window close button (×) hides the window to the tray
    /// instead of quitting; real exit happens via the tray menu. Defaults to
    /// true so the app behaves as a long-running host by default.
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// When kern is launched by the OS at login, start hidden in the tray
    /// rather than showing the window. Manual launches always restore the
    /// last remembered window visibility.
    #[serde(default)]
    pub start_hidden_in_tray: bool,
    /// Local electricity price per kWh in the user's currency. Drives the
    /// energy & cost meter (draw × hours × price). Zero disables the meter.
    #[serde(default)]
    pub power_price_per_kwh: f64,
    /// Average machine power draw in watts, for the cost meter. The user tunes
    /// this to their hardware; default is a rough idle+load blend.
    #[serde(default = "default_machine_watts")]
    pub machine_watts: f64,
    /// Base URL of the plugin registry (kern-web). Defaults to the live site.
    #[serde(default = "default_registry_url")]
    pub registry_url: String,
    /// Enable the optional web remote (HTTPS + token, LAN control panel).
    #[serde(default)]
    pub web_remote_enabled: bool,
    /// HTTPS port for the web remote.
    #[serde(default = "default_web_remote_port")]
    pub web_remote_port: u16,
    /// Legacy passphrase field (superseded by token pairing; retained for
    /// config backward-compatibility).
    #[serde(default)]
    pub web_remote_passphrase: String,
    /// Git repo URL for optional multi-machine registry sync. Empty = disabled.
    #[serde(default)]
    pub sync_repo_url: String,
    /// Mirror in-app notifications to native OS toasts when the window isn't
    /// focused. Defaults on; turning it off is the user's Do-Not-Disturb.
    #[serde(default = "default_true")]
    pub native_notifications: bool,
    /// Outbound webhook URL (Discord/Slack/generic JSON). Empty = disabled.
    #[serde(default)]
    pub webhook_url: String,
    /// Master switch for webhook delivery (lets the URL be kept while muted).
    #[serde(default)]
    pub webhook_enabled: bool,
    /// User-defined log-pattern alert rules (regex matched against streamed
    /// log lines; a match emits a notification + webhook).
    #[serde(default)]
    pub log_alerts: Vec<LogAlertRule>,
    /// Loopback-only automation API for the CLI/scripts (127.0.0.1, token).
    #[serde(default = "default_true")]
    pub automation_enabled: bool,
    /// Port for the loopback automation API.
    #[serde(default = "default_automation_port")]
    pub automation_port: u16,
}

fn default_automation_port() -> u16 {
    7442
}

/// One user-defined log-pattern alert rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogAlertRule {
    /// Stable id (host-generated for new rules).
    #[serde(default)]
    pub id: String,
    /// Human label shown in notifications ("Out of memory").
    #[serde(default)]
    pub name: String,
    /// Regular expression matched per line (case-sensitive, Rust regex syntax).
    pub pattern: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_machine_watts() -> f64 {
    120.0
}

fn default_registry_url() -> String {
    "https://kern.aaenz.no".to_string()
}

fn default_web_remote_port() -> u16 {
    7440
}

/// Per-instance backup schedule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSchedule {
    /// Backup interval in seconds. 0 = disabled. Common: 2h = 7200.
    #[serde(default)]
    pub interval_secs: u64,
    /// Keep at most this many snapshots (rolling, oldest pruned first).
    #[serde(default = "default_keep_count")]
    pub keep: u32,
    /// Also snapshot whenever the instance stops cleanly.
    #[serde(default)]
    pub on_stop: bool,
    /// Epoch-seconds of the last scheduled snapshot. Tracked by the scheduler.
    #[serde(default)]
    pub last_backup_secs: u64,
}

fn default_keep_count() -> u32 {
    12
}

/// Default graceful-stop window: long enough for a Minecraft world save on a
/// slow disk, short enough that a hung process is bounded.
pub fn default_stop_timeout_secs() -> u64 {
    30
}

impl Default for BackupSchedule {
    fn default() -> Self {
        Self {
            interval_secs: 0,
            keep: default_keep_count(),
            on_stop: false,
            last_backup_secs: 0,
        }
    }
}

/// RCON connection settings (password lives in the OS keyring, not here).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RconConfig {
    #[serde(default = "default_rcon_host")]
    pub host: String,
    #[serde(default = "default_rcon_port")]
    pub port: u16,
}

fn default_rcon_host() -> String {
    "127.0.0.1".to_string()
}

fn default_rcon_port() -> u16 {
    25575
}

impl Default for RconConfig {
    fn default() -> Self {
        Self {
            host: default_rcon_host(),
            port: default_rcon_port(),
        }
    }
}

/// A user-defined scheduled task for one instance.
///
/// Scheduling supports three mutually-inclusive modes — interval, daily time,
/// and cron — and a task fires when any configured mode is due (never twice in
/// the same minute).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    /// Stable id (host-generated for new tasks).
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// "restart" | "start" | "stop" | "command" | "backup" | "health"
    #[serde(default)]
    pub action: String,
    /// Command text for `command` (stdin when running, shell when stopped) and
    /// the policy for `health` ("notify" | "restart").
    #[serde(default)]
    pub command: String,
    /// Run every N seconds. 0 = unused.
    #[serde(default)]
    pub interval_secs: u64,
    /// Local time "HH:MM" for a once-daily run. Empty = unused.
    #[serde(default)]
    pub daily_at: String,
    /// 5-field cron expression (min hour day-of-month month day-of-week).
    #[serde(default)]
    pub cron: String,
    /// For `restart` tasks: minutes before the restart to announce in the
    /// server console via stdin (e.g. [5, 1] → "restarting in 5 minutes" and
    /// "restarting in 1 minute"). Empty = silent restart.
    #[serde(default)]
    pub announce_minutes: Vec<u32>,
    /// Dedupe keys for announcements already sent for the upcoming run
    /// ("<next-flow>:<minutes>"); host-managed, pruned automatically.
    #[serde(default)]
    pub announce_sent: Vec<String>,
    /// Epoch seconds of the last run (host-managed).
    #[serde(default)]
    pub last_run_secs: u64,
}

/// Per-instance crash-watchdog policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogConfig {    /// Restart automatically after an unexpected exit.
    #[serde(default)]
    pub enabled: bool,
    /// Maximum consecutive restart attempts before giving up.
    #[serde(default = "default_watchdog_attempts")]
    pub max_attempts: u32,
}

fn default_watchdog_attempts() -> u32 {
    5
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_attempts: default_watchdog_attempts(),
        }
    }
}

/// Per-instance health-alert thresholds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertRules {
    /// Alert when CPU exceeds this fraction (0.0–1.0) for `sustained_secs`.
    /// None = disabled.
    #[serde(default)]
    pub cpu_threshold: Option<f32>,
    /// Alert when RAM exceeds this fraction (0.0–1.0) for `sustained_secs`.
    #[serde(default)]
    pub ram_threshold: Option<f32>,
    /// How long the threshold must be continuously exceeded before firing.
    #[serde(default = "default_sustained")]
    pub sustained_secs: u64,
    /// Epoch-seconds of when the threshold was first crossed (tracked internally).
    #[serde(default)]
    pub crossed_since_secs: u64,
}

fn default_sustained() -> u64 {
    60
}

impl Default for AlertRules {
    fn default() -> Self {
        Self {
            cpu_threshold: Some(0.9),
            ram_threshold: Some(0.9),
            sustained_secs: default_sustained(),
            crossed_since_secs: 0,
        }
    }
}

/// Serde default helper — emits `true`. Used for opt-in booleans that should
/// default on (e.g. `close_to_tray`) so existing config.json documents
/// without the field pick up the new behavior automatically.
fn default_true() -> bool {
    true
}

/// A tracked server instance.
///
/// Field names are camelCase on the wire to match the TS contracts in
/// `src/types/server.ts` and the documented config.json schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInstance {
    pub id: String,
    pub name: String,
    pub server_type: String,
    pub path: String,
    pub status: String,
    pub is_orphaned: bool,
    pub user_overrides: HashMap<String, String>,
    /// When true, this instance is launched automatically as kern starts —
    /// either on manual app launch or on OS-login auto-startup. Backed by a
    /// per-instance toggle in the UI (detail header + create/edit form).
    #[serde(default)]
    pub auto_start: bool,
    /// Last-known OS pid of a running process. Written on launch so that if
    /// kern quits with the server still alive (detach_all), the next launch
    /// can re-adopt it by pid instead of leaving it invisible. Cleared on
    /// clean stop / when the process is observed dead on startup.
    #[serde(default)]
    pub pid: Option<u32>,
    /// Start time (epoch seconds) of `pid`, used together with the pid to
    /// verify the process identity when re-adopting after an app restart.
    /// A recycled pid has a different start time, so this prevents kern from
    /// killing an unrelated process.
    #[serde(default)]
    pub pid_started: Option<u64>,
    /// Optional stdin command for graceful shutdown (e.g. "stop", "shutdown",
    /// "exit"). `Some("")` disables the stdin step; `None` uses the default
    /// ("stop") for manifest plugins.
    #[serde(default)]
    pub stop_command: Option<String>,
    /// Seconds to wait for a graceful shutdown before force-killing the tree.
    #[serde(default = "default_stop_timeout_secs")]
    pub stop_timeout_secs: u64,
    /// Per-instance optional-feature visibility. Keys are feature ids from the
    /// frontend catalogue; absent keys fall back to the feature's default.
    #[serde(default)]
    pub features: HashMap<String, bool>,
    /// Crash watchdog policy (auto-restart with backoff).
    #[serde(default)]
    pub watchdog: WatchdogConfig,
    /// User-defined scheduled tasks (restart/start/stop/command/backup/health).
    #[serde(default)]
    pub tasks: Vec<ScheduledTask>,
    /// Optional sidebar group name (folders). `None` = ungrouped.
    #[serde(default)]
    pub group: Option<String>,
    /// Color-free filter labels ("tags"). Lowercase, deduped on save.
    #[serde(default)]
    pub tags: Vec<String>,
    /// RCON connection settings (host/port only; the password is in the OS
    /// keyring).
    #[serde(default)]
    pub rcon: RconConfig,
    /// Scheduled world backups (interval, retention, on-stop). Defaults to off.
    #[serde(default)]
    pub backup_schedule: BackupSchedule,
    /// Health-alert thresholds (CPU/RAM sustained). Tracked by the alerts loop.
    #[serde(default)]
    pub alert_rules: AlertRules,
    /// Shared terminal command history (newest last), capped at ~50 entries.
    #[serde(default)]
    pub command_history: Vec<String>,
    /// Pinned one-click command snippets for the terminal.
    #[serde(default)]
    pub command_snippets: Vec<String>,
    /// TCP ports this instance was last observed listening on. Used by the
    /// pre-start conflict check ("25565 is held by PID 1234").
    #[serde(default)]
    pub last_ports: Vec<u16>,
}

/// Returns the on-disk directory that holds config.json (and later plugins/).
/// The directory is created on first access.
///
/// Debug builds honor `KERN_APP_DATA_DIR` so the E2E harness can run a fully
/// isolated instance alongside a developer's real app (release builds ignore
/// the variable entirely).
pub fn config_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = if cfg!(debug_assertions) {
        match std::env::var("KERN_APP_DATA_DIR") {
            Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
            _ => app_handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app data dir: {e}"))?,
        }
    } else {
        app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("failed to resolve app data dir: {e}"))?
    };
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create app data dir '{}': {e}", dir.display()))?;
    }
    Ok(dir)
}

/// Absolute path to config.json.
pub fn config_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app_handle)?.join("config.json"))
}

/// Builds the default empty config document.
///
/// `default_sandbox_path` points at `<app_data_dir>/servers` — the location
/// used when a user does not pick a custom path for an instance.
fn default_config(app_handle: &AppHandle) -> Result<AppConfig, String> {
    let sandbox = config_dir(app_handle)?.join("servers");
    Ok(AppConfig {
        version: CONFIG_VERSION.to_string(),
        settings: AppSettings {
            default_sandbox_path: sandbox.to_string_lossy().to_string(),
            launch_on_login: false,
            close_to_tray: true,
            start_hidden_in_tray: false,
            power_price_per_kwh: 0.0,
            machine_watts: default_machine_watts(),
            registry_url: default_registry_url(),
            web_remote_enabled: false,
            web_remote_port: default_web_remote_port(),
            web_remote_passphrase: String::new(),
            sync_repo_url: String::new(),
            native_notifications: true,
            webhook_url: String::new(),
            webhook_enabled: false,
            log_alerts: Vec::new(),
            automation_enabled: true,
            automation_port: default_automation_port(),
        },
        servers: HashMap::new(),
    })
}

/// Loads config.json, creating it with defaults if missing.
///
/// After loading, every server instance is re-checked for orphaned status
/// (ArchitecturePlan §2: "If an instance's path becomes inaccessible, the core
/// marks it as orphaned instead of deleting it").
pub fn load_config(app_handle: &AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app_handle)?;

    let mut config = if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("failed to read '{}': {e}", path.display()))?;
        if raw.trim().is_empty() {
            default_config(app_handle)?
        } else {
            match serde_json::from_str::<AppConfig>(&raw) {
                Ok(parsed) => parsed,
                Err(parse_err) => {
                    // Corruption recovery: fall back to the last good document
                    // rather than making every command fail. Preserve the
                    // corrupt file for inspection, then repair the main file.
                    let bak = path.with_extension("json.bak");
                    let recovered = fs::read_to_string(&bak)
                        .ok()
                        .and_then(|backup| serde_json::from_str::<AppConfig>(&backup).ok())
                        .ok_or_else(|| {
                            format!(
                                "failed to parse '{}': {parse_err} (no usable backup at '{}')",
                                path.display(),
                                bak.display()
                            )
                        })?;
                    eprintln!(
                        "[config] '{}' is corrupt ({parse_err}); recovered from '{}'",
                        path.display(),
                        bak.display()
                    );
                    let _ = fs::rename(&path, path.with_extension("json.corrupt"));
                    let _ = save_config(app_handle, &recovered);
                    recovered
                }
            }
        }
    } else {
        // First run — seed a fresh document and persist it.
        let config = default_config(app_handle)?;
        save_config(app_handle, &config)?;
        config
    };

    refresh_orphaned(&mut config);
    Ok(config)
}

/// Writes config.json atomically. Writes to a sibling temp file first, then
/// renames — so a crash mid-write cannot corrupt the registry.
pub fn save_config(app_handle: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app_handle)?;
    let raw = serde_json::to_string_pretty(config)
        .map_err(|e| format!("failed to serialize config: {e}"))?;

    // Snapshot the previous *valid* document as config.json.bak before
    // overwriting. Only back up documents that parse, so a corrupt file can
    // never clobber the last known-good backup.
    if path.exists() {
        if let Ok(existing) = fs::read_to_string(&path) {
            if serde_json::from_str::<serde_json::Value>(&existing).is_ok() {
                let _ = fs::write(path.with_extension("json.bak"), existing);
            }
        }
    }

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| format!("failed to write '{}': {e}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("failed to commit '{}': {e}", path.display()))?;
    Ok(())
}

/// Serializes all mutating config writes (load → mutate → save) so concurrent
/// callers — the stdout reader thread, the auto-start loop, and user-driven
/// commands — can't silently clobber each other's changes.
///
/// `load_config` reads stay lock-free (they return a snapshot), but anything
/// that *changes* a field and persists must go through here. Without this,
/// last-writer-wins drops updates: a status write from the reader thread can
/// revert a server deletion that raced it, or a "running" status can vanish
/// when two writers overlap.
///
/// Deadlock-safe: a single global mutex with no nested acquisition.
pub fn with_config_mut<F>(app_handle: &AppHandle, mutator: F) -> Result<(), String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    use std::sync::Mutex;
    static CONFIG_LOCK: Mutex<()> = Mutex::new(());

    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|e| format!("config lock poisoned: {e}"))?;

    let mut cfg = load_config(app_handle)?;
    mutator(&mut cfg)?;
    save_config(app_handle, &cfg)?;
    Ok(())
}

/// Recomputes `is_orphaned` for every instance in place.
pub fn refresh_orphaned(config: &mut AppConfig) {
    for server in config.servers.values_mut() {
        server.is_orphaned = !Path::new(&server.path).exists();
    }
}

/// Generates a stable instance id, e.g. `srv_9f82b1a0`.
pub fn generate_id() -> String {
    // 4 bytes of pseudo-randomness rendered as hex is enough collision-resistance
    // for a single-user panel and avoids pulling a uuid crate in Phase 1.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9f82b1a0);
    // Mix the timestamp through an xorshift to spread bits across the hex output.
    let mut x = now.wrapping_mul(0x9e3779b97f4a7c15).max(1);
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    format!("srv_{x:08x}")
}

/// Generates an id that is not already present in `existing`. Two calls in the
/// same nanosecond would otherwise collide and silently replace a server.
pub fn generate_unique_id(existing: &HashMap<String, ServerInstance>) -> String {
    for _ in 0..16 {
        let id = generate_id();
        if !existing.contains_key(&id) {
            return id;
        }
    }
    // Extremely unlikely; fall back to appending an incrementing suffix.
    let mut n = 1u32;
    loop {
        let id = format!("{}_{n}", generate_id());
        if !existing.contains_key(&id) {
            return id;
        }
        n += 1;
    }
}
