//! File snapshots / rollback.
//!
//! Every snapshot captures the on-disk bytes of one file at a point in time,
//! stored under `<instance>/.kern-snapshots/files/<hash>/<millis>.snap` with a
//! `meta.json` recording the original relative path. Snapshots are created:
//!
//!   - manually (`snapshot_file`),
//!   - automatically before an editor save, when the instance enables the
//!     `snapshots` feature,
//!   - automatically before a restore (so a rollback is itself reversible).
//!
//! Retention is [`MAX_PER_FILE`] per file; the oldest are pruned first.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::{config, paths};

/// Snapshots kept per file.
const MAX_PER_FILE: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    /// Epoch milliseconds.
    pub at: u64,
    pub size: u64,
}

fn snapshots_root(instance_path: &Path) -> PathBuf {
    instance_path.join(".kern-snapshots")
}

fn hash_rel_path(rel_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(rel_path.as_bytes());
    format!("{:x}", hasher.finalize())[..24].to_string()
}

fn file_dir(instance_path: &Path, rel_path: &str) -> PathBuf {
    snapshots_root(instance_path)
        .join("files")
        .join(hash_rel_path(rel_path))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Validates a snapshot id (a bare file name like `1712345678901.snap`).
fn safe_snapshot_id(id: &str) -> Result<(), String> {
    let name = paths::safe_file_name(id)?;
    let s = name.to_string_lossy();
    if !s.ends_with(".snap") {
        return Err(format!("invalid snapshot id '{id}'"));
    }
    Ok(())
}

/// Captures `rel_path`'s current bytes. Returns the snapshot id, or `None`
/// when the file doesn't exist yet (nothing to preserve).
pub fn capture(
    instance_path: &Path,
    rel_path: &str,
) -> Result<Option<String>, String> {
    // Containment check: same sandbox rule as every other file command.
    let target = paths::safe_join(instance_path, rel_path)?;
    if !target.is_file() {
        return Ok(None);
    }

    let dir = file_dir(instance_path, rel_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create snapshot dir: {e}"))?;

    // Record the original path once, so list/restore don't need the caller to
    // remember it.
    let meta = dir.join("meta.json");
    if !meta.exists() {
        let _ = std::fs::write(
            &meta,
            serde_json::json!({ "relPath": rel_path }).to_string(),
        );
    }

    let id = format!("{}.snap", now_millis());
    let dest = dir.join(&id);
    let bytes = std::fs::read(&target)
        .map_err(|e| format!("failed to read '{}' for snapshot: {e}", rel_path))?;
    std::fs::write(&dest, bytes).map_err(|e| format!("failed to write snapshot: {e}"))?;

    prune_dir(&dir);
    Ok(Some(id))
}

/// Prunes the oldest snapshots beyond [`MAX_PER_FILE`].
fn prune_dir(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut snaps: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("snap"))
        .collect();
    if snaps.len() <= MAX_PER_FILE {
        return;
    }
    // Order by the parsed millisecond timestamp (not lexically — that would
    // break on non-zero-padded names).
    snaps.sort_by_key(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    });
    let remove_count = snaps.len() - MAX_PER_FILE;
    for path in snaps.into_iter().take(remove_count) {
        let _ = std::fs::remove_file(path);
    }
}

fn list_in_dir(dir: &Path) -> Vec<SnapshotInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<SnapshotInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("snap") {
                return None;
            }
            let id = path.file_name()?.to_string_lossy().to_string();
            let at = id.trim_end_matches(".snap").parse::<u64>().unwrap_or(0);
            let size = entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
            Some(SnapshotInfo { id, at, size })
        })
        .collect();
    out.sort_by(|a, b| b.at.cmp(&a.at)); // newest first
    out
}

/// Lists snapshots for one file, newest first.
#[tauri::command]
pub fn list_file_snapshots(
    app_handle: AppHandle,
    id: String,
    rel_path: String,
) -> Result<Vec<SnapshotInfo>, String> {
    let instance = load_instance(&app_handle, &id)?;
    Ok(list_in_dir(&file_dir(
        Path::new(&instance.path),
        &rel_path,
    )))
}

