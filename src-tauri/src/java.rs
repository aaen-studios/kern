//! Java runtime detection for the Minecraft server plugin.
//!
//! Scans the system for Java installations and provides version information.
//! Used by the plugin auto-installer to suggest the right Java version for
//! a given Minecraft version, and to auto-detect `java_path`.
//!
//! Detection strategy:
//! 1. `JAVA_HOME` environment variable
//! 2. `java` / `javaw` on `PATH`
//! 3. Standard install directories per platform

use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// Hard cap on a JDK archive download (1.5 GiB; Temurin JDKs are ~200 MB).
const MAX_JDK_ARCHIVE_BYTES: u64 = 1_500_000_000;
/// Global timeout for a JDK download.
const JDK_DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// Describes a single Java installation on the system.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstall {
    /// Absolute path to the java executable.
    pub path: String,
    /// Full version string from `java -version` (e.g. "17.0.9").
    pub version: String,
    /// Major version number (e.g. 8, 11, 17, 21).
    pub major_version: u16,
}

/// Detects all Java installations on the system.
///
/// Checks `JAVA_HOME`, PATH lookup for `java`/`javaw`, scans well-known
/// install directories per platform, and optionally scans `<server_path>/jdk/`
/// for plugin-downloaded JDKs.
#[tauri::command]
pub async fn detect_java(server_path: Option<String>) -> Vec<JavaInstall> {
    tauri::async_runtime::spawn_blocking(move || detect_java_blocking(server_path))
        .await
        .unwrap_or_default()
}

fn detect_java_blocking(server_path: Option<String>) -> Vec<JavaInstall> {
    let mut found: Vec<JavaInstall> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for candidate in candidates() {
        if !candidate.exists() {
            continue;
        }
        let path = candidate.to_string_lossy().to_string();
        if seen.contains(&path) {
            continue;
        }
        seen.insert(path.clone());

        if let Some(info) = check_java_version_inner(&candidate) {
            found.push(info);
        }
    }

    // Also scan the server's jdk/ directory for plugin-downloaded JDKs.
    if let Some(sp) = &server_path {
        let jdk_dir = std::path::Path::new(sp).join("jdk");
        if jdk_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&jdk_dir) {
                for entry in entries.flatten() {
                    let java_bin = if cfg!(target_os = "windows") {
                        entry.path().join("bin").join("java.exe")
                    } else {
                        entry.path().join("bin").join("java")
                    };
                    let path = java_bin.to_string_lossy().to_string();
                    if seen.contains(&path) {
                        continue;
                    }
                    if java_bin.is_file() {
                        seen.insert(path);
                        if let Some(info) = check_java_version_inner(&java_bin) {
                            found.push(info);
                        }
                    }
                }
            }
        }
    }

    // Sort: higher major version first, then by version string.
    found.sort_by(|a, b| {
        b.major_version
            .cmp(&a.major_version)
            .then_with(|| b.version.cmp(&a.version))
    });
    found
}

/// Checks the Java version at a given path.
#[tauri::command]
pub async fn check_java_version(path: String) -> Option<JavaInstall> {
    tauri::async_runtime::spawn_blocking(move || {
        check_java_version_inner(std::path::Path::new(&path))
    })
    .await
    .ok()
    .flatten()
}

/// Inner implementation — runs `<java> -version` and parses the output.
fn check_java_version_inner(java_path: &std::path::Path) -> Option<JavaInstall> {
    let mut cmd = crate::process::silent_command(java_path);
    cmd.arg("-version");
    let output = cmd.output().ok()?;

    // `java -version` writes its output to stderr.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let version_line = stderr.lines().next()?;

    // Parse the version string. Expected format:
    //   openjdk version "1.8.0_392"  or  openjdk version "21.0.2" 2024-01-16
    // We extract whatever is between the quotes after "version".
    let version = version_line
        .split('"')
        .nth(1)?
        .to_string();

    let major_version = parse_major_version(&version);

    Some(JavaInstall {
        path: java_path.to_string_lossy().to_string(),
        version,
        major_version,
    })
}

