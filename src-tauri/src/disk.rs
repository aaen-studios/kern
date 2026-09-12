//! Free-space helpers for preflight guards (backups, starts).
//!
//! Uses `sysinfo`'s disk list (already a dependency) and picks the disk whose
//! mount point is the longest prefix of the target path — so `C:\` wins over
//! a nested mount when both technically match.

use std::path::{Path, PathBuf};

/// Free bytes on the filesystem containing `path`, or `None` when it can't be
/// determined (missing path, no matching disk).
pub fn available_space_for(path: &Path) -> Option<u64> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let pairs: Vec<(PathBuf, u64)> = disks
        .iter()
        .map(|d| (d.mount_point().to_path_buf(), d.available_space()))
        .collect();
    best_disk(&pairs, &target)
}

/// Picks the free space of the disk with the longest mount-point prefix of
/// `target`. Pure so it can be unit-tested without real disks.
fn best_disk(disks: &[(PathBuf, u64)], target: &Path) -> Option<u64> {
    disks
        .iter()
        .filter(|(mount, _)| target.starts_with(mount))
        .max_by_key(|(mount, _)| mount.components().count())
        .map(|(_, free)| *free)
}

/// Size in bytes of a directory tree (symlinks not followed), used to estimate
/// whether a backup will fit. Best-effort: unreadable entries are skipped.
pub fn dir_size_bytes(path: &Path) -> u64 {
    fn walk(dir: &Path, total: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&entry.path(), total);
            } else {
                *total = total.saturating_add(meta.len());
            }
        }
    }
    let mut total = 0u64;
    walk(path, &mut total);
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_longest_mount_prefix() {
        let disks = vec![
            (PathBuf::from("/"), 1_000),
            (PathBuf::from("/mnt/data"), 2_000),
            (PathBuf::from("/mnt/data/nested"), 3_000),
        ];
        assert_eq!(
            best_disk(&disks, Path::new("/mnt/data/games/mc")),
            Some(2_000)
        );
        assert_eq!(best_disk(&disks, Path::new("/etc/hosts")), Some(1_000));
        assert_eq!(
            best_disk(&disks, Path::new("/mnt/data/nested/x")),
            Some(3_000)
        );
    }

    #[test]
    fn no_match_returns_none() {
        let disks = vec![(PathBuf::from("/a"), 1)];
        assert_eq!(best_disk(&disks, Path::new("/b/c")), None);
    }

    #[test]
    fn dir_size_counts_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size_bytes(dir.path()), 150);
    }
}
