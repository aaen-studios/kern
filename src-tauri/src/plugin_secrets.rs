//! Per-plugin secret storage backed by the OS credential vault
//! (Windows Credential Manager / macOS Keychain / Secret Service on Linux).
//!
//! Secrets never touch config.json or the plugin's KV store. Access is gated
//! by the `plugin:secrets` permission in the plugin manifest.

use tauri::AppHandle;

use crate::config;
use crate::manifest;
use crate::paths;

/// Service name namespace: one vault entry per plugin + key.
fn service_name(plugin_id: &str) -> String {
    format!("kern.plugin.{plugin_id}")
}

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

fn entry(plugin_id: &str, key: &str) -> Result<keyring::Entry, String> {
    if key.trim().is_empty() {
        return Err("secret key must not be empty".to_string());
    }
    keyring::Entry::new(&service_name(plugin_id), key)
        .map_err(|e| format!("credential store unavailable: {e}"))
}

/// Stores a secret for a plugin.
#[tauri::command]
pub fn plugin_secret_set(
    app_handle: AppHandle,
    plugin_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    ensure_plugin_installed(&app_handle, &plugin_id)?;
    entry(&plugin_id, &key)?
        .set_password(&value)
        .map_err(|e| format!("failed to store secret: {e}"))
}

/// Reads a secret for a plugin (`None` when unset).
#[tauri::command]
pub fn plugin_secret_get(
    app_handle: AppHandle,
    plugin_id: String,
    key: String,
) -> Result<Option<String>, String> {
    ensure_plugin_installed(&app_handle, &plugin_id)?;
    match entry(&plugin_id, &key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("failed to read secret: {e}")),
    }
}

/// Deletes a secret for a plugin (missing entries are a no-op).
#[tauri::command]
pub fn plugin_secret_delete(
    app_handle: AppHandle,
    plugin_id: String,
    key: String,
) -> Result<(), String> {
    ensure_plugin_installed(&app_handle, &plugin_id)?;
    match entry(&plugin_id, &key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete secret: {e}")),
    }
}
