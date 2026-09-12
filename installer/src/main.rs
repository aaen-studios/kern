//! Standalone Windows installer for kern.
//!
//! A self-contained `.exe` that installs the application embedded at build
//! time (`payload.zip`), creates shortcuts, registers an uninstaller, and
//! registers the per-user `.kern` file association + `kern://` URL protocol.
//! It also handles the flags the in-app updater uses (`/P` passive, `/R`
//! restart).
//!
//! CLI:
//!   (none)                 GUI install
//!   /S                     silent install (no UI)
//!   /P                     passive install (progress UI, no inputs)
//!   /R                     relaunch kern when the install finishes
//!   /D=<dir>               install to <dir> (default %LOCALAPPDATA%\kern)
//!   /uninstall             remove kern (shortcuts, registry, files)
//!   /uninstall-run <dir>   internal: cleanup worker
//!   /extract <dir>         internal/diagnostic: extract payload only
//!   /demo                  dev aid: play the install UI without touching disk
//!
//! Updater compatibility: the Tauri updater launches the downloaded installer
//! with `/P /R /UPDATE /ARGS <original app args…>`. `/UPDATE` is accepted and
//! ignored, and the args after `/ARGS` are forwarded to the relaunched app.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("kern-setup is a Windows-only installer");
    std::process::exit(1);
}

#[cfg(windows)]
mod win {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    #[cfg(test)]
    use std::io::Write;

    use serde::Serialize;
    use tauri::{AppHandle, Emitter, Manager};

    /// The embedded application archive (created by `build.rs`).
    const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.zip"));
    const PAYLOAD_PRESENT: bool = env!("KERN_PAYLOAD_PRESENT").as_bytes()[0] == b'1';
    const VERSION: &str = env!("KERN_VERSION");

    const APP_EXE: &str = "kern.exe";
    const UNINSTALLER_EXE: &str = "uninstall.exe";
    const REG_UNINSTALL_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\kern";
    /// WebView2 Evergreen runtime client id (per-machine + per-user).
    const WEBVIEW2_CLIENT: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const WEBVIEW2_DOWNLOAD: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    /// Per-user `.kern` file association + `kern://` URL protocol.
    const CLASSES_ROOT: &str = r"Software\Classes";
    const KERN_PROG_ID: &str = "kern.PluginPackage";
    const URL_PROTOCOL: &str = "kern";

