//! Plugin manifest loading.
//!
//! Spec: documentation/ArchitecturePlan.md §3 (Plugin Manifest Specification).
//! Each community plugin supplies a `manifest.json` describing its UI entry,
//! configurable fields (configSchema), and lifecycle commands (install/start).
//!
//! In Phase 2 we only consume the `lifecycle` block to resolve the command
//! and args that launch the server process. The configSchema-driven dynamic
//! form engine arrives in Phase 3.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A static tab declaration in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTabInfo {
    pub id: String,
    pub label: String,
}

/// A plugin manifest.json document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub display_name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    /// Optional description shown during plugin install preview.
    #[serde(default)]
    pub description: String,
    /// Path to the compiled ESM frontend bundle, relative to the manifest.
    #[serde(default)]
    pub ui_entry: Option<String>,
    /// Capability grants this plugin requires. Unknown entries are rejected at
    /// install time; the host's HostAPI only forwards commands covered by the
    /// granted permissions. Empty = no access (fail closed).
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Minimum host version required to run this plugin (e.g. "0.2.0").
    #[serde(default)]
    pub kern_compat: Option<String>,
    /// Configuration fields surfaced to the host for dynamic form generation.
    #[serde(default)]
    pub config_schema: Vec<SchemaField>,
    /// Named lifecycle commands (install / start / stop ...).
    #[serde(default)]
    pub lifecycle: LifecycleMap,
    /// Optional stdin command for graceful shutdown, e.g. "stop" for Minecraft
    /// or "shutdown" for other console servers. Empty string = skip the stdin
    /// step. `None` falls back to the host default ("stop") unless a `stop`
    /// lifecycle step is declared.
    #[serde(default)]
    pub stop_command: Option<String>,
    /// Starter files written into a fresh instance directory, keyed by a label
    /// (e.g. "main", "package_json", "cargo_toml"). See ScaffoldFile.
    #[serde(default)]
    pub scaffold: std::collections::HashMap<String, ScaffoldFile>,
    /// Optional static tab declarations.
    /// These describe tabs the plugin may register dynamically at runtime.
    /// The actual mount functions are provided via the JS bundle.
    #[serde(default)]
    pub tabs: Vec<PluginTabInfo>,
}

/// One configurable field in the manifest's configSchema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    pub key: String,
    pub label: String,
    /// "text" | "select" | (future) others.
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub default: String,
    /// Optional dependency: this field's default changes based on another field.
    /// e.g. an "entry" field that defaults to "index.js" under node but
    /// "src/main.rs" under rust.
    #[serde(default)]
    pub depends_on: Option<DependsOn>,
}

/// Declares that a field's default is derived from the value of another field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependsOn {
    /// The key of the field this one depends on (e.g. "runtime").
    pub field: String,
    /// Map of the dependency's value → this field's default.
    pub defaults: HashMap<String, String>,
}

/// A single starter file the host writes into a fresh instance directory.
/// Path may contain templates resolved against the instance's overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldFile {
    /// Relative path inside the instance dir. May use {{userOverrides.*}}.
    pub path: String,
    /// File contents. May use {{userOverrides.*}} templates.
    #[serde(default)]
    pub content: String,
    /// Only write this file when the override `field` equals one of `values`.
    /// Lets a plugin ship runtime-specific scaffolds (e.g. Cargo.toml only for rust).
    #[serde(default)]
    pub when: Option<Condition>,
}

/// A condition gating a scaffold file on an override value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub field: String,
    pub values: Vec<String>,
}

/// A single lifecycle step: a command + args, possibly templated with
/// `{{userOverrides.*}}` placeholders resolved at launch time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LifecycleStep {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// When true, the command is run through the OS shell (`sh -c` on Unix,
    /// `cmd.exe /C` on Windows) instead of being spawned directly. Needed for
    /// runtimes (Forge/NeoForge) whose installer generates `.bat`/`.sh` launch
    /// scripts that can't be `exec`'d as a plain binary. Off by default so
    /// existing manifests spawn exactly as before.
    #[serde(default, rename = "useShell")]
    pub use_shell: bool,
}

/// Map of lifecycle step name → step. Common keys: "install", "start", "stop".
pub type LifecycleMap = std::collections::HashMap<String, LifecycleStep>;

/// Reads and parses a manifest.json from disk.
pub fn load(manifest_path: &Path) -> Result<Manifest, String> {
    let raw = fs::read_to_string(manifest_path).map_err(|e| {
        format!(
            "failed to read manifest '{}': {e}",
            manifest_path.display()
        )
    })?;
    serde_json::from_str::<Manifest>(&raw).map_err(|e| {
        format!(
            "failed to parse manifest '{}': {e}",
            manifest_path.display()
        )
    })
}

/// Directory containing community plugins: `<app_data>/plugins/`.
pub fn plugins_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("plugins")
}

