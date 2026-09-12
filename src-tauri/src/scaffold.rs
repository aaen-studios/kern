//! Instance directory scaffolding.
//!
//! When a server instance is created, the host writes the plugin's declared
//! `scaffold` files into the instance directory. This gives the user a working
//! starting point (entry file, package.json/Cargo.toml, etc.) instead of an
//! empty folder — and crucially means the path exists immediately, so a fresh
//! instance is never orphaned on first load.
//!
//! Existing files are never overwritten: re-running scaffold (e.g. after an
//! edit) preserves whatever the user has changed.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::manifest::{Manifest, ScaffoldFile};
use crate::paths;
use crate::process;

/// Writes the plugin's scaffold files into `instance_dir`.
///
/// - Creates `instance_dir` (and any parents) if missing.
/// - Resolves `{{userOverrides.*}}` in each file's path + content.
/// - Skips files that don't match their `when` condition.
/// - Skips files that already exist (never clobber user work).
///
/// Never propagates errors — a failed scaffold shouldn't block instance
/// creation; the user still gets the registry entry and can populate the
/// folder manually. Failures are logged to stderr.
pub fn write(instance_dir: &Path, manifest: &Manifest, overrides: &HashMap<String, String>) {
    if let Err(e) = fs::create_dir_all(instance_dir) {
        eprintln!("[scaffold] could not create '{}': {e}", instance_dir.display());
        return;
    }

    for file in manifest.scaffold.values() {
        if !condition_met(file, overrides) {
            continue;
        }
        if let Err(e) = write_one(instance_dir, file, overrides) {
            eprintln!("[scaffold] could not write '{}': {e}", file.path);
        }
    }
}

/// True when the file's `when` condition is satisfied (or it has none).
fn condition_met(file: &ScaffoldFile, overrides: &HashMap<String, String>) -> bool {
    let Some(cond) = &file.when else {
        return true;
    };
    let actual = overrides.get(&cond.field).map(String::as_str).unwrap_or("");
    cond.values.iter().any(|v| v == actual)
}

/// Writes a single scaffold file, skipping if it already exists.
fn write_one(
    instance_dir: &Path,
    file: &ScaffoldFile,
    overrides: &HashMap<String, String>,
) -> Result<(), String> {
    let rel = process::resolve_variables(&file.path, overrides);

    // Traversal guard: a malicious plugin manifest could set `path` to
    // "../../.ssh/authorized_keys" and write outside the instance dir.
    // `paths::safe_join` rejects absolute paths and `..` escapes lexically,
    // works for not-yet-existing files, and is symlink-aware.
    let target = match paths::safe_join(instance_dir, &rel) {
        Ok(target) => target,
        Err(e) => {
            eprintln!(
                "[scaffold] refusing to write '{}' — {e}",
                file.path
            );
            return Ok(()); // skip, don't fail the whole scaffold
        }
    };

    // Don't clobber existing files — respect the user's edits.
    if target.exists() {
        return Ok(());
    }

    // Create any parent directories (e.g. "src/main.rs").
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all failed: {e}"))?;
    }

    let content = process::resolve_variables(&file.content, overrides);
    fs::write(&target, content).map_err(|e| format!("write failed: {e}"))
}