/// Extracts the major version number from a Java version string.
///
/// - "1.8.0_392" → 8
/// - "11.0.21"   → 11
/// - "17.0.9"    → 17
/// - "21.0.2"    → 21
fn parse_major_version(version: &str) -> u16 {
    if let Some(v) = version.strip_prefix("1.") {
        // Java 8 and earlier: "1.x.y_z" → x is the major version
        if let Some(dot) = v.find('.') {
            v[..dot].parse().unwrap_or(0)
        } else {
            v.parse().unwrap_or(0)
        }
    } else if let Some(dot) = version.find('.') {
        // Java 9+: "x.y.z" → x is the major version
        version[..dot].parse().unwrap_or(0)
    } else {
        version.parse().unwrap_or(0)
    }
}

/// Generates a list of candidate java executable paths to check.
fn candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();

    // 1. JAVA_HOME
    if let Ok(jh) = std::env::var("JAVA_HOME") {
        let p = PathBuf::from(&jh);
        // Try java (Unix) and javaw.exe (Windows)
        list.push(p.join("bin").join("java"));
        list.push(p.join("bin").join("javaw.exe"));
        list.push(p.join("bin").join("java.exe"));
    }

    // 2. PATH lookup for "java" and "javaw"
    if let Some(p) = which("java") {
        list.push(p);
    }
    if let Some(p) = which("java.exe") {
        list.push(p);
    }
    if let Some(p) = which("javaw") {
        list.push(p);
    }
    if let Some(p) = which("javaw.exe") {
        list.push(p);
    }

    // 3. Platform-specific common install directories
    #[cfg(target_os = "windows")]
    {
        // Common JDK/JRE install roots on Windows
        let roots = [
            r"C:\Program Files\Java",
            r"C:\Program Files (x86)\Java",
            r"C:\Program Files\Eclipse Adoptium",
            r"C:\Program Files\Microsoft",
            r"C:\Program Files\Amazon Corretto",
            r"C:\Program Files\GraalVM",
        ];
        for root in roots {
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    for exe in ["java.exe", "javaw.exe"] {
                        let p = bin.join(exe);
                        if p.exists() {
                            list.push(p);
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let roots = [
            "/usr/lib/jvm",
            "/usr/lib/jvm/java-11-openjdk",
            "/usr/lib/jvm/java-17-openjdk",
            "/usr/lib/jvm/java-21-openjdk",
            "/usr/lib/jvm/java-8-openjdk",
        ];
        for root in &roots {
            let p = PathBuf::from(root).join("bin").join("java");
            if p.exists() {
                list.push(p);
            }
        }
        // Dynamic scan of /usr/lib/jvm subdirectories
        if let Ok(entries) = std::fs::read_dir("/usr/lib/jvm") {
            for entry in entries.flatten() {
                let p = entry.path().join("bin").join("java");
                if p.exists() {
                    list.push(p);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = std::fs::read_dir("/Library/Java/JavaVirtualMachines") {
            for entry in entries.flatten() {
                let p = entry
                    .path()
                    .join("Contents")
                    .join("Home")
                    .join("bin")
                    .join("java");
                if p.exists() {
                    list.push(p);
                }
            }
        }
    }

    list
}

/// Simple PATH lookup — returns the first matching executable.
fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
//  download_java — fetch + extract a Temurin JDK into the instance sandbox
// ---------------------------------------------------------------------------

/// Selects the Adoptium OS identifier for the current platform.
#[cfg(target_os = "windows")]
fn adoptium_os() -> &'static str {
    "windows"
}
#[cfg(target_os = "linux")]
fn adoptium_os() -> &'static str {
    "linux"
}
#[cfg(target_os = "macos")]
fn adoptium_os() -> &'static str {
    "macos"
}

/// Progress payload emitted on `download:{progress_id}:progress` while the JDK
/// archive downloads. Mirrors the shape download.rs emits so the frontend can
/// reuse the same progress UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JavaDownloadProgress {
    bytes: u64,
    total: u64,
}

/// Downloads a Temurin JDK of the given major version and extracts it into
/// `dest_dir`. Returns a `JavaInstall` describing the extracted JDK (path
/// points at the `bin/java` executable inside the sandbox).
///
/// Flow:
/// 1. Query the Adoptium v3 API for the latest JDK archive of `major`.
/// 2. Stream the archive to a temp file, emitting progress events.
/// 3. Extract (.zip on Windows, .tar.gz on Linux/macOS) into `dest_dir`.
/// 4. Locate the extracted `bin/java` and return its `JavaInstall`.
///
/// `progress_id` is caller-chosen so concurrent downloads don't collide.
#[tauri::command]
pub async fn download_java(
    app_handle: AppHandle,
    major: u16,
    dest_dir: String,
    progress_id: String,
) -> Result<JavaInstall, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_java_blocking(app_handle, major, dest_dir, progress_id)
    })
    .await
    .map_err(|e| format!("java download task failed: {e}"))?
}