    #[derive(Default, Clone)]
    struct Cli {
        silent: bool,
        passive: bool,
        restart: bool,
        uninstall: bool,
        demo: bool,
        dir: Option<PathBuf>,
        uninstall_run: Option<PathBuf>,
        extract_only: Option<PathBuf>,
        /// Arguments after `/ARGS` (the updater's original app arguments),
        /// forwarded to the relaunched app.
        forward_args: Vec<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InstallerInfo {
        version: String,
        default_dir: String,
        payload_present: bool,
        passive: bool,
        demo: bool,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Progress {
        stage: Option<u32>,
        total: u32,
        message: String,
        detail: Option<String>,
        percent: Option<u8>,
        done: bool,
        error: bool,
    }

    pub fn main() {
        let mut cli = parse_cli();
        // Follow the original install location on updates/re-installs unless
        // the caller picked one explicitly (`/D=`).
        if cli.dir.is_none() {
            cli.dir = recorded_install_dir();
        }

        if let Some(dir) = cli.uninstall_run.clone() {
            std::process::exit(run_uninstall_cleanup(&dir));
        }
        if let Some(dir) = cli.extract_only.clone() {
            std::process::exit(match extract_payload(&dir, None) {
                Ok(n) => {
                    println!("extracted {n} file(s) to {}", dir.display());
                    0
                }
                Err(e) => {
                    eprintln!("extract failed: {e}");
                    1
                }
            });
        }
        if cli.uninstall {
            std::process::exit(run_uninstall(&cli));
        }
        if cli.silent {
            let dir = cli.dir.clone().unwrap_or_else(default_install_dir);
            let code = match install(&NullProgress, &dir, false, cli.restart, &cli.forward_args) {
                Ok(_) => 0,
                Err(e) => {
                    eprintln!("install failed: {e}");
                    1
                }
            };
            std::process::exit(code);
        }

        // GUI path needs the WebView2 runtime.
        if !webview2_present() {
            show_webview2_prompt();
            return;
        }

        tauri::Builder::default()
            .manage(cli)
            .invoke_handler(tauri::generate_handler![installer_info, start_install])
            .run(tauri::generate_context!())
            .expect("error while running kern installer");
    }

    fn parse_cli() -> Cli {
        parse_args(&std::env::args().collect::<Vec<_>>())
    }

    fn parse_args(args: &[String]) -> Cli {
        let mut cli = Cli {
            silent: args.iter().any(|a| a.eq_ignore_ascii_case("/S") || a == "--silent"),
            passive: args.iter().any(|a| a.eq_ignore_ascii_case("/P") || a == "--passive"),
            restart: args.iter().any(|a| a.eq_ignore_ascii_case("/R") || a == "--restart"),
            uninstall: args.iter().any(|a| a.eq_ignore_ascii_case("/uninstall") || a == "--uninstall"),
            demo: args.iter().any(|a| a.eq_ignore_ascii_case("/demo") || a == "--demo"),
            ..Default::default()
        };
        for (i, a) in args.iter().enumerate() {
            if let Some(v) = a.strip_prefix("/D=") {
                if !v.is_empty() {
                    cli.dir = Some(PathBuf::from(v));
                }
            }
            if a.eq_ignore_ascii_case("/uninstall-run") {
                cli.uninstall_run = args.get(i + 1).map(PathBuf::from);
            }
            if a.eq_ignore_ascii_case("/extract") {
                cli.extract_only = args.get(i + 1).map(PathBuf::from);
            }
            // Everything after `/ARGS` is the original app command line
            // (the updater's relaunch contract). `/UPDATE` is ignored.
            if a.eq_ignore_ascii_case("/ARGS") {
                cli.forward_args = args[i + 1..].to_vec();
                break;
            }
        }
        cli
    }

    // ── Progress ─────────────────────────────────────────────────────────

    /// Progress sink: emits to the GUI, or prints when there's no window.
    trait ProgressSink {
        fn stage(&self, stage: u32, total: u32, message: &str);
        fn detail(&self, text: &str);
        fn done(&self, message: &str);
        fn fail(&self, message: &str);
    }

    struct NullProgress;

    impl ProgressSink for NullProgress {
        fn stage(&self, stage: u32, total: u32, message: &str) {
            println!("[{stage}/{total}] {message}");
        }
        fn detail(&self, text: &str) {
            println!("        {text}");
        }
        fn done(&self, message: &str) {
            println!("✓ {message}");
        }
        fn fail(&self, message: &str) {
            eprintln!("✕ {message}");
        }
    }

    fn percent_for(stage: u32, total: u32) -> u8 {
        if total == 0 {
            return 0;
        }
        (((stage.saturating_sub(1)) * 100) / total).min(100) as u8
    }

    impl ProgressSink for AppHandle {
        fn stage(&self, stage: u32, total: u32, message: &str) {
            let _ = self.emit(
                "installer://progress",
                Progress {
                    stage: Some(stage),
                    total,
                    message: message.to_string(),
                    detail: None,
                    percent: Some(percent_for(stage, total)),
                    done: false,
                    error: false,
                },
            );
        }
        fn detail(&self, text: &str) {
            let _ = self.emit(
                "installer://progress",
                Progress {
                    stage: None,
                    total: 0,
                    message: String::new(),
                    detail: Some(text.to_string()),
                    percent: None,
                    done: false,
                    error: false,
                },
            );
        }
        fn done(&self, message: &str) {
            let _ = self.emit(
                "installer://progress",
                Progress {
                    stage: None,
                    total: 0,
                    message: message.to_string(),
                    detail: None,
                    percent: Some(100),
                    done: true,
                    error: false,
                },
            );
        }
        fn fail(&self, message: &str) {
            let _ = self.emit(
                "installer://progress",
                Progress {
                    stage: None,
                    total: 0,
                    message: message.to_string(),
                    detail: None,
                    percent: Some(100),
                    done: true,
                    error: true,
                },
            );
        }
    }

    // ── Tauri commands ───────────────────────────────────────────────────

    #[tauri::command]
    fn installer_info(state: tauri::State<'_, Cli>) -> InstallerInfo {
        InstallerInfo {
            version: VERSION.to_string(),
            default_dir: state
                .dir
                .clone()
                .unwrap_or_else(default_install_dir)
                .to_string_lossy()
                .to_string(),
            payload_present: PAYLOAD_PRESENT,
            passive: state.passive,
            demo: state.demo,
        }
    }

    #[tauri::command]
    async fn start_install(
        app: AppHandle,
        install_dir: Option<String>,
        desktop_shortcut: bool,
        launch_after: bool,
    ) -> Result<String, String> {
        let state: tauri::State<'_, Cli> = app.state();
        let restart = state.restart;
        let forward_args = state.forward_args.clone();
        let dir = install_dir
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_install_dir);

        let app_for_task = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            install(
                &app_for_task,
                &dir,
                desktop_shortcut,
                launch_after || restart,
                &forward_args,
            )
        })
        .await
        .map_err(|e| format!("install task failed: {e}"))?;

