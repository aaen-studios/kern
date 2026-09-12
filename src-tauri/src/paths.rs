//! Sandboxed path resolution.
//!
//! Every path derived from untrusted input (relative file paths, plugin ids,
//! `uiEntry`, scaffold paths, backup names, archive entries) must go through
//! these helpers. They are the single containment primitive for the host.
//!
//! Two properties matter:
//!   1. Lexical normalisation rejects absolute paths, drive prefixes, and
//!      `..` traversal before any filesystem access.
//!   2. Containment is checked against a canonicalised existing ancestor, so
//!      symlinks that point outside the sandbox are rejected, and paths that
//!      don't exist yet still work.
//!
//! The previous implementation compared a canonicalised root against a
//! *non-canonical* joined path for targets that don't exist yet. On Windows
//! `canonicalize()` returns a `\\?\`-prefixed path while the joined path does
//! not, so every legitimate new file was rejected (and `.kern` extraction
//! aborted on the first entry). On Unix the un-normalised joined path let
//! `..` through when the target didn't exist. Both classes are covered by the
//! tests at the bottom of this file.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

/// Normalises a relative path and rejects anything that could escape its
/// parent. Returns the cleaned relative path (may be empty for `""`).
///
/// This is purely lexical — it never touches the filesystem.
pub fn normalize_relative(rel: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err("path traversal detected".to_string());
                }
            }
            // Absolute paths and Windows prefixes (`C:`, `\\server\share`)
            // are never valid relative input.
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute paths are not allowed".to_string());
            }
        }
    }
    Ok(out)
}

/// Resolves `rel` under `root`, guaranteeing the result stays inside `root`.
///
/// - Rejects absolute paths, drive prefixes, and `..` escapes lexically.
/// - Canonicalises the deepest existing ancestor and verifies it is still
///   under the canonicalised root, so symlinks cannot be used to escape.
/// - Works for targets that don't exist yet (new files/directories).
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let tail = normalize_relative(rel)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve root '{}': {e}", root.display()))?;

    if tail.as_os_str().is_empty() {
        return Ok(root.to_path_buf());
    }

    // Probe through the canonical root so verbatim Windows prefixes compare
    // like-for-like, then return the caller's spelling of the root.
    let probe = canonical_root.join(&tail);
    let mut existing: &Path = &probe;
    let mut trailing: Vec<&OsStr> = Vec::new();
    loop {
        if existing.exists() {
            break;
        }
        let Some(name) = existing.file_name() else {
            return Err("path traversal detected".to_string());
        };
        trailing.push(name);
        existing = existing
            .parent()
            .ok_or_else(|| "path traversal detected".to_string())?;
    }

    let canonical_existing = existing
        .canonicalize()
        .map_err(|e| format!("cannot resolve '{}': {e}", existing.display()))?;
    if !canonical_existing.starts_with(&canonical_root) {
        return Err("path traversal detected".to_string());
    }

    let mut out = root.join(&tail);
    // The probe confirmed containment; `out` mirrors it in the caller's
    // spelling. (No canonicalisation of the final component: it may not exist.)
    if out.as_os_str().is_empty() {
        out = canonical_existing;
    }
    Ok(out)
}

/// Validates a value that must be a single file name (no separators, no `..`).
/// Used for backup archive names submitted by the frontend.
pub fn safe_file_name(name: &str) -> Result<PathBuf, String> {
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(c)), None) => Ok(PathBuf::from(c)),
        _ => Err(format!("invalid file name '{name}'")),
    }
}

/// True when `path` is inside `root`, resolving symlinks for the deepest
/// existing ancestor. Works for not-yet-existing paths and handles the
/// Windows verbatim-prefix mismatch.
pub fn is_within(root: &Path, path: &Path) -> bool {
    let Ok(canonical_root) = root.canonicalize() else {
        // Root doesn't exist yet — fall back to a lexical check on the
        // normalized paths. Only used for roots that haven't been created.
        return path
            .components()
            .collect::<PathBuf>()
            .starts_with(root.components().collect::<PathBuf>());
    };
    let mut existing: &Path = path;
    loop {
        if existing.exists() {
            break;
        }
        match existing.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => existing = parent,
            _ => return false,
        }
    }
    match existing.canonicalize() {
        Ok(canonical) => canonical.starts_with(&canonical_root),
        Err(_) => false,
    }
}

