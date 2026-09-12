//! Build script for the standalone installer.
//!
//! Embeds the built kern application as `payload.zip` in OUT_DIR, so the
//! installer is a single self-contained `.exe`.
//!
//! Payload resolution:
//!   1. `KERN_PAYLOAD_EXE` env var (absolute path to the built `kern.exe`), or
//!   2. `<repo>/src-tauri/target/release/kern.exe` (default for release builds).
//!
//! When the payload is missing the build still succeeds (so `cargo check` and
//! CI compile the installer without a full app build) but the runtime refuses
//! to install and says why. `scripts/build-installer.mjs` always builds the app
//! first and fails early if the payload is absent.

use std::io::Write;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let payload_path = out_dir.join("payload.zip");

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let payload_exe = std::env::var("KERN_PAYLOAD_EXE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("..").join("src-tauri").join("target").join("release").join("kern.exe"));

    // App version (from package.json) for the uninstall registry entry.
    let version = std::fs::read_to_string(manifest_dir.join("..").join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|json| json.get("version").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rustc-env=KERN_VERSION={version}");

    let present = payload_exe.is_file();
    println!("cargo:rustc-env=KERN_PAYLOAD_PRESENT={}", if present { "1" } else { "0" });
    println!("cargo:rerun-if-env-changed=KERN_PAYLOAD_EXE");
    println!("cargo:rerun-if-changed=build.rs");
    if present {
        println!("cargo:rerun-if-changed={}", payload_exe.display());
    }

    let file = std::fs::File::create(&payload_path).expect("create payload.zip");
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    if present {
        let name = payload_exe
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("kern.exe");
        zip.start_file(name, options).expect("zip start file");
        let bytes = std::fs::read(&payload_exe).expect("read payload exe");
        zip.write_all(&bytes).expect("write payload exe");

        // Ship the CLI next to the app when it was built (same directory as
        // the payload); `cargo build` produces it alongside kern.exe.
        let cli_exe = payload_exe
            .parent()
            .map(|dir| dir.join("kern-cli.exe"))
            .unwrap_or_default();
        if cli_exe.is_file() {
            println!("cargo:rerun-if-changed={}", cli_exe.display());
            let cli_name = cli_exe
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("kern-cli.exe");
            zip.start_file(cli_name, options).expect("zip start cli");
            let bytes = std::fs::read(&cli_exe).expect("read cli exe");
            zip.write_all(&bytes).expect("write cli exe");
        } else {
            println!(
                "cargo:warning=kern-cli.exe not found next to the payload — installer will ship without the CLI"
            );
        }
    } else {
        println!(
            "cargo:warning=kern installer built WITHOUT a payload ({} not found) — set KERN_PAYLOAD_EXE or build the app first",
            payload_exe.display()
        );
    }

    zip.finish().expect("finish payload.zip");
}