        match &result {
            Ok(message) => app.done(message),
            Err(e) => app.fail(e),
        }
        result
    }

    // ── Install ──────────────────────────────────────────────────────────

    fn install(
        progress: &dyn ProgressSink,
        dir: &Path,
        desktop_shortcut: bool,
        launch_after: bool,
        forward_args: &[String],
    ) -> Result<String, String> {
        if !PAYLOAD_PRESENT {
            return Err(
                "this installer was built without an application payload — rebuild it with \
                 scripts/build-installer.mjs"
                    .to_string(),
            );
        }
        validate_install_dir(dir)?;

        let total: u32 = if launch_after { 5 } else { 4 };
        let upgrading = dir.join(APP_EXE).exists();

        progress.stage(
            1,
            total,
            if upgrading { "closing running instances" } else { "preparing" },
        );
        if upgrading {
            progress.detail("stopping kern.exe");
            stop_running_app();
        } else {
            progress.detail("no existing install in this location");
        }

        progress.stage(2, total, "installing files");
        progress.detail(&format!("creating {}", dir.display()));
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create '{}': {e}", dir.display()))?;
        let files = extract_payload(dir, Some(progress))?;

        progress.stage(3, total, "creating shortcuts");
        if let Err(e) = create_shortcuts(dir, desktop_shortcut, progress) {
            // Shortcut failures shouldn't abort an otherwise-good install.
            progress.detail(&format!("shortcut warning: {e}"));
        }

        progress.stage(4, total, "registering uninstaller");
        progress.detail("writing uninstall entry");
        let uninstaller = dir.join(UNINSTALLER_EXE);
        let current = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
        if current != uninstaller {
            std::fs::copy(&current, &uninstaller)
                .map_err(|e| format!("cannot install uninstaller: {e}"))?;
        }
        write_uninstall_registry(dir, &uninstaller)?;

        progress.detail("registering .kern and kern:// handlers");
        if let Err(e) = register_file_associations(CLASSES_ROOT, &dir.join(APP_EXE)) {
            // Association failures shouldn't abort an otherwise-good install.
            progress.detail(&format!("association warning: {e}"));
        } else {
            notify_shell_assoc_changed();
        }

        let message = format!(
            "kern v{VERSION} installed to {} ({files} file{}).",
            dir.display(),
            if files == 1 { "" } else { "s" }
        );

        if launch_after {
            progress.stage(5, total, "launching kern");
            let app = dir.join(APP_EXE);
            progress.detail(&format!("starting {}", app.display()));
            let mut cmd = silent_command(&app);
            cmd.current_dir(dir);
            // Force the window visible: without this a remembered "hidden to
            // tray" state makes a finished install look like nothing happened.
            cmd.arg("--show");
            if !forward_args.is_empty() {
                progress.detail(&format!(
                    "forwarding {} original argument(s)",
                    forward_args.len()
                ));
                cmd.args(forward_args);
            }
            // Don't inherit console handles: a GUI child holding them keeps
            // the parent's output pipes open.
            cmd.stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            match cmd.spawn() {
                Ok(mut child) => {
                    // If kern exits immediately, another instance almost
                    // certainly swallowed the launch via single-instance
                    // forwarding — surface that instead of failing silently.
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    match child.try_wait() {
                        Ok(Some(_)) => progress.detail(
                            "kern exited immediately — another instance may already be running",
                        ),
                        Ok(None) => progress.detail("kern is running"),
                        Err(_) => {}
                    }
                }
                Err(e) => progress.detail(&format!("could not start kern: {e}")),
            }
        }

        progress.done(&message);
        Ok(message)
    }

    /// Kills a running kern.exe so its files can be replaced. The manager's
    /// identity-verified pid persistence re-adopts any servers on next launch.
    fn stop_running_app() {
        let mut cmd = silent_command("taskkill");
        cmd.args(["/F", "/IM", APP_EXE]);
        let _ = cmd.status();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    /// Extracts the embedded payload zip into `dir` (zip-slip guarded).
    fn extract_payload(
        dir: &Path,
        progress: Option<&dyn ProgressSink>,
    ) -> Result<usize, String> {
        let cursor = std::io::Cursor::new(PAYLOAD);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| format!("invalid payload: {e}"))?;
        let mut count = 0usize;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("payload entry {i}: {e}"))?;
            let Some(rel) = entry.enclosed_name() else {
                return Err(format!("payload entry '{}' escapes the install dir", entry.name()));
            };
            let out = dir.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)
                    .map_err(|e| format!("cannot create '{}': {e}", out.display()))?;
            } else {
                if let Some(p) = progress {
                    p.detail(&format!("extracting {}", entry.name()));
                }
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("cannot create '{}': {e}", parent.display()))?;
                }
                let mut file = std::fs::File::create(&out)
                    .map_err(|e| format!("cannot write '{}': {e}", out.display()))?;
                std::io::copy(&mut entry, &mut file)
                    .map_err(|e| format!("cannot write '{}': {e}", out.display()))?;
                count += 1;
            }
        }
        Ok(count)
    }

    // ── Shortcuts ────────────────────────────────────────────────────────

    fn create_shortcuts(
        dir: &Path,
        desktop_shortcut: bool,
        progress: &dyn ProgressSink,
    ) -> Result<(), String> {
        let target = dir.join(APP_EXE);
        let programs = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join(r"Microsoft\Windows\Start Menu\Programs"))
            .unwrap_or_else(|| dir.to_path_buf());

        let mut links = vec![programs.join("kern.lnk")];
        if desktop_shortcut {
            if let Some(desktop) = dirs::desktop_dir() {
                links.push(desktop.join("kern.lnk"));
            }
        }

        for link in links {
            progress.detail(&format!("linking {}", link.display()));
            create_shortcut(&link, &target, dir)?;
        }
        Ok(())
    }

    fn create_shortcut(link: &Path, target: &Path, workdir: &Path) -> Result<(), String> {
        let script = format!(
            "$s=(New-Object -ComObject WScript.Shell);$l=$s.CreateShortcut('{}');$l.TargetPath='{}';$l.WorkingDirectory='{}';$l.IconLocation='{},0';$l.Description='kern server manager';$l.Save()",
            ps_escape(&link.to_string_lossy()),
            ps_escape(&target.to_string_lossy()),
            ps_escape(&workdir.to_string_lossy()),
            ps_escape(&target.to_string_lossy()),
        );
        let mut cmd = silent_command("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        let status = cmd.status().map_err(|e| format!("shortcut command failed: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("could not create '{}'", link.display()))
        }
    }

    /// Escapes a value for a single-quoted PowerShell string literal.
    fn ps_escape(value: &str) -> String {
        value.replace('\'', "''")
    }

    fn remove_shortcuts() {
        let mut links: Vec<PathBuf> = Vec::new();
        if let Some(appdata) = std::env::var_os("APPDATA") {
            links.push(
                PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\kern.lnk"),
            );
        }
        if let Some(desktop) = dirs::desktop_dir() {
            links.push(desktop.join("kern.lnk"));
        }
        for link in links {
            let _ = std::fs::remove_file(link);
        }
    }

    // ── Registry ─────────────────────────────────────────────────────────

    fn write_uninstall_registry(dir: &Path, uninstaller: &Path) -> Result<(), String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(REG_UNINSTALL_KEY)
            .map_err(|e| format!("cannot write uninstall registry key: {e}"))?;

        let app = dir.join(APP_EXE);
        let size_kb = directory_size_kb(dir);
        let reg_err = |e: std::io::Error| format!("registry write failed: {e}");

        key.set_value("DisplayName", &"kern").map_err(reg_err)?;
        key.set_value("DisplayVersion", &VERSION).map_err(reg_err)?;
        key.set_value("Publisher", &"kern").map_err(reg_err)?;
        key.set_value("DisplayIcon", &format!("{},0", app.display())).map_err(reg_err)?;
        key.set_value("InstallLocation", &dir.to_string_lossy().to_string()).map_err(reg_err)?;
        key.set_value("UninstallString", &format!("\"{}\" /uninstall", uninstaller.display()))
            .map_err(reg_err)?;
        key.set_value(
            "QuietUninstallString",
            &format!("\"{}\" /uninstall /S", uninstaller.display()),
        )
        .map_err(reg_err)?;
        key.set_value("NoModify", &1u32).map_err(reg_err)?;
        key.set_value("NoRepair", &1u32).map_err(reg_err)?;
        key.set_value("EstimatedSize", &size_kb).map_err(reg_err)?;
        Ok(())
    }

    fn remove_registry() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(REG_UNINSTALL_KEY);
        unregister_file_associations(CLASSES_ROOT);
        notify_shell_assoc_changed();
    }

    /// Registers the per-user `.kern` file association and `kern://` URL
    /// protocol. `classes_root` is a parameter (rather than the constant used
    /// in production) so tests can register into a scratch tree.
    fn register_file_associations(classes_root: &str, exe: &Path) -> Result<(), String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let reg_err = |e: std::io::Error| format!("association registry write failed: {e}");
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe_icon = format!("\"{}\",0", exe.display());
        let open_cmd = format!("\"{}\" \"%1\"", exe.display());

        let (ext, _) = hkcu
            .create_subkey(format!(r"{classes_root}\.kern"))
            .map_err(|e| format!("create .kern key: {e}"))?;
        ext.set_value("", &KERN_PROG_ID).map_err(reg_err)?;

        let (prog, _) = hkcu
            .create_subkey(format!(r"{classes_root}\{KERN_PROG_ID}"))
            .map_err(|e| format!("create ProgID key: {e}"))?;
        prog.set_value("", &"kern plugin package").map_err(reg_err)?;
        prog.set_value("FriendlyTypeName", &"kern plugin package").map_err(reg_err)?;
        let (icon, _) = prog
            .create_subkey("DefaultIcon")
            .map_err(|e| format!("create DefaultIcon key: {e}"))?;
        icon.set_value("", &exe_icon).map_err(reg_err)?;
        let (open, _) = prog
            .create_subkey(r"shell\open\command")
            .map_err(|e| format!("create open command key: {e}"))?;
        open.set_value("", &open_cmd).map_err(reg_err)?;

        let (proto, _) = hkcu
            .create_subkey(format!(r"{classes_root}\{URL_PROTOCOL}"))
            .map_err(|e| format!("create URL protocol key: {e}"))?;
        proto.set_value("", &"URL:kern Protocol").map_err(reg_err)?;
        proto.set_value("URL Protocol", &"").map_err(reg_err)?;
        let (popen, _) = proto
            .create_subkey(r"shell\open\command")
            .map_err(|e| format!("create protocol open command key: {e}"))?;
        popen.set_value("", &open_cmd).map_err(reg_err)?;
        Ok(())
    }

    /// Removes the keys written by [`register_file_associations`]. Missing keys
    /// are fine (fresh machine, previous uninstall, partial install).
    fn unregister_file_associations(classes_root: &str) {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(classes) = hkcu.open_subkey_with_flags(classes_root, KEY_ALL_ACCESS) {
            for sub in [".kern", KERN_PROG_ID, URL_PROTOCOL] {
                let _ = classes.delete_subkey_all(sub);
            }
        }
    }

    /// Tells Explorer the association table changed so icons and handlers
    /// refresh immediately instead of at the next sign-in.
    fn notify_shell_assoc_changed() {
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        unsafe {
            SHChangeNotify(
                SHCNE_ASSOCCHANGED as i32,
                SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
    }

    fn directory_size_kb(dir: &Path) -> u32 {
        fn walk(dir: &Path, total: &mut u64) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    walk(&entry.path(), total);
                } else {
                    *total += meta.len();
                }
            }
        }
        let mut total = 0u64;
        walk(dir, &mut total);
        (total / 1024) as u32
    }

    // ── Uninstall ────────────────────────────────────────────────────────

    /// True when `dir` actually holds a kern install. Uninstall derives the
    /// install directory from the running exe's parent, so this is the guard
    /// that stops a downloaded `kern-setup.exe /uninstall` from deleting
    /// whatever folder it happens to sit in (Downloads, Desktop, …).
    fn is_kern_install_dir(dir: &Path) -> bool {
        dir.join(APP_EXE).exists() || dir.join(UNINSTALLER_EXE).exists()
    }

    /// A destination is only acceptable when it's a real subdirectory and
    /// either empty, a kern install (upgrade/repair), or brand new. Uninstall
    /// deletes the whole directory, so adopting e.g. `Documents` would be
    /// destructive later.
    fn validate_install_dir(dir: &Path) -> Result<(), String> {
        if dir.parent().is_none() {
            return Err(format!(
                "refusing to install into '{}' — pick a subdirectory",
                dir.display()
            ));
        }
        if dir.exists() && !is_kern_install_dir(dir) {
            let has_entries = std::fs::read_dir(dir)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);
            if has_entries {
                return Err(format!(
                    "refusing to install into '{}' — the folder is not empty and is not an \
                     existing kern install",
                    dir.display()
                ));
            }
        }
        Ok(())
    }

    /// The directory a previous install recorded in the uninstall registry, so
    /// updates and re-installs land in the same place (custom `/D=` installs
    /// stay custom instead of forking into the default folder).
    fn recorded_install_dir() -> Option<PathBuf> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(REG_UNINSTALL_KEY)
            .ok()?;
        let location: String = key.get_value("InstallLocation").ok()?;
        if location.trim().is_empty() {
            None
        } else {
            Some(PathBuf::from(location))
        }
    }

    fn run_uninstall(_cli: &Cli) -> i32 {
        let Ok(current) = std::env::current_exe() else {
            return 1;
        };
        let Some(install_dir) = current.parent().map(Path::to_path_buf) else {
            return 1;
        };
        if !is_kern_install_dir(&install_dir) {
            eprintln!(
                "refusing to uninstall: '{}' does not look like a kern install \
                 (no {APP_EXE} or {UNINSTALLER_EXE} in it)",
                install_dir.display()
            );
            return 1;
        }

        remove_shortcuts();
        remove_registry();

        // The install dir contains this running exe, so hand cleanup to a
        // temporary copy that can delete everything (including us).
        let temp = std::env::temp_dir().join(format!("kern-uninstall-{}.exe", std::process::id()));
        if std::fs::copy(&current, &temp).is_err() {
            return 1;
        }
        let mut cmd = silent_command(&temp);
        cmd.arg("/uninstall-run").arg(&install_dir);
        match cmd.spawn() {
            Ok(_) => 0,
            Err(_) => 1,
        }
    }

    fn run_uninstall_cleanup(install_dir: &Path) -> i32 {
        // Give the launched uninstaller a moment to exit and release its file.
        std::thread::sleep(std::time::Duration::from_millis(700));
        // Re-check before deleting: the path crossed a process boundary and a
        // stray invocation must never wipe a non-install directory.
        if !is_kern_install_dir(install_dir) {
            eprintln!(
                "refusing to delete '{}': not a kern install directory",
                install_dir.display()
            );
            return 1;
        }
        // A running kern keeps kern.exe locked, which would leave a half-
        // deleted install. Servers are killed with the app by design.
        stop_running_app();
        let removed = remove_dir_all_lenient(install_dir);
        if let Ok(current) = std::env::current_exe() {
            schedule_self_delete(&current);
        }
        if removed {
            0
        } else {
            1
        }
    }

    /// Removes a directory, treating "already gone" as success and retrying
    /// once for transient locks (antivirus/indexers).
    fn remove_dir_all_lenient(dir: &Path) -> bool {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(800));
                match std::fs::remove_dir_all(dir) {
                    Ok(()) => true,
                    Err(e) => e.kind() == std::io::ErrorKind::NotFound,
                }
            }
        }
    }

    /// Schedules a file for deletion on next reboot (works for the running
    /// image).
    fn schedule_self_delete(path: &Path) {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        const MOVEFILE_DELAY_UNTIL_REBOOT: u32 = 0x4;

        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        unsafe {
            MoveFileExW(wide.as_ptr(), std::ptr::null(), MOVEFILE_DELAY_UNTIL_REBOOT);
        }
    }

    // ── Environment helpers ──────────────────────────────────────────────

    fn local_app_data() -> PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }

    fn default_install_dir() -> PathBuf {
        local_app_data().join("kern")
    }

    fn suppress_window(cmd: &mut Command) {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    /// Every subprocess this installer spawns must start from this constructor
    /// so a console window can never flash (enforced by
    /// `scripts/check-silent-spawns.mjs`).
    fn silent_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut cmd = Command::new(program); // silent-spawn-ok: constructor definition
        suppress_window(&mut cmd);
        cmd
    }

    #[cfg(windows)]
    fn webview2_present() -> bool {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;

        let machine = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(format!(
            r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"
        ));
        if let Ok(key) = machine {
            if key.get_value::<String, _>("pv").is_ok() {
                return true;
            }
        }
        let user = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!(r"Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"));
        if let Ok(key) = user {
            if key.get_value::<String, _>("pv").is_ok() {
                return true;
            }
        }
        false
    }

    fn show_webview2_prompt() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDOK, MB_ICONERROR, MB_OKCANCEL,
        };

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }

        let text = "kern needs the Microsoft Edge WebView2 runtime, which is missing on this \
                    machine.\n\nClick OK to open the download page, install it, then run this \
                    installer again.";
        let title = "kern setup";
        let result = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                wide(text).as_ptr(),
                wide(title).as_ptr(),
                MB_ICONERROR | MB_OKCANCEL,
            )
        };
        if result == IDOK {
            let mut cmd = silent_command("cmd");
            cmd.args(["/C", "start", "", WEBVIEW2_DOWNLOAD]);
            let _ = cmd.status();
        }
    }

    /// Builds an in-memory zip for tests.
    #[cfg(test)]
    fn test_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options: zip::write::FileOptions<()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, bytes) in entries {
                zip.start_file(*name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn extract(bytes: &[u8], dir: &Path) -> Result<usize, String> {
            let cursor = std::io::Cursor::new(bytes);
            let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
            let mut count = 0;
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                let Some(rel) = entry.enclosed_name() else {
                    return Err("escape".to_string());
                };
                let out = dir.join(rel);
                if !entry.is_dir() {
                    if let Some(parent) = out.parent() {
                        std::fs::create_dir_all(parent).unwrap();
                    }
                    let mut file = std::fs::File::create(&out).unwrap();
                    std::io::copy(&mut entry, &mut file).unwrap();
                    count += 1;
                }
            }
            Ok(count)
        }

        #[test]
        fn extracts_nested_payload() {
            let dir = tempfile::tempdir().unwrap();
            let bytes = test_zip(&[("kern.exe", b"MZ"), ("resources/x.txt", b"hi")]);
            let count = extract(&bytes, dir.path()).unwrap();
            assert_eq!(count, 2);
            assert!(dir.path().join("kern.exe").is_file());
            assert_eq!(
                std::fs::read_to_string(dir.path().join("resources/x.txt")).unwrap(),
                "hi"
            );
        }

        #[test]
        fn rejects_traversal_entries() {
            let dir = tempfile::tempdir().unwrap();
            let bytes = test_zip(&[("../evil.exe", b"MZ")]);
            assert!(extract(&bytes, dir.path()).is_err());
            assert!(!dir.path().join("..").join("evil.exe").exists());
        }

        #[test]
        fn parses_updater_invocation_and_forwards_app_args() {
            let args: Vec<String> = [
                "kern-setup.exe",
                "/P",
                "/R",
                "/UPDATE",
                "/ARGS",
                "--autostart",
                "--foo=bar",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            let cli = parse_args(&args);
            assert!(cli.passive);
            assert!(cli.restart);
            assert!(!cli.silent);
            assert!(!cli.uninstall);
            assert_eq!(cli.forward_args, vec!["--autostart", "--foo=bar"]);
        }

        #[test]
        fn parses_silent_install_with_custom_dir() {
            let args: Vec<String> = ["kern-setup.exe", "/S", "/D=C:\\kern test"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            let cli = parse_args(&args);
            assert!(cli.silent);
            assert!(!cli.restart);
            assert!(cli.forward_args.is_empty());
            assert_eq!(cli.dir, Some(PathBuf::from("C:\\kern test")));
        }

        #[test]
        fn parses_uninstall_and_diagnostics() {
            let args: Vec<String> = [
                "kern-setup.exe",
                "/uninstall",
                "/uninstall-run",
                "C:\\kern",
                "/extract",
                "C:\\tmp",
                "/demo",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            let cli = parse_args(&args);
            assert!(cli.uninstall);
            assert!(cli.demo);
            assert_eq!(cli.uninstall_run, Some(PathBuf::from("C:\\kern")));
            assert_eq!(cli.extract_only, Some(PathBuf::from("C:\\tmp")));
        }

        /// Uninstall must only ever touch a real install directory — a
        /// downloaded `kern-setup.exe /uninstall` sits in Downloads/Desktop.
        #[test]
        fn uninstall_guard_requires_install_markers() {
            let empty = tempfile::tempdir().unwrap();
            assert!(!is_kern_install_dir(empty.path()));

            let with_app = tempfile::tempdir().unwrap();
            std::fs::write(with_app.path().join(APP_EXE), b"MZ").unwrap();
            assert!(is_kern_install_dir(with_app.path()));

            let with_uninstaller = tempfile::tempdir().unwrap();
            std::fs::write(with_uninstaller.path().join(UNINSTALLER_EXE), b"MZ").unwrap();
            assert!(is_kern_install_dir(with_uninstaller.path()));
        }

        /// Install must never adopt an unrelated non-empty folder (uninstall
        /// deletes the directory) and must never target a drive root.
        #[test]
        fn install_dir_validation_rejects_dangerous_targets() {
            assert!(validate_install_dir(Path::new(r"C:\")).is_err());
            assert!(validate_install_dir(Path::new("")).is_err());

            let empty = tempfile::tempdir().unwrap();
            assert!(validate_install_dir(empty.path()).is_ok());

            let nested = empty.path().join("a").join("b");
            assert!(validate_install_dir(&nested).is_ok());

            let used = tempfile::tempdir().unwrap();
            std::fs::write(used.path().join("notes.txt"), b"hi").unwrap();
            assert!(validate_install_dir(used.path()).is_err());

            // An existing kern install is allowed (upgrade/repair).
            std::fs::write(used.path().join(APP_EXE), b"MZ").unwrap();
            assert!(validate_install_dir(used.path()).is_ok());
        }

        /// Registers/unregisters `.kern` + `kern://` against a scratch class
        /// tree so the real `Software\Classes` is never touched.
        #[test]
        fn file_associations_round_trip() {
            use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
            use winreg::RegKey;

            let root = r"Software\Classes\kern-assoc-e2e-test";
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            unregister_file_associations(root);

            let exe = PathBuf::from(r"C:\fake\kern.exe");
            register_file_associations(root, &exe).expect("register");

            let prog: String = hkcu
                .open_subkey(format!(r"{root}\.kern"))
                .and_then(|k| k.get_value(""))
                .expect(".kern points at a ProgID");
            assert_eq!(prog, KERN_PROG_ID);

            let open: String = hkcu
                .open_subkey(format!(r"{root}\{KERN_PROG_ID}\shell\open\command"))
                .and_then(|k| k.get_value(""))
                .expect("file open command");
            assert!(open.contains("kern.exe"), "open command: {open}");
            assert!(open.contains("%1"), "open command: {open}");

            let proto: String = hkcu
                .open_subkey(format!(r"{root}\{URL_PROTOCOL}\shell\open\command"))
                .and_then(|k| k.get_value(""))
                .expect("protocol open command");
            assert!(proto.contains("kern.exe"), "protocol command: {proto}");

            unregister_file_associations(root);
            assert!(hkcu.open_subkey(format!(r"{root}\.kern")).is_err());
            assert!(hkcu
                .open_subkey(format!(r"{root}\{KERN_PROG_ID}"))
                .is_err());
            assert!(hkcu
                .open_subkey(format!(r"{root}\{URL_PROTOCOL}"))
                .is_err());

            if let Ok(classes) = hkcu.open_subkey_with_flags(r"Software\Classes", KEY_ALL_ACCESS) {
                let _ = classes.delete_subkey_all("kern-assoc-e2e-test");
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    win::main();
}
