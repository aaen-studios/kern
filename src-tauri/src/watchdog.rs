//! Crash watchdog + shared notification emission.
//!
//! When a restartable server process exits unexpectedly, the watchdog restarts
//! it with exponential backoff, up to the per-instance `maxAttempts`. A process
//! that ran longer than [`STABLE_RUN_SECS`] is considered healthy and resets
//! the attempt counter, so occasional crashes don't accumulate forever.
//!
//! All user-visible events (crashes, restarts, schedules, plugin notices) go
//! through [`notify`], which emits `kern://notification` for the notification
//! center and toasts.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::{commands, process};

/// A process that stays up this long is considered stable (attempts reset).
const STABLE_RUN_SECS: u64 = 60;

/// Backoff delay for attempt N (1-based): 2s, 4s, 8s, 16s, 32s, capped at 60s.
fn backoff_secs(attempt: u32) -> u64 {
    (1u64 << attempt.min(5)).min(60)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Payload emitted on `kern://notification` (mirrored by the TS Notification type).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// "info" | "success" | "warn" | "error"
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    /// Epoch seconds.
    pub at: u64,
}

/// Emits a notification event for the notification center / toasts, and
/// forwards it to the configured webhook (if any).
pub fn notify(
    app: &AppHandle,
    kind: &str,
    title: &str,
    message: Option<String>,
    server_id: Option<&str>,
) {
    let payload = Notification {
        kind: kind.to_string(),
        title: title.to_string(),
        message,
        server_id: server_id.map(str::to_string),
        at: now_secs(),
    };
    crate::webhook::send(app, &payload.kind, &payload.title, payload.message.as_deref());
    let _ = app.emit("kern://notification", payload);
}

/// In-memory restart-attempt counters, keyed by instance id.
#[derive(Default)]
pub struct WatchdogState {
    attempts: Mutex<HashMap<String, u32>>,
}

/// Clears the attempt counter (manual start/stop, stable run, deletion).
pub fn reset(app: &AppHandle, id: &str) {
    let state: tauri::State<'_, WatchdogState> = app.state();
    let _ = state.attempts.lock().map(|mut map| map.remove(id));
}

/// Called from the process teardown when a server exits.
pub fn on_process_exit(
    app: &AppHandle,
    id: &str,
    exit_code: Option<i32>,
    intentional: bool,
    run_secs: u64,
) {
    // A user-initiated stop (or a long healthy run) resets the streak.
    if intentional || run_secs >= STABLE_RUN_SECS {
        reset(app, id);
        return;
    }

    let cfg = match config::load_config(app) {
        Ok(cfg) => cfg,
        Err(_) => return,
    };
    let Some(server) = cfg.servers.get(id) else {
        reset(app, id);
        return;
    };
    if !server.watchdog.enabled || server.is_orphaned {
        return;
    }

    let max = server.watchdog.max_attempts.max(1);
    let attempt = {
        let state: tauri::State<'_, WatchdogState> = app.state();
        let Ok(mut map) = state.attempts.lock() else {
            return;
        };
        let entry = map.entry(id.to_string()).or_insert(0);
        *entry += 1;
        *entry
    };
    let name = server.name.clone();
    let code = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "no exit code".to_string());

    if attempt > max {
        reset(app, id);
        let _ = config::with_config_mut(app, |cfg| {
            if let Some(instance) = cfg.servers.get_mut(id) {
                instance.status = "error".to_string();
            }
            Ok(())
        });
        notify(
            app,
            "error",
            &format!("{name} keeps crashing"),
            Some(format!(
                "Gave up after {max} restart attempts (last exit: {code})."
            )),
            Some(id),
        );
        return;
    }

    let delay = Duration::from_secs(backoff_secs(attempt));
    notify(
        app,
        "warn",
        &format!("{name} crashed"),
        Some(format!(
            "Restarting {attempt}/{max} in {}s (exit: {code}).",
            delay.as_secs()
        )),
        Some(id),
    );

    let handle = app.clone();
    let id_owned = id.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(delay);

        // Re-check state: the user may have started, stopped, disabled the
        // watchdog, or deleted the instance during the backoff window.
        let cfg = match config::load_config(&handle) {
            Ok(cfg) => cfg,
            Err(_) => return,
        };
        let Some(server) = cfg.servers.get(&id_owned) else {
            return;
        };
        if !server.watchdog.enabled {
            return;
        }
        if process::is_running(&handle, &id_owned) || process::is_task_running(&handle, &id_owned) {
            return;
        }
        let name = server.name.clone();

        match commands::launch_instance(&handle, &id_owned) {
            Ok(_) => notify(
                &handle,
                "info",
                &format!("{name} restarted"),
                Some(format!("Attempt {attempt} succeeded.")),
                Some(&id_owned),
            ),
            Err(e) => {
                notify(
                    &handle,
                    "error",
                    &format!("{name} restart failed"),
                    Some(e),
                    Some(&id_owned),
                );
                // Count the failed spawn and schedule the next attempt.
                on_process_exit(&handle, &id_owned, None, false, 0);
            }
        }
    });
}
