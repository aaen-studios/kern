//! Persisted UI state — restores the full window UI state across launches:
//! which view was active, which server was being viewed, which tab was
//! selected, what files were open, what tree directories were expanded,
//! plugin panel collapsed state, etc.
//!
//! Pattern mirrors `window_state.rs`: an opaque JSON blob stored next to
//! config.json in the app data directory as `ui_state.json`. The frontend
//! owns the schema; the backend just stores and loads the raw value.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, command};

/// Absolute path to ui_state.json.
fn state_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::config::config_dir(app_handle)?.join("ui_state.json"))
}

/// Loads persisted UI state, if any. Returns Ok(None) when the file is
/// missing or unreadable — callers fall back to defaults.
pub fn load(app_handle: &AppHandle) -> Result<Option<Value>, String> {
    let path = state_path(app_handle)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read '{}': {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let value = serde_json::from_str::<Value>(&raw)
        .map_err(|e| format!("failed to parse '{}': {e}", path.display()))?;
    Ok(Some(value))
}

/// Persists UI state atomically (temp file + rename).
pub fn save(app_handle: &AppHandle, state: &Value) -> Result<(), String> {
    let path = state_path(app_handle)?;
    let raw = serde_json::to_string_pretty(state)
        .map_err(|e| format!("failed to serialize UI state: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| format!("failed to write '{}': {e}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("failed to commit '{}': {e}", path.display()))?;
    Ok(())
}

/// Tauri command: returns the persisted UI state as a JSON Value,
/// or Value::Null when nothing has been saved yet.
#[command]
pub fn get_ui_state(app_handle: AppHandle) -> Result<Value, String> {
    load(&app_handle).map(|opt| opt.unwrap_or(Value::Null))
}

/// Tauri command: persists the full UI state blob. The frontend sends
/// the entire state object on every debounced save.
#[command]
pub fn set_ui_state(app_handle: AppHandle, state: Value) -> Result<(), String> {
    save(&app_handle, &state)
}