/// Reads one snapshot's text content (for diffing before restore).
#[tauri::command]
pub fn read_file_snapshot(
    app_handle: AppHandle,
    id: String,
    rel_path: String,
    snapshot_id: String,
) -> Result<String, String> {
    let instance = load_instance(&app_handle, &id)?;
    safe_snapshot_id(&snapshot_id)?;
    let path = file_dir(Path::new(&instance.path), &rel_path).join(&snapshot_id);
    std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read snapshot '{snapshot_id}': {e}"))
}

/// Snapshots the current file (manual trigger).
#[tauri::command]
pub fn snapshot_file(
    app_handle: AppHandle,
    id: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    let instance = load_instance(&app_handle, &id)?;
    capture(Path::new(&instance.path), &rel_path)
}

/// Restores a snapshot, first capturing the current content so the rollback is
/// itself undoable.
#[tauri::command]
pub fn restore_file_snapshot(
    app_handle: AppHandle,
    id: String,
    rel_path: String,
    snapshot_id: String,
) -> Result<(), String> {
    let instance = load_instance(&app_handle, &id)?;
    safe_snapshot_id(&snapshot_id)?;

    let instance_path = Path::new(&instance.path);
    let snapshot_path = file_dir(instance_path, &rel_path).join(&snapshot_id);
    let bytes = std::fs::read(&snapshot_path)
        .map_err(|e| format!("failed to read snapshot '{snapshot_id}': {e}"))?;

    // Reversible: preserve what's on disk right now.
    let _ = capture(instance_path, &rel_path);

    let target = paths::safe_join(instance_path, &rel_path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create parent dirs: {e}"))?;
    }
    std::fs::write(&target, bytes).map_err(|e| format!("failed to restore snapshot: {e}"))
}

/// Deletes one snapshot.
#[tauri::command]
pub fn delete_file_snapshot(
    app_handle: AppHandle,
    id: String,
    rel_path: String,
    snapshot_id: String,
) -> Result<(), String> {
    let instance = load_instance(&app_handle, &id)?;
    safe_snapshot_id(&snapshot_id)?;
    let path = file_dir(Path::new(&instance.path), &rel_path).join(&snapshot_id);
    std::fs::remove_file(&path).map_err(|e| format!("failed to delete snapshot: {e}"))
}

fn load_instance(app_handle: &AppHandle, id: &str) -> Result<config::ServerInstance, String> {
    let cfg = config::load_config(app_handle)?;
    cfg.servers
        .get(id)
        .cloned()
        .ok_or_else(|| format!("server '{id}' not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn capture_and_restore_roundtrip() {
        let dir = tmp();
        std::fs::write(dir.path().join("a.txt"), "v1").unwrap();

        let snap = capture(dir.path(), "a.txt").unwrap().expect("snapshot");
        std::fs::write(dir.path().join("a.txt"), "v2").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v2");

        let snap_path = file_dir(dir.path(), "a.txt").join(&snap);
        let bytes = std::fs::read(&snap_path).unwrap();
        std::fs::write(dir.path().join("a.txt"), bytes).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "v1");
    }

    #[test]
    fn capture_missing_file_is_noop() {
        let dir = tmp();
        assert!(capture(dir.path(), "missing.txt").unwrap().is_none());
    }

    #[test]
    fn capture_rejects_traversal() {
        let dir = tmp();
        assert!(capture(dir.path(), "../outside.txt").is_err());
    }

    #[test]
    fn prune_keeps_newest_max() {
        let dir = tmp();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let snap_dir = file_dir(dir.path(), "a.txt");
        std::fs::create_dir_all(&snap_dir).unwrap();
        for i in 0..25u64 {
            std::fs::write(snap_dir.join(format!("{i}.snap")), b"x").unwrap();
        }
        prune_dir(&snap_dir);
        let listed = list_in_dir(&snap_dir);
        assert_eq!(listed.len(), MAX_PER_FILE);
        // Oldest (0..5) removed, newest retained.
        assert!(listed.iter().all(|s| s.at >= 5));
    }

    #[test]
    fn snapshot_id_validation() {
        assert!(safe_snapshot_id("1712345678901.snap").is_ok());
        assert!(safe_snapshot_id("../evil.snap").is_err());
        assert!(safe_snapshot_id("evil.txt").is_err());
    }
}
