//! Per-instance crash reports.
//!
//! On an unexpected exit, the exit code plus the last lines of `latest.log`
//! are snapshotted to `<app_data>/crashes/<id>.json`. The UI shows this as a
//! "last crash" card, and the watchdog notification can point at it, so a user
//! who was away can see *why* a server died instead of digging through logs.
//! One report per instance (the newest overwrites the previous).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config;

/// How many log lines are kept in a report.
const TAIL_LINES: usize = 25;
/// Upper bound on bytes read from the end of latest.log.
const TAIL_BYTES: u64 = 64 * 1024;

/// One crash report.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    /// Epoch seconds.
    pub at: u64,
    pub exit_code: Option<i32>,
    /// True when the tree had to be force-killed (stop timeout).
    #[serde(default)]
    pub forced: bool,
    /// Last lines of `latest.log` at the time of the crash.
    #[serde(default)]
    pub tail: Vec<String>,
}

fn crashes_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = config::config_dir(app).ok()?.join("crashes");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn report_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    Some(crashes_dir(app)?.join(format!("{id}.json")))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Reads the last `max_lines` complete lines of `path`, reading at most
/// `max_bytes` from the end. A partial first line (from the byte window) is
/// dropped so the report starts on a clean boundary.
fn read_tail(path: &Path, max_lines: usize, max_bytes: u64) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.take(max_bytes).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        // The first line may be cut mid-way — drop it.
        lines.remove(0);
    }
    let start_idx = lines.len().saturating_sub(max_lines);
    lines[start_idx..].iter().map(|l| l.to_string()).collect()
}

/// Writes a crash report for `id` (unexpected exit only). Best-effort.
pub fn record(app: &AppHandle, id: &str, exit_code: Option<i32>, forced: bool) {
    let Ok(cfg) = config::load_config(app) else {
        return;
    };
    let Some(instance) = cfg.servers.get(id) else {
        return;
    };
    let tail = read_tail(
        &Path::new(&instance.path).join("latest.log"),
        TAIL_LINES,
        TAIL_BYTES,
    );
    let report = CrashReport {
        at: now_secs(),
        exit_code,
        forced,
        tail,
    };
    let Some(path) = report_path(app, id) else {
        return;
    };
    if let Ok(raw) = serde_json::to_string_pretty(&report) {
        let _ = std::fs::write(path, raw);
    }
}

/// Reads the stored report for `id`, if any.
pub fn read(app: &AppHandle, id: &str) -> Option<CrashReport> {
    let path = report_path(app, id)?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Removes the stored report for `id`.
pub fn clear(app: &AppHandle, id: &str) {
    if let Some(path) = report_path(app, id) {
        let _ = std::fs::remove_file(path);
    }
}

/// The last crash report for an instance (None when it hasn't crashed).
#[tauri::command]
pub fn get_last_crash(app_handle: AppHandle, id: String) -> Option<CrashReport> {
    read(&app_handle, &id)
}

/// Dismisses the last crash report for an instance.
#[tauri::command]
pub fn clear_last_crash(app_handle: AppHandle, id: String) {
    clear(&app_handle, &id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_tail_caps_lines_and_preserves_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latest.log");
        let content: String = (1..=100).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&path, content).unwrap();

        let tail = read_tail(&path, 5, TAIL_BYTES);
        assert_eq!(
            tail,
            vec!["line 96", "line 97", "line 98", "line 99", "line 100"]
        );
    }

    #[test]
    fn read_tail_drops_partial_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latest.log");
        std::fs::write(&path, "aaaa\nbbbb\ncccc\n").unwrap();

        // A 6-byte window lands mid-"aaaa"; the partial line must be dropped.
        let tail = read_tail(&path, 10, 6);
        assert_eq!(tail, vec!["cccc"]);
    }

    #[test]
    fn read_tail_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let tail = read_tail(&dir.path().join("nope.log"), 5, TAIL_BYTES);
        assert!(tail.is_empty());
    }
}
