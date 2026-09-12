//! Per-plugin key-value storage.
//!
//! Plugins get a small private JSON store at
//! `<app_data>/plugin_data/<plugin_id>/kv.json`. Values are arbitrary JSON so
//! a plugin can persist settings, caches, or small state without touching the
//! server config or inventing its own file layout.
//!
//! Access is gated by the `plugin:kv` permission in the plugin manifest.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value;
use tauri::AppHandle;

use crate::config;
use crate::manifest;
use crate::paths;

fn ensure_plugin_installed(app_handle: &AppHandle, plugin_id: &str) -> Result<(), String> {
    paths::validate_plugin_id(plugin_id)?;
    let base = config::config_dir(app_handle)?;
    let manifest_path = manifest::plugins_dir(&base)
        .join(plugin_id)
        .join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!("plugin '{plugin_id}' is not installed"));
    }
    Ok(())
}

fn store_path(app_handle: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    let base = config::config_dir(app_handle)?;
    let dir = base.join("plugin_data").join(plugin_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create plugin data dir: {e}"))?;
    Ok(dir.join("kv.json"))
}

fn read_store(app_handle: &AppHandle, plugin_id: &str) -> Result<HashMap<String, Value>, String> {
    let path = store_path(app_handle, plugin_id)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read plugin store: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&raw).map_err(|e| format!("plugin store is corrupt: {e}"))
}

fn write_store(
    app_handle: &AppHandle,
    plugin_id: &str,
    store: &HashMap<String, Value>,
) -> Result<(), String> {
    let path = store_path(app_handle, plugin_id)?;
    let raw = serde_json::to_string_pretty(store)
        .map_err(|e| format!("failed to serialize plugin store: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("failed to write plugin store: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("failed to commit plugin store: {e}"))?;
    Ok(())
}

/// Reads one key from a plugin's store.
#[tauri::command]
pub fn plugin_kv_get(
    app_handle: AppHandle,
    plugin_id: String,
    key: String,
) -> Result<Option<Value>, String> {
    ensure_plugin_installed(&app_handle, &plugin_id)?;
    Ok(read_store(&app_handle, &plugin_id)?.remove(&key))
}

/// Writes one key into a plugin's store.
#[tauri::command]
pub fn plugin_kv_set(
    app_handle: AppHandle,
    plugin_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    ensure_plugin_installed(&app_handle, &plugin_id)?;
    let mut store = read_store(&app_handle, &plugin_id)?;
    store.insert(key, value);
    write_store(&app_handle, &plugin_id, &store)
}

/// Removes one key from a plugin's store.
#[tauri::command]
pub fn plugin_kv_delete(
    app_handle: AppHandle,
    plugin_id: String,
    key: String,
) -> Result<(), String> {
    ensure_plugin_installed(&app_handle, &plugin_id)?;
    let mut store = read_store(&app_handle, &plugin_id)?;
    store.remove(&key);
    write_store(&app_handle, &plugin_id, &store)
}

/// Returns the plugin's whole store (for small datasets / debugging).
#[tauri::command]
pub fn plugin_kv_list(
    app_handle: AppHandle,
    plugin_id: String,
) -> Result<HashMap<String, Value>, String> {
    ensure_plugin_installed(&app_handle, &plugin_id)?;
    read_store(&app_handle, &plugin_id)
}

/// Clears the plugin's store (used on uninstall).
pub fn clear_plugin_data(app_handle: &AppHandle, plugin_id: &str) {
    if let Ok(base) = config::config_dir(app_handle) {
        let dir = base.join("plugin_data").join(plugin_id);
        let _ = std::fs::remove_dir_all(dir);
    }
}