fn download_java_blocking(
    app_handle: AppHandle,
    major: u16,
    dest_dir: String,
    progress_id: String,
) -> Result<JavaInstall, String> {
    let os = adoptium_os();

    // 1. Resolve the download URL from the Adoptium API.
    let api_url = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?image_type=jdk&architecture=x64&os={os}"
    );
    let mut releases: Vec<serde_json::Value> = ureq::get(&api_url)
        .call()
        .map_err(|e| format!("Adoptium API request failed: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("failed to parse Adoptium response: {e}"))?;

    // Prefer an LTS build when one is available; otherwise take the first entry.
    releases.sort_by_key(|r| {
        r["version"]["optional"].as_str().unwrap_or("") == "LTS"
    });
    let release = releases
        .last()
        .ok_or_else(|| format!("no JDK {major} build found on Adoptium"))?;

    let package = release
        .pointer("/binary/package")
        .ok_or_else(|| format!("Adoptium response missing binary.package for JDK {major}"))?;
    let download_link = package["link"]
        .as_str()
        .ok_or_else(|| format!("Adoptium response missing download link for JDK {major}"))?;
    let archive_name = package["name"]
        .as_str()
        .ok_or_else(|| format!("Adoptium response missing package name for JDK {major}"))?;
    let expected_checksum = package["checksum"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let expected_size = package["size"].as_u64().unwrap_or(0);

    // 2. Download the archive to a temp file next to the destination.
    let dest_path = PathBuf::from(&dest_dir);
    crate::download::ensure_dest_allowed(&app_handle, &dest_path)?;
    std::fs::create_dir_all(&dest_path)
        .map_err(|e| format!("failed to create JDK dir '{}': {e}", dest_path.display()))?;

    let archive_path = dest_path.join(archive_name);
    let event_name = format!("download:{progress_id}:progress");
    {
        let resp = ureq::get(download_link)
            .config()
            .timeout_global(Some(JDK_DOWNLOAD_TIMEOUT))
            .build()
            .call()
            .map_err(|e| format!("JDK download request failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {} for JDK download", status.as_u16()));
        }
        let total: u64 = resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        if total > MAX_JDK_ARCHIVE_BYTES || expected_size > MAX_JDK_ARCHIVE_BYTES {
            return Err(format!(
                "JDK archive is too large ({expected_size} bytes) — refusing to download"
            ));
        }

        let mut reader = std::io::BufReader::new(resp.into_body().into_reader());
        let mut file = std::fs::File::create(&archive_path)
            .map_err(|e| format!("failed to create archive '{}': {e}", archive_path.display()))?;
        let mut buf = vec![0u8; 65_536];
        let mut bytes: u64 = 0;
        let mut hasher = Sha256::new();
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    bytes += n as u64;
                    if bytes > MAX_JDK_ARCHIVE_BYTES {
                        drop(file);
                        let _ = std::fs::remove_file(&archive_path);
                        return Err("JDK archive exceeded the size limit — aborted".to_string());
                    }
                    hasher.update(&buf[..n]);
                    use std::io::Write;
                    file.write_all(&buf[..n])
                        .map_err(|e| format!("write error: {e}"))?;
                    let _ = app_handle.emit(&event_name, JavaDownloadProgress { bytes, total });
                }
                Err(e) => {
                    drop(file);
                    let _ = std::fs::remove_file(&archive_path);
                    return Err(format!("read error from JDK download: {e}"));
                }
            }
        }
        let _ = app_handle.emit(&event_name, JavaDownloadProgress { bytes, total });

        // Integrity: verify the Adoptium-advertised SHA-256 before executing
        // anything from the archive.
        if let Some(expected) = &expected_checksum {
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(expected) {
                drop(file);
                let _ = std::fs::remove_file(&archive_path);
                return Err(format!(
                    "checksum mismatch for JDK {major} (expected {expected}, got {actual}) — refusing to extract"
                ));
            }
        }
    }

    // 3. Extract the archive.
    if archive_name.ends_with(".zip") {
        extract_zip(&archive_path, &dest_path)?;
    } else if archive_name.ends_with(".tar.gz") || archive_name.ends_with(".tgz") {
        extract_tar_gz(&archive_path, &dest_path)?;
    } else {
        return Err(format!("unsupported JDK archive format: {archive_name}"));
    }

    // Best-effort cleanup of the archive now that it's extracted.
    let _ = std::fs::remove_file(&archive_path);

    // 4. Locate the extracted JDK's bin/java. The archive unpacks into a single
    //    top-level directory (e.g. "jdk-25.0.3+9"); find it, then bin/java.
    let java_bin = find_java_binary(&dest_path)?;

    check_java_version_inner(&java_bin).ok_or_else(|| {
        format!(
            "extracted JDK at '{}' did not report a valid version",
            java_bin.display()
        )
    })
}