/// Validates a plugin id. Ids become directory names under `<app_data>/plugins`,
/// so they must be a single safe path component: ASCII alphanumerics plus
/// `_`, `-`, `.`, no leading dot, at most 64 chars.
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("plugin id must be 1-64 characters".to_string());
    }
    if id == "." || id == ".." || id.starts_with('.') {
        return Err(format!("invalid plugin id '{id}'"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(format!(
            "invalid plugin id '{id}' (allowed: letters, digits, '_', '-', '.')"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn normalizes_nested_path() {
        assert_eq!(
            normalize_relative("a/b/c.txt").unwrap(),
            PathBuf::from("a/b/c.txt")
        );
    }

    #[test]
    fn collapses_cur_dir_and_internal_parent() {
        assert_eq!(
            normalize_relative("./a/./b/../c").unwrap(),
            PathBuf::from("a/c")
        );
    }

    #[test]
    fn rejects_parent_escape() {
        assert!(normalize_relative("../evil").is_err());
        assert!(normalize_relative("a/../../evil").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(normalize_relative("/etc/passwd").is_err());
        // A leading backslash is only a root on Windows; on Unix it's a legal
        // filename character, so this assertion is platform-specific.
        #[cfg(windows)]
        assert!(normalize_relative("\\windows\\system32").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_prefix_paths() {
        assert!(normalize_relative("C:\\Windows").is_err());
        assert!(normalize_relative("C:relative").is_err());
        assert!(normalize_relative("\\\\server\\share").is_err());
    }

    #[test]
    fn safe_join_allows_new_nested_file() {
        // Regression: on Windows the old implementation rejected this because
        // the joined path wasn't canonicalised while the root was verbatim.
        let dir = tmp();
        let target = safe_join(dir.path(), "new/nested/file.txt").expect("new file allowed");
        assert!(target.starts_with(dir.path()) || target.starts_with(dir.path().canonicalize().unwrap()));
    }

    #[test]
    fn safe_join_allows_existing_file() {
        let dir = tmp();
        fs::write(dir.path().join("a.txt"), "hi").unwrap();
        let target = safe_join(dir.path(), "a.txt").unwrap();
        assert!(target.exists());
        assert_eq!(fs::read_to_string(target).unwrap(), "hi");
    }

    #[test]
    fn safe_join_rejects_escape() {
        let dir = tmp();
        assert!(safe_join(dir.path(), "../outside.txt").is_err());
        assert!(safe_join(dir.path(), "a/../../outside.txt").is_err());
        assert!(safe_join(dir.path(), "..").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn safe_join_rejects_symlink_escape() {
        let dir = tmp();
        let outside = tmp();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(safe_join(dir.path(), "link/evil.txt").is_err());
        fs::write(outside.path().join("existing.txt"), "x").unwrap();
        assert!(safe_join(dir.path(), "link/existing.txt").is_err());
    }

    #[test]
    fn safe_file_name_accepts_plain_names() {
        assert_eq!(
            safe_file_name("world-123.zip").unwrap(),
            PathBuf::from("world-123.zip")
        );
    }

    #[test]
    fn safe_file_name_rejects_separators_and_parent() {
        assert!(safe_file_name("../../etc/passwd").is_err());
        assert!(safe_file_name("a/b.zip").is_err());
        // Backslash is a separator only on Windows.
        #[cfg(windows)]
        assert!(safe_file_name("a\\b.zip").is_err());
        assert!(safe_file_name("..").is_err());
        assert!(safe_file_name("").is_err());
    }

    #[test]
    fn is_within_matches_descendants_only() {
        let root = tmp();
        let inside = root.path().join("a/b/c.txt");
        assert!(is_within(root.path(), &inside));
        assert!(is_within(root.path(), root.path()));
        let outside = tmp();
        assert!(!is_within(root.path(), &outside.path().join("x.txt")));
        assert!(!is_within(root.path(), Path::new("../escape")));
    }

    #[cfg(unix)]
    #[test]
    fn is_within_rejects_symlink_escape() {
        let root = tmp();
        let outside = tmp();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(!is_within(root.path(), &root.path().join("link/file.txt")));
    }

    #[test]
    fn plugin_id_rules() {
        assert!(validate_plugin_id("minecraft_java").is_ok());
        assert!(validate_plugin_id("discord-bot").is_ok());
        assert!(validate_plugin_id("a.b").is_ok());
        assert!(validate_plugin_id("..").is_err());
        assert!(validate_plugin_id(".").is_err());
        assert!(validate_plugin_id(".hidden").is_err());
        assert!(validate_plugin_id("a/b").is_err());
        assert!(validate_plugin_id("a\\b").is_err());
        assert!(validate_plugin_id("C:evil").is_err());
        assert!(validate_plugin_id("").is_err());
        assert!(validate_plugin_id(&"x".repeat(65)).is_err());
    }
}
