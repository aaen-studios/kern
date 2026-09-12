//! Append-only audit log of user-visible actions.
//!
//! One JSON object per line at `<app_data>/audit.log`, rotated to
//! `audit.log.1` once it exceeds [`MAX_BYTES`]. Recording is best-effort by
//! design: auditing must never fail or block the action it documents.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config;

const MAX_BYTES: u64 = 1_000_000;
const MAX_ENTRIES: usize = 500;

/// One recorded action.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Epoch seconds.
    pub at: u64,
    /// Short verb, e.g. "start", "delete", "plugin-install".
    pub action: String,
    /// Human-readable one-liner.
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    config::config_dir(app).ok().map(|d| d.join("audit.log"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Records one action. Never returns an error.
pub fn record(app: &AppHandle, action: &str, detail: &str, server_id: Option<&str>) {
    let Some(path) = log_path(app) else {
        return;
    };
    let entry = AuditEntry {
        at: now_secs(),
        action: action.to_string(),
        detail: detail.to_string(),
        server_id: server_id.map(str::to_string),
    };
    let Ok(line) = serde_json::to_string(&entry) else {
        return;
    };
    // Rotate before appending so the log stays bounded.
    if std::fs::metadata(&path)
        .map(|m| m.len() >= MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
}

/// Returns the newest entries, newest first, capped at [`MAX_ENTRIES`].
pub fn read(app: &AppHandle, limit: usize) -> Vec<AuditEntry> {
    let Some(path) = log_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    raw.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<AuditEntry>(line).ok())
        .take(limit.clamp(1, MAX_ENTRIES))
        .collect()
}

/// Newest audit entries, newest first.
#[tauri::command]
pub fn get_audit_log(app_handle: AppHandle, limit: Option<usize>) -> Vec<AuditEntry> {
    read(&app_handle, limit.unwrap_or(200))
}

/// Writes the newest entries as pretty JSON to `dest` (a user-chosen path).
#[tauri::command]
pub fn export_audit_log(app_handle: AppHandle, dest: String) -> Result<(), String> {
    let entries = read(&app_handle, MAX_ENTRIES);
    let raw = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("failed to serialize audit log: {e}"))?;
    std::fs::write(&dest, raw).map_err(|e| format!("failed to write '{dest}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at: u64, action: &str) -> AuditEntry {
        AuditEntry {
            at,
            action: action.to_string(),
            detail: format!("{action} happened"),
            server_id: None,
        }
    }

    #[test]
    fn entries_round_trip_through_jsonl() {
        let a = entry(1, "start");
        let b = entry(2, "stop");
        let raw = format!(
            "{}\n{}\n",
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        let parsed: Vec<AuditEntry> = raw
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].action, "start");
        assert_eq!(parsed[1].action, "stop");
    }
}