/// Scans the plugins directory and returns every valid manifest, sorted by id.
/// Broken/malformed plugin folders are skipped (their error is swallowed) so a
/// single bad plugin can't prevent the host from listing the rest.
pub fn discover(plugins_dir: &Path) -> Vec<Manifest> {
    let Ok(entries) = fs::read_dir(plugins_dir) else {
        return Vec::new();
    };
    let mut found: Vec<Manifest> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let manifest_path = entry.path().join("manifest.json");
            if !manifest_path.is_file() {
                return None;
            }
            load(&manifest_path).ok()
        })
        .collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}

/// Loads a single plugin's manifest by id from the plugins directory.
pub fn load_by_id(plugins_dir: &Path, id: &str) -> Result<Manifest, String> {
    crate::paths::validate_plugin_id(id)?;
    let path = plugins_dir.join(id).join("manifest.json");
    load(&path)
}

/// Every permission the host understands. A manifest declaring anything else
/// is rejected at install time (fail closed).
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "servers:read",
    "servers:write",
    "files:read",
    "files:write",
    "process",
    "downloads",
    "backups",
    "metrics",
    "plugins:manage",
    "plugin:kv",
    "plugin:secrets",
    "rcon",
    "sync",
    "ui",
];

/// Rejects manifests requesting permissions the host doesn't understand.
pub fn validate_permissions(manifest: &Manifest) -> Result<(), String> {
    for p in &manifest.permissions {
        if !KNOWN_PERMISSIONS.contains(&p.as_str()) {
            return Err(format!(
                "plugin '{}' requests unknown permission '{p}'",
                manifest.id
            ));
        }
    }
    Ok(())
}

/// True when the running host version is >= `required`. Lenient parser:
/// accepts "1.2.3", "v1.2.3", ">=1.2.3"; non-numeric parts are ignored.
pub fn version_satisfies(required: &str) -> bool {
    fn parse(v: &str) -> Vec<u64> {
        let v = v
            .trim()
            .trim_start_matches(">=")
            .trim()
            .trim_start_matches(['v', 'V'])
            .trim();
        v.split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<u64>().unwrap_or(0))
            .collect()
    }

    let req = parse(required);
    if req.is_empty() {
        return true; // nothing parseable — don't block the plugin
    }
    let host = parse(env!("CARGO_PKG_VERSION"));
    for (i, want) in req.iter().enumerate() {
        let have = host.get(i).copied().unwrap_or(0);
        match have.cmp(want) {
            std::cmp::Ordering::Greater => return true,
            std::cmp::Ordering::Less => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    true
}

/// Full install-time validation: id, permissions, and host compatibility.
pub fn validate_installable(manifest: &Manifest) -> Result<(), String> {
    crate::paths::validate_plugin_id(&manifest.id)?;
    validate_permissions(manifest)?;
    if let Some(req) = &manifest.kern_compat {
        if !req.trim().is_empty() && !version_satisfies(req) {
            return Err(format!(
                "plugin '{}' requires kern {req} or newer (running {})",
                manifest.id,
                env!("CARGO_PKG_VERSION")
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_satisfies_parses_common_forms() {
        assert!(version_satisfies("0.0.1"));
        assert!(version_satisfies("0.2.0"));
        assert!(version_satisfies(">=0.2.0"));
        assert!(version_satisfies("v0.2.0"));
        assert!(version_satisfies("0.2.0-beta.1"));
        assert!(version_satisfies(""));
    }

    #[test]
    fn version_satisfies_rejects_newer() {
        assert!(!version_satisfies("99.0.0"));
        // Derive the "newer" version from the running host so the test can
        // never go stale on a release bump (it did at 0.3.0).
        let host = env!("CARGO_PKG_VERSION");
        let mut parts: Vec<u64> = host
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
            })
            .map(|p| p.parse().unwrap_or(0))
            .collect();
        parts.resize(3, 0);
        let newer = format!("{}.{}.{}", parts[0], parts[1], parts[2] + 1);
        assert!(!version_satisfies(&newer), "expected {newer} to be rejected");
        // The host version itself satisfies an equal requirement.
        assert!(version_satisfies(host));
    }

    fn manifest_with(perms: &[&str], compat: Option<&str>) -> Manifest {
        serde_json::from_value(serde_json::json!({
            "id": "test_plugin",
            "displayName": "Test",
            "version": "1.0.0",
            "permissions": perms,
            "kernCompat": compat,
        }))
        .expect("manifest should parse")
    }

    #[test]
    fn install_validation_accepts_known_permissions() {
        let m = manifest_with(&["files:read", "process"], None);
        assert!(validate_installable(&m).is_ok());
    }

    #[test]
    fn install_validation_rejects_unknown_permissions() {
        let m = manifest_with(&["all:the:things"], None);
        assert!(validate_installable(&m).is_err());
    }

    #[test]
    fn install_validation_rejects_future_host_requirement() {
        let m = manifest_with(&[], Some("99.0.0"));
        assert!(validate_installable(&m).is_err());
    }

    #[test]
    fn install_validation_rejects_bad_id() {
        let m = manifest_with(&[], None);
        let mut m = m;
        m.id = "../evil".to_string();
        assert!(validate_installable(&m).is_err());
    }
}
