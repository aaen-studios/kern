//! Dev-time plugin seeder.
//!
//! Copies the repo's `plugins/` directory into `<app_data>/plugins/` so the
//! sample community plugins are discoverable by the manifest engine without a
//! manual install step. In production builds this is a no-op (the source path
//! doesn't exist), and shipped plugins would be installed by the user instead.
//!
//! The copy is content-aware: it overwrites on every run, so editing a sample
//! plugin in the repo and restarting `tauri dev` immediately reflects changes.

use std::fs;
use std::path::{Path, PathBuf};

/// Resolves the repo `plugins/` source directory.
///
/// `CARGO_MANIFEST_DIR` is a compile-time value that is baked into release
/// binaries too, so this is gated on debug builds: a release install must
/// never overwrite the user's installed plugins from a path that merely
/// happened to exist on the build machine.
fn source_plugins_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None; // release build — never seed
    }
    let dir = option_env!("CARGO_MANIFEST_DIR")?;
    let path = Path::new(dir).join("..").join("plugins");
    path.is_dir().then_some(path)
}

/// Seeds `<app_data>/plugins/` from the repo. Logs failures to stderr but
/// never propagates them — seeding is a dev convenience, not a hard dependency.
pub fn seed(plugins_target: &Path) {
    let Some(src) = source_plugins_dir() else {
        // Release build (or no repo plugins) — nothing to seed.
        return;
    };

    if let Err(e) = fs::create_dir_all(plugins_target) {
        eprintln!("[seed] could not create plugins dir: {e}");
        return;
    }

    if let Err(e) = copy_dir_recursive(&src, plugins_target) {
        eprintln!("[seed] failed to seed plugins: {e}");
    }
}

/// Recursively copies a directory, overwriting existing files. Used instead of
/// a crate dependency for this one-shot dev helper.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