/// Extracts a .zip archive into `dest`, mirroring download.rs's chunked style.
fn extract_zip(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("failed to open zip '{}': {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("failed to read zip '{}': {e}", archive.display()))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("zip entry {i} error: {e}"))?;
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("failed to create dir '{}': {e}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create dir '{}': {e}", parent.display()))?;
            }
            let mut out = std::fs::File::create(&out_path)
                .map_err(|e| format!("failed to create '{}': {e}", out_path.display()))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("failed to write '{}': {e}", out_path.display()))?;
        }
    }
    Ok(())
}

/// Extracts a .tar.gz archive into `dest`.
fn extract_tar_gz(archive: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("failed to open tar.gz '{}': {e}", archive.display()))?;
    let decoded = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoded);
    tar.unpack(dest)
        .map_err(|e| format!("failed to extract tar.gz '{}': {e}", archive.display()))?;
    Ok(())
}

/// Finds the `bin/java` (or `bin/java.exe`) executable under `jdk_root`,
/// walking one level into the archive's top-level directory if needed.
fn find_java_binary(jdk_root: &std::path::Path) -> Result<PathBuf, String> {
    let exe_name = if cfg!(target_os = "windows") {
        "java.exe"
    } else {
        "java"
    };

    // Direct: <root>/bin/java
    let direct = jdk_root.join("bin").join(exe_name);
    if direct.is_file() {
        return Ok(direct);
    }

    // Nested: <root>/<jdk-25.0.3+9>/bin/java  (archive unpacks one level deep).
    if let Ok(entries) = std::fs::read_dir(jdk_root) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("bin").join(exe_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "could not find bin/{} under '{}'",
        exe_name,
        jdk_root.display()
    ))
}
