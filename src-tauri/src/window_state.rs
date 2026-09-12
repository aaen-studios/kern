//! Persisted window geometry — restores the last position/size/maximized state
//! across launches and saves it again on close.
//!
//! Pattern adapted from the galdr app, which rolls its own window-state file
//! rather than pulling `tauri-plugin-window-state`. State lives next to
//! config.json in the app data directory as `window.json`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, PhysicalPosition, WebviewWindow};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    /// Whether the window was hidden to the tray when the app last exited.
    /// Restored on the next manual launch so "persist... if app was opened or
    /// just in tray" holds. OS-login auto-launches honor
    /// `AppSettings.start_hidden_in_tray` instead.
    #[serde(default)]
    pub hidden: bool,
}

fn state_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::config::config_dir(app_handle)?.join("window.json"))
}

/// Loads persisted window state, if any.
pub fn load(app_handle: &AppHandle) -> Result<Option<WindowState>, String> {
    let path = state_path(app_handle)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read '{}': {e}", path.display()))?;
    let state = serde_json::from_str::<WindowState>(&raw)
        .map_err(|e| format!("failed to parse '{}': {e}", path.display()))?;
    Ok(Some(state))
}

/// Persists window state atomically (temp file + rename).
pub fn save(app_handle: &AppHandle, state: &WindowState) -> Result<(), String> {
    let path = state_path(app_handle)?;
    let raw = serde_json::to_string_pretty(state)
        .map_err(|e| format!("failed to serialize window state: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| format!("failed to write '{}': {e}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("failed to commit '{}': {e}", path.display()))?;
    Ok(())
}

/// Captures the current window geometry into a `WindowState`.
pub fn capture(window: &WebviewWindow) -> Result<WindowState, String> {
    let maximized = window
        .is_maximized()
        .map_err(|e| format!("is_maximize failed: {e}"))?;
    let visible = window
        .is_visible()
        .map_err(|e| format!("is_visible failed: {e}"))?;
    // outer_size/outer_position return physical pixels already.
    let size = window
        .outer_size()
        .map_err(|e| format!("outer_size failed: {e}"))?;
    let pos = window
        .outer_position()
        .map_err(|e| format!("outer_position failed: {e}"))?;
    Ok(WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
        hidden: !visible,
    })
}

/// Persists just the `hidden` flag, leaving geometry untouched. Used by the
/// tray show/hide paths so toggling visibility anywhere updates the remembered
/// state without rewriting position/size.
pub fn set_hidden(app_handle: &AppHandle, hidden: bool) {
    if let Ok(Some(mut state)) = load(app_handle) {
        state.hidden = hidden;
        let _ = save(app_handle, &state);
    }
}

/// Applies persisted state to the window. Called once during app setup.
pub fn restore(window: &WebviewWindow, state: &WindowState) {
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    // State is stored in physical pixels; set_size accepts them directly.
    let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
    if state.maximized {
        let _ = window.maximize();
    }
}
