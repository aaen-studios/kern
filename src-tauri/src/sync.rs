//! Multi-machine registry sync — export/import the server list to a git repo.
//!
//! Design choice: rather than bidirectional merge sync (which is fragile and
//! risks clobbering either side), this implements a safe **export / import**
//! model:
//!   - **export**: write a `registry.json` (instances with paths redacted to
//!     names + plugin types + settings) to a git working tree, commit, push.
//!   - **import**: pull, read `registry.json`, and surface the remote machines'
//!     instances in a read-only "imported" list (never overwrites local).
//!
//! This lets you see your fleet across machines without the merge-conflict
//! footgun. Instances stay local (paths differ per machine); only the metadata
//! travels. Secrets/overrides are not exported by default.
//!
//! Requires `git` on PATH. Configured via `AppSettings.sync_repo_url`.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config;

/// One exported instance row (path-independent, shareable).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedInstance {
    pub id: String,
    pub name: String,
    pub server_type: String,
    pub auto_start: bool,
    pub status: String,
}

/// The exported document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedRegistry {
    pub machine: String,
    pub exported_at: u64,
    pub instances: Vec<ExportedInstance>,
}

/// Returns a machine-local identifier (hostname, best-effort).
fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Resolves the local clone dir: `<app_data>/sync`.
fn sync_dir(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = config::config_dir(app_handle)?;
    let dir = base.join("sync");
    std::fs::create_dir_all(&dir).map_err(|e| format!("sync dir create failed: {e}"))?;
    Ok(dir)
}

/// Runs `git` in `dir` with the given args, returning stdout on success.
fn git(dir: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let out = crate::process::silent_command("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {}: {}", args.join(" "), stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Exports this machine's registry to the configured git repo.
///
/// Initializes a clone if needed, writes `registry.json`, commits, and pushes.
/// Best-effort: surfaces git errors to the caller. No secrets are written.
#[tauri::command]
pub async fn sync_export(app_handle: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sync_export_blocking(app_handle))
        .await
        .map_err(|e| format!("sync task failed: {e}"))?
}

fn sync_export_blocking(app_handle: AppHandle) -> Result<(), String> {
    let cfg = config::load_config(&app_handle)?;
    let repo = cfg.settings.sync_repo_url.trim().to_string();
    if repo.is_empty() {
        return Err("no sync repo configured (set it in settings)".to_string());
    }

    let dir = sync_dir(&app_handle)?;
    // Clone if the working tree doesn't already exist.
    if !dir.join(".git").exists() {
        git(dir.parent().unwrap_or(&dir), &["clone", &repo, dir.to_str().unwrap_or("sync")])?;
    } else {
        // Pull latest to avoid a stale base.
        let _ = git(&dir, &["pull", "--rebase"]);
    }

    let exported = ExportedRegistry {
        machine: machine_name(),
        exported_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        instances: cfg
            .servers
            .values()
            .map(|s| ExportedInstance {
                id: s.id.clone(),
                name: s.name.clone(),
                server_type: s.server_type.clone(),
                auto_start: s.auto_start,
                status: s.status.clone(),
            })
            .collect(),
    };

    let json = serde_json::to_string_pretty(&serde_json::json!({
        "machine": exported.machine,
        "exportedAt": exported.exported_at,
        "instances": exported.instances,
    }))
    .map_err(|e| format!("serialize failed: {e}"))?;

    let file = dir.join("registry.json");
    std::fs::write(&file, json).map_err(|e| format!("write failed: {e}"))?;

    git(&dir, &["add", "registry.json"])?;
    // Commit; allow no-op if nothing changed.
    let commit = git(&dir, &["commit", "-m", &format!("sync from {}", exported.machine)]);
    if let Err(e) = commit {
        if !e.contains("nothing to commit") && !e.contains("no changes") {
            return Err(e);
        }
    }
    git(&dir, &["push"])?;
    Ok(())
}

/// Imports the registry from the configured git repo as a read-only view of
/// other machines' instances. Never writes to local config.
#[tauri::command]
pub async fn sync_import(app_handle: AppHandle) -> Result<Vec<ExportedRegistry>, String> {
    tauri::async_runtime::spawn_blocking(move || sync_import_blocking(app_handle))
        .await
        .map_err(|e| format!("sync task failed: {e}"))?
}

fn sync_import_blocking(app_handle: AppHandle) -> Result<Vec<ExportedRegistry>, String> {
    let cfg = config::load_config(&app_handle)?;
    let repo = cfg.settings.sync_repo_url.trim().to_string();
    if repo.is_empty() {
        return Err("no sync repo configured".to_string());
    }
    let dir = sync_dir(&app_handle)?;
    if !dir.join(".git").exists() {
        git(dir.parent().unwrap_or(&dir), &["clone", &repo, dir.to_str().unwrap_or("sync")])?;
    } else {
        git(&dir, &["pull"])?;
    }

    // registry.json is one machine's export; gather all *.json as separate machines.
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read sync dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(reg) = serde_json::from_str::<ExportedRegistry>(&text) {
                    out.push(reg);
                }
            }
        }
    }
    Ok(out)
}
