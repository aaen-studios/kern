//! Running-process registry + variable resolution.
//!
//! Spec: documentation/ArchitecturePlan.md §5 (Backend Architecture).
//!
//! Processes are spawned with `std::process::Command` using piped stdio. Output
//! is read on two dedicated blocking threads (stdout + stderr), each forwarding
//! line-by-line to the UI over `log:<id>:stream` and appending to
//! `latest.log`. State transitions (`Running` / `Exited`) go over `status:<id>`.
//!
//! Pipes (not a PTY) are used deliberately: most runtimes line-buffer when
//! writing to stdout regardless of whether it's a TTY — Rust's `std::io::stdout`
//! is a `LineWriter` that flushes on every `\n` unconditionally
//! (rust-lang/rust#60673), Python's `print` is line-buffered on a pipe, and
//! Node/Bun/Deno flush promptly. So output streams live without the complexity
//! and Windows-ConPTY flakiness of a pseudo-terminal.
//!
//! A per-instance generation tag lets a superseded reader self-suppress its
//! termination marker (so a fast restart emits exactly one).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

/// Structured status payload emitted on `status:<id>` — the UI can switch on
/// `state` rather than parsing a free-form string.
///
/// Serializes internally-tagged so it matches the frontend's discriminated-union
/// contract exactly: `Running` → `{ "state": "running" }` and
/// `Exited { code }` → `{ "state": "exited", "code": <n|null> }`. Without
/// `tag = "state"` serde uses the default externally-tagged form, which emits a
/// bare `"running"` string — and the UI's `payload.state === "running"` check
/// then never matches, so live status updates silently never fire.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum StatusPayload {
    /// Process spawned and now streaming output.
    Running,
    /// Process terminated, optionally with an exit code.
    Exited { code: Option<i32> },
}

/// One entry per running instance: the child (for kill + exit code), a writer
/// to feed its stdin, and the path to its working directory (for the log file).
///
/// Each entry is stamped with a generation at spawn time; the reader threads
/// capture that generation and only emit their termination marker if the
/// generation still matches the registry — so a stale/superseded task (from a
/// fast restart, where stop kills the child but the old readers aren't finished
/// before a new launch bumps the generation) self-suppresses and the marker is
/// emitted exactly once by the current task.
struct RunningProcess {
    /// The child handle. Locked because `stop()` (kill) and the reader thread
    /// (wait) both touch it. One writer at a time.
    child: Mutex<Child>,
    /// stdin writer. Mutex'd because `write_stdin` is called from a Tauri
    /// command thread.
    stdin: Mutex<Option<ChildStdin>>,
    /// OS process id, captured at spawn so the metrics sampler can resolve the
    /// process tree without locking the `Child` handle.
    pid: u32,
    #[allow(dead_code)]
    working_dir: PathBuf,
}

/// Global process table, keyed by server instance id, plus a per-instance
/// generation sequence used to stale-check background tasks.
#[derive(Default)]
pub struct ProcessRegistry {
    processes: Mutex<HashMap<String, RunningProcess>>,
    /// Per-instance_id generation counter. Increased every time a new process
    /// is registered for an id; the live value is stamped onto the RunningProcess
    /// and captured by its background task.
    generations: Mutex<HashMap<String, u64>>,
    /// Re-adopted processes from a previous session, keyed by instance id →
    /// the OS pid. These have NO Child handle / pipes — they're PID-only
    /// monitors (liveness, metrics, tray, force-kill). A server is "running"
    /// if it's in `processes` (owned) OR `adopted`.
    adopted: Mutex<HashMap<String, u32>>,
}

impl ProcessRegistry {
    /// Returns the next generation for the given instance id and records it as
    /// the current one. Only takes the generations mutex — callers that also
    /// need the processes map take that lock separately afterwards (never the
    /// other way around) to keep lock ordering deadlock-free.
    fn next_generation(&self, id: &str) -> u64 {
        let mut gens = self.generations.lock().expect("generations lock poisoned");
        let next = gens.get(id).copied().unwrap_or(0) + 1;
        gens.insert(id.to_string(), next);
        next
    }

    /// Returns the current stored generation for an id, if any.
    fn current_generation(&self, id: &str) -> Option<u64> {
        self.generations.lock().ok()?.get(id).copied()
    }

    /// Returns the OS process id for a running instance, if it has one. Used by
    /// the metrics sampler to resolve the process tree without touching the
    /// `Child` handle (which would contend with the kill/wait paths).
    /// Checks owned processes first, then re-adopted ones.
    pub fn pid_for(&self, id: &str) -> Option<u32> {
        if let Some(pid) = self.processes.lock().ok()?.get(id).map(|rp| rp.pid) {
            return Some(pid);
        }
        self.adopted.lock().ok()?.get(id).copied()
    }

    /// Returns the ids of every currently-running instance. Used to build the
    /// tray menu's "active servers" section and to back the
    /// `list_running_servers` command. Includes both owned and re-adopted.
    pub fn running_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = match self.processes.lock() {
            Ok(map) => map.keys().cloned().collect(),
            Err(_) => Vec::new(),
        };
        if let Ok(adopted) = self.adopted.lock() {
            for id in adopted.keys() {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
        ids
    }

    /// True if this instance is a re-adopted PID-only monitor (no Child handle,
    /// no stdin/stdout pipes). Used by the stop path to choose force-kill over
    /// graceful shutdown.
    pub fn is_adopted(&self, id: &str) -> bool {
        self.adopted.lock().ok().is_some_and(|m| m.contains_key(id))
    }

    /// Registers a re-adopted process by PID. Idempotent. Emits
    /// `kern://running-set-changed` so the tray refreshes.
    pub fn adopt(&self, handle: &AppHandle, id: &str, pid: u32) {
        if let Ok(mut map) = self.adopted.lock() {
            map.insert(id.to_string(), pid);
        }
        let _ = handle.emit("kern://running-set-changed", ());
    }

    /// Removes a re-adopted entry (process died or was force-killed). No-op if
    /// it wasn't adopted.
    pub fn unadopt(&self, handle: &AppHandle, id: &str) {
        if let Ok(mut map) = self.adopted.lock() {
            map.remove(id);
        }
        let _ = handle.emit("kern://running-set-changed", ());
    }

    /// Detaches all running processes: closes stdin and drops the child handle
    /// without killing. The processes continue running (orphaned).
    /// Used during app exit to leave server processes alive.
    pub fn detach_all(&self) {
        if let Ok(mut map) = self.processes.lock() {
            for (_id, proc) in map.drain() {
                // Close stdin so the process won't receive a shutdown command.
                if let Ok(mut guard) = proc.stdin.lock() {
                    drop(guard.take());
                }
                // Dropping the child handle without kill/wait lets the process
                // continue running as an orphan.
            }
        }
    }
}

/// Resolves `{{userOverrides.<key>}}` placeholders in a template string.
///
/// Mirrors the contract documented in ArchitecturePlan §5.
pub fn resolve_variables(template: &str, variables: &HashMap<String, String>) -> String {
    let mut out = template.to_string();
    for (key, val) in variables {
        let pattern = format!("{{{{userOverrides.{}}}}}", key);
        out = out.replace(&pattern, val);
    }
    out
}

/// Returns true if `line` already starts with a `[HH:MM:SS]`-style timestamp.
///
/// Deliberately liberal: accepts `[HH:MM]`, `[H:MM:SS.fff]`, `[2:32:07 PM]`,
/// optional brackets, optional AM/PM, and leading whitespace. The goal is to
/// *never* double-stamp — a false positive just means we skip a redundant
/// prefix the line didn't need anyway. Sub-second fractions and localized
/// formats we don't emit are tolerated; the only cost of a false positive is
/// one unstamped line.
///
// The `i += 1` advancing the optional second hour digit trips a false
// positive here; the dump below it reads `i` via `bytes[i]`, but the lint
// sees the path through the hours branch as overwriting. Suppress locally.
#[allow(unused_assignments)]
fn has_timestamp(line: &str) -> bool {
    use std::ops::ControlFlow;

    // Advance I through N ASCII digits starting at I; return Break early if a
    // non-digit is hit before N are consumed.
    fn digits(bytes: &[u8], i: &mut usize, n: usize) -> ControlFlow<(), ()> {
        for _ in 0..n {
            if *i >= bytes.len() || !bytes[*i].is_ascii_digit() {
                return ControlFlow::Break(());
            }
            *i += 1;
        }
        ControlFlow::Continue(())
    }

    let bytes = line.as_bytes();
    let len = bytes.len();

    // Skip optional leading whitespace.
    let mut i = 0;
    while i < len && bytes[i].is_ascii_whitespace() {
        i += 1;
    }

    // Optional opening bracket.
    if i < len && bytes[i] == b'[' {
        i += 1;
    }

    // 1–2 digit hour.
    if digits(bytes, &mut i, 1).is_break() {
        return false;
    }
    if i < len && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i >= len || bytes[i] != b':' || digits(&bytes, &mut i, 2).is_break() {
        return false;
    }

    // Optional ':SS' (seconds).
    if i < len && bytes[i] == b':' {
        if digits(&bytes, &mut i, 2).is_break() {
            return false;
        }
    }

    // Optional sub-second fraction ('.' then 1+ digits).
    if i < len && bytes[i] == b'.' {
        i += 1;
        if digits(&bytes, &mut i, 1).is_break() {
            return false;
        }
        while i < len && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }

    // Optional AM/PM suffix — tolerate both "AM"/"PM" and a lone trailing "M".
    if matches!(bytes.get(i), Some(b) if *b == b'a' || *b == b'A' || *b == b'p' || *b == b'P')
        && matches!(bytes.get(i + 1), Some(b) if *b == b'm' || *b == b'M')
    {
        i += 2;
    } else if matches!(bytes.get(i), Some(b) if *b == b'm' || *b == b'M') {
        i += 1;
    }

    // If an opening bracket was consumed, a closing ']' may follow.
    if i < len && bytes[i] == b']' {
        i += 1;
    }

    true
}

/// Formats the current wall-clock time as `[HH:MM:SS]` for log prefixes.
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day = secs / 86_400;
    let mut tod = secs % 86_400; // seconds since local midnight (UTC)
    // Local timezone offset isn't worth a dependency; normalize to a 24h cycle.
    let _ = day;
    let h = (tod / 3600) % 24;
    tod %= 3600;
    let m = (tod / 60) % 60;
    let s = tod % 60;
    format!("[{h:02}:{m:02}:{s:02}]")
}

/// Writes a line to the instance's latest.log, prefixed with a timestamp.
fn append_log(log_path: &Path, bytes: &[u8]) {
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) else {
        return;
    };
    let _ = file.write_all(timestamp().as_bytes());
    let _ = file.write_all(b" ");
    let _ = file.write_all(bytes);
    if bytes.last() != Some(&b'\n') {
        let _ = file.write_all(b"\n");
    }
}

/// Parses a `.env` file into `(key, value)` pairs. Blank lines and lines
/// beginning with `#` are ignored; an optional leading `export ` prefix and
/// surrounding `"..."` / `'...'` quotes on the value are stripped. Malformed
/// lines (no `=`) are skipped silently — `.env` is a convenience, not a hard
/// requirement, so a bad line shouldn't fail the launch.
fn parse_env_file(path: &Path) -> Vec<(String, String)> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, val)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut val = val.trim().to_string();
        // Strip a single matched pair of surrounding quotes (not both kinds).
        let bytes = val.as_bytes();
        if bytes.len() >= 2
            && (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'
                || bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
        {
            val = val[1..val.len() - 1].to_string();
        }
        out.push((key.to_string(), val));
    }
    out
}

/// Splits a templated arg string on whitespace into individual arguments.
///
/// A single manifest arg entry like `{{userOverrides.jvm_args}}` expands to many
/// `-XX` flags; without splitting it would be passed as one giant quoted string.
/// JVM flags contain no spaces or shell metacharacters, so a plain whitespace
/// split is sufficient.
pub fn shell_split(input: &str) -> Vec<String> {
    input.split_whitespace().map(String::from).collect()
}

/// Joins args back into a single display line, quoting any that contain spaces
/// or are empty, so the echoed command line reads back faithfully (e.g. a JVM
/// arg block stays visually grouped). Best-effort display formatting — the
/// process is *not* re-launched from this string, so it doesn't need to be a
/// perfectly round-trippable shell command.
pub fn shell_join(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if a.is_empty() || a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Suppresses the console window that Windows would otherwise allocate for a
/// console-subsystem child (`cmd.exe`, `java.exe`, `node.exe`, `cargo.exe`, …)
/// spawned by this GUI app. No-op on non-Windows.
///
/// Piped stdio alone does not prevent the window — Windows only suppresses
/// child-console allocation when `CREATE_NO_WINDOW` (0x0800_0000) is passed.
/// This keeps every spawned process windowless so the app's own terminal is the
/// only place output is ever seen.
#[cfg(windows)]
pub(crate) fn suppress_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn suppress_window(_cmd: &mut Command) {}

/// Builds a `Command` that runs a user-typed ad-hoc line through the OS shell.
///
/// Unlike [`build_shell_command`] (which is for lifecycle launchers and rewrites
/// bare names to `.bat`/`.sh`), this passes the user's input **verbatim** to the
/// shell so builtins like `dir`, `echo`, `type`, `set`, `ls`, and pipelines /
/// redirects all work — exactly what someone expects when typing into a terminal.
///
/// `raw_line` is the full trimmed input string (command + args as typed). On
/// Windows: `cmd.exe /C "<line>"`; on Unix: `sh -c "<line>"`.
pub(crate) fn build_adhoc_shell_command(raw_line: &str) -> Command {
    if cfg!(windows) {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(raw_line);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(raw_line);
        c
    }
}

/// Builds a `Command` that runs `command` (with `args`) through the OS shell.
///
/// Used for lifecycle steps whose `command` names a script (Forge/NeoForge's
/// generated `run.sh` / `run.bat`), which can't be spawned directly. On Unix we
/// invoke `sh -c "<command> <quoted args…>"`; on Windows `cmd.exe /C "<command>
/// <args…>"`.
///
/// A platform-agnostic launcher name (a bare word like `kern_start`, written by
/// a plugin's installer as `kern_start.sh` on Unix or `kern_start.bat` on
/// Windows) is resolved to the matching extension for the host OS, so a single
/// manifest step works cross-platform.
fn build_shell_command(command: &str, args: &[String]) -> Command {
    // Resolve a bare launcher name (no path separator, no extension) to the
    // OS-appropriate script. Names that already carry an extension or a path
    // are passed through untouched.
    let resolved = if !command.contains('.') && !command.contains('/') && !command.contains('\\') {
        if cfg!(windows) {
            format!("{command}.bat")
        } else {
            format!("{command}.sh")
        }
    } else {
        command.to_string()
    };

    if cfg!(windows) {
        // cmd.exe /C passes the whole line verbatim to the shell; no extra
        // quoting needed since cmd's own parser handles flags fine.
        let mut line = resolved;
        for a in args {
            line.push(' ');
            line.push_str(a);
        }
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(line);
        c
    } else {
        // sh -c "<command> 'arg1' 'arg2' …" — single-quote each arg so a value
        // containing spaces survives intact. (Lifecycle args here are simple
        // flags like "nogui", so this is belt-and-braces.) For a bare launcher
        // name (no path separator) — whether the caller wrote "kern_start" or
        // we resolved it to "kern_start.sh" — prefix "./" so sh finds it in the
        // working directory (the cwd isn't normally on $PATH).
        let mut line = if !resolved.contains('/') && !resolved.contains('\\') {
            format!("./{resolved}")
        } else {
            resolved
        };
        for a in args {
            line.push(' ');
            // Escape any embedded single-quote per the standard ''-wrap rule.
            let safe = a.replace('\'', "'\\''");
            line.push('\'');
            line.push_str(&safe);
            line.push('\'');
        }
        let mut c = Command::new("sh");
        c.arg("-c").arg(line);
        c
    }
}

/// Spawns a server instance's "start" lifecycle step with piped stdio.
///
/// `working_dir` is where the process runs and where `latest.log` is written.
/// If `<working_dir>/.env` exists it is parsed and applied to the child's
/// environment (overriding any inherited host value). On success the process is
/// registered, its stdout+stderr are streamed line-by-line over
/// `log:<id>:stream`, and a `Running` status is emitted. When it exits, an
/// `Exited` status is emitted.
///
/// When `use_shell` is true the command is invoked through the OS shell
/// (`sh -c` on Unix, `cmd.exe /C` on Windows) so lifecycle steps that name a
/// script (e.g. Forge/NeoForge's generated `run.sh` / `run.bat`) can be run,
/// which `Command::new` can't do directly. The `command` string is passed to
/// the shell as-is; `args` are appended after it (shell-quoted on Unix so a
/// flag with spaces survives).
///
/// `java_path` is the JDK selected on the instance's Setup page (the live
/// `user_overrides["java_path"]`), passed in explicitly so it can't drift from
/// the `.env` file (which is only written at creation and may be stale after
/// the user changes Java). When present it drives the `JAVA_HOME` / `PATH`
/// derivation that lets shell-based steps (Forge/NeoForge run scripts, which
/// invoke `java` from PATH rather than our `command`) resolve the same JDK the
/// user picked.
pub fn launch(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    command: &str,
    args: &[String],
    use_shell: bool,
    java_path: Option<&str>,
) -> Result<(), String> {
    // Build the command. When `use_shell` is true the command is invoked
    // through the OS shell so lifecycle steps naming a script (Forge/NeoForge's
    // generated run.sh / run.bat) can run, which `Command::new` can't do
    // directly. Otherwise the program is spawned directly.
    let cmd = if use_shell {
        build_shell_command(command, args)
    } else {
        let mut c = Command::new(command);
        c.args(args);
        c
    };
    spawn_and_stream(
        app_handle,
        instance_id,
        working_dir,
        cmd,
        format!("$ {} {}", command, shell_join(args)),
        command.to_string(),
        java_path,
    )
}

/// Runs an arbitrary user-provided line (e.g. a custom `start_command`) through
/// the OS shell verbatim — `cmd.exe /C` on Windows, `sh -c` on Unix — so PATH
/// lookups, `.cmd`/`.bat` shims (npm / bun / yarn / npx / pnpm on Windows),
/// env-var expansion, pipes and redirects all work exactly as they would in a
/// real terminal. `raw_line` is the already-variable-resolved command string; it
/// is handed to the shell as a single argument with no further splitting, so
/// anything the user types is honoured.
pub fn launch_via_shell(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    raw_line: &str,
    java_path: Option<&str>,
) -> Result<(), String> {
    let cmd = build_adhoc_shell_command(raw_line);
    spawn_and_stream(
        app_handle,
        instance_id,
        working_dir,
        cmd,
        format!("$ {raw_line}"),
        raw_line.to_string(),
        java_path,
    )
}

/// Shared spawn + streaming tail used by both [`launch`] (manifest lifecycle
/// steps) and [`launch_via_shell`] (custom start commands). Truncates
/// `latest.log` for a fresh run, applies cwd / Windows window-suppression / the
/// instance's `.env` / the selected JDK's `JAVA_HOME` + `PATH` / piped stdio to
/// the (already-built) `cmd`, spawns it, registers the child in the process
/// registry, echoes `display_line` to the terminal + log, and starts the two
/// stdout/stderr reader threads. `spawn_label` is what shows up in the
/// spawn-failure error message.
fn spawn_and_stream(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    mut cmd: Command,
    display_line: String,
    spawn_label: String,
    java_path: Option<&str>,
) -> Result<(), String> {
    // 0. Start fresh: truncate latest.log so the seeded tail reflects only this
    //    run, not the previous run's `[process terminated …]` marker.
    let log_path = working_dir.join("latest.log");
    if File::create(&log_path).is_err() {
        // Non-fatal — streaming still works, the disk mirror just won't reset.
    }

    // 1. Finalise the command. std::process::Command inherits the host
    //    environment by default (so PATH etc. are preserved); layer the
    //    instance's .env on top. Pipes on all three streams so we can read
    //    output and feed stdin.
    cmd.current_dir(working_dir);
    suppress_window(&mut cmd);
    let env_path = working_dir.join(".env");
    let env_vars = parse_env_file(&env_path);
    // The Setup-selected JDK path is the source of truth (the explicit
    // `java_path` arg); `.env` may be stale since it's only written at server
    //    creation. From it derive JAVA_HOME and prepend the JDK's bin/ to PATH so
    //    shell-based steps (Forge/NeoForge run scripts, which call `java` from
    //    PATH rather than our `command`) resolve the same JDK the user picked.
    let java_bin_dir = java_path
        .filter(|p| !p.is_empty())
        .and_then(|p| std::path::Path::new(p).parent().map(|p| p.to_path_buf()));
    let java_home_derived = java_bin_dir.as_ref().and_then(|bin| bin.parent()).map(|p| p.to_path_buf());
    for (k, v) in &env_vars {
        cmd.env(k, v);
    }
    if let Some(jh) = &java_home_derived {
        let jh_str = jh.to_string_lossy().to_string();
        if !env_vars.iter().any(|(k, _)| k == "JAVA_HOME") {
            cmd.env("JAVA_HOME", &jh_str);
        }
    }
    // Prepend JDK bin/ to PATH so the correct `java` binary is found first.
    // Use the OS-native separator (`;` on Windows, `:` on Unix) so this works
    //    cross-platform.
    if let Some(bin) = &java_bin_dir {
        let bin_str = bin.to_string_lossy().to_string();
        let current_path = std::env::var("PATH").unwrap_or_default();
        let sep = if cfg!(windows) { ";" } else { ":" };
        cmd.env("PATH", format!("{bin_str}{sep}{current_path}"));
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // 2. Spawn. Errors propagate to run_step → the red error banner in the UI,
    //    so a missing binary / bad command never fails silently.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{spawn_label}': {e}"))?;

    // Capture the OS pid up front (before the child handle is moved into the
    // registry) so the metrics sampler can resolve the process tree without
    // contending for the child mutex.
    let pid = child.id();

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "spawned child has no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "spawned child has no stderr pipe".to_string())?;
    let stdin = child.stdin.take();

    // 3. Register the child so stop_server_instance can terminate it. Bump the
    //    per-instance generation so any reader thread still running from a prior
    //    (re)launch of this id can recognise it has been superseded.
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let gen = registry.next_generation(instance_id);
    {
        let mut map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        map.insert(
            instance_id.to_string(),
            RunningProcess {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                pid,
                working_dir: working_dir.to_path_buf(),
            },
        );
    }

    // The running set just grew — notify the tray so its "active servers"
    // section + tooltip refresh. Best-effort; a failed emit shouldn't abort
    // an otherwise-successful launch.
    let _ = app_handle.emit("kern://running-set-changed", ());

    // 4. Echo the resolved command line into the terminal + latest.log before
    //    any process output arrives, so the user can see exactly what was run
    //    (custom start_command, manifest step, auto-injected --bin, etc.). The
    //    caller passes the full pre-formatted line so each entry point formats
    //    it appropriately (manifest step re-quotes args; a custom start command
    //    echoes the user's verbatim line).
    let event_name = format!("log:{instance_id}:stream");
    let stamped = format!("{} {}", timestamp(), display_line);
    append_log(&log_path, stamped.as_bytes());
    let _ = app_handle.emit(&event_name, stamped.clone());

    // 5. Notify the UI the process is now running.
    let _ = app_handle.emit(
        &format!("status:{instance_id}"),
        StatusPayload::Running,
    );

    // 6. Two blocking reader threads forward stdout + stderr line-by-line. Std
    //    threads (not tokio) because pipe reads block. The stdout thread owns
    //    teardown: on EOF it waits for the exit code and emits the Exited status
    //    + termination marker (gen-guarded, so a superseded task stays silent).
    let status_event = format!("status:{instance_id}");

    // --- stderr reader: forward lines, then exit on EOF (no teardown). ---
    let stderr_handle = app_handle.clone();
    let event_name_err = event_name.clone();
    let log_path_err = log_path.clone();
    let id_err = instance_id.to_string();
    std::thread::spawn(move || {
        let registry: tauri::State<'_, ProcessRegistry> = stderr_handle.state();
        let mut reader = BufReader::new(stderr);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => return, // EOF
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[process] stderr read error: {e}");
                    return;
                }
            }
            forward_line(&stderr_handle, &registry, &event_name_err, &log_path_err, &id_err, gen, &buf);
        }
    });

    // --- stdout reader: forward lines, then on EOF do process teardown. ---
    let stdout_handle = app_handle.clone();
    let id = instance_id.to_string();
    std::thread::spawn(move || {
        let registry: tauri::State<'_, ProcessRegistry> = stdout_handle.state();
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break, // EOF — child closed stdout; do teardown below
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[process] stdout read error: {e}");
                    break;
                }
            }
            forward_line(&stdout_handle, &registry, &event_name, &log_path, &id, gen, &buf);
        }

        // stdout is closed — wait for the child to finish and report its exit.
        // If this task was superseded mid-flight, stay silent so the newer task
        // owns the termination marker (otherwise it would render twice).
        let still_mine = registry.current_generation(&id).as_ref() == Some(&gen);
        if still_mine {
            // Remove our registry entry (and take the child to wait on it).
            let child_opt = registry
                .processes
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&id))
                .map(|rp| rp.child.into_inner().expect("child lock poisoned"));
            // The owned process exited — clear its persisted pid so a future
            // app restart doesn't try to re-adopt a dead process.
            let clear_handle = stdout_handle.clone();
            let clear_id = id.clone();
            let _ = crate::config::with_config_mut(&clear_handle, |cfg| {
                if let Some(instance) = cfg.servers.get_mut(&clear_id) {
                    instance.pid = None;
                }
                Ok(())
            });
            let exit_code = match child_opt {
                Some(mut child) => match child.wait() {
                    Ok(status) => status.code(),
                    Err(_) => None,
                },
                None => None, // already removed (e.g. stop() took it) — no code
            };
            let _ = stdout_handle.emit(
                &status_event,
                StatusPayload::Exited { code: exit_code },
            );
            // The running set just shrank — notify the tray so its "active
            // servers" section + tooltip refresh.
            let _ = stdout_handle.emit("kern://running-set-changed", ());
            let label = match exit_code {
                Some(c) => format!("exit {c}"),
                None => "no exit code".to_string(),
            };
            let marker = format!("[process terminated ({})]", label);
            // Persist the marker to disk too — otherwise re-entering the view
            // (which re-seeds from latest.log) would lose it, making the
            // termination look like it "disappeared". append_log adds the
            // timestamp prefix itself, so pass the bare marker.
            append_log(&log_path, marker.as_bytes());
            let _ = stdout_handle.emit(&event_name, format!("{} {}", timestamp(), marker));
        }
    });

    Ok(())
}

/// Forwards one read chunk to the UI + disk. Shared by the stdout and stderr
/// reader threads. Gen-guarded: a superseded task stops forwarding immediately.
fn forward_line(
    handle: &AppHandle,
    registry: &tauri::State<'_, ProcessRegistry>,
    event_name: &str,
    log_path: &Path,
    id: &str,
    gen: u64,
    bytes: &[u8],
) {
    // Superseded by a newer launch? Stop forwarding immediately.
    if registry.current_generation(id).as_ref() != Some(&gen) {
        return;
    }
    // Read raw bytes and lossy-convert: pipe output isn't guaranteed valid
    // UTF-8 (ANSI color codes, partial multibyte sequences at boundaries).
    let lossy = String::from_utf8_lossy(bytes);
    let trimmed = lossy.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
        return;
    }
    append_log(log_path, trimmed.as_bytes());
    // Only stamp if the line didn't already arrive with its own timestamp;
    // emulated consoles sometimes print one of their own and we don't want to
    // double up.
    let stamped = if has_timestamp(trimmed) {
        trimmed.to_string()
    } else {
        format!("{} {}", timestamp(), trimmed)
    };
    let _ = handle.emit(event_name, stamped);
}

/// Terminates a running instance by id. Returns Ok even if not running, so the
/// UI can treat stop as idempotent.
///
/// This is a hard, immediate kill. For a graceful shutdown (e.g. letting a
/// Minecraft server flush its world to disk before exiting) use
/// [`stop_graceful`], which prefers a polite exit and only falls back to a hard
/// kill on timeout.
///
/// Not currently called from any command (both the stop and restart paths use
/// `stop_graceful`), but kept as the documented hard-kill primitive.
#[allow(dead_code)]
pub fn stop(app_handle: &AppHandle, instance_id: &str) -> Result<(), String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let removed = {
        let mut map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        map.remove(instance_id)
    };
    if let Some(proc) = removed {
        // 1. Kill the process tree (taskkill on Windows, direct kill on Unix).
        //    This ensures npm/npx wrappers (which spawn child node.exe processes)
        //    are fully terminated rather than leaving orphans.
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &proc.pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }

        // 2. Kill the direct child handle so Rust's `Child` doesn't hang.
        let mut child = proc.child.into_inner().expect("child lock poisoned");
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

/// Force-kills a re-adopted (PID-only) process by OS pid and removes it from
/// the adopted registry. Used when the user stops a server that was re-adopted
/// from a previous session — there's no Child handle or stdin pipe, so graceful
/// shutdown is impossible; this is the only option. Emits the termination
/// events so the UI + tray sync.
pub fn force_kill_adopted(app_handle: &AppHandle, instance_id: &str) -> Result<(), String> {
    // Read the pid without removing — `unadopt` (called below) does the removal
    // + emits kern://running-set-changed.
    let Some(pid) = pid_for(app_handle, instance_id) else {
        return Ok(()); // wasn't adopted — nothing to do
    };
    if !is_adopted(app_handle, instance_id) {
        return Ok(()); // owned, not adopted — not our path
    }

    // Kill the process tree by PID. Same pattern as `stop`'s Windows branch.
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // SIGKILL the whole group if we were the group leader, else just the pid.
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }

    // Remove from the adopted registry + emit the running-set-changed signal
    // (unadopt centralizes both). Also emit the status:Exited event so the UI
    // syncs, matching the owned-process teardown.
    use tauri::Emitter;
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    registry.unadopt(app_handle, instance_id);
    let status_event = format!("status:{instance_id}");
    let _ = app_handle.emit(
        &status_event,
        StatusPayload::Exited { code: None },
    );
    Ok(())
}

/// Gracefully shuts down a running instance by id.
///
/// Writes `stop` to the child's stdin and waits for it to exit on its own. For a
/// Minecraft server this triggers a clean shutdown: it flushes chunks, saves the
/// world, and exits — so the next start doesn't roll back to the last autosave.
///
/// If the child hasn't exited within `timeout`, we fall back to a hard `kill()`
/// so a hung or unresponsive process can't wedge the stop button forever. Either
/// way the registry entry is removed and the result is `Ok` — stop stays
/// idempotent and always succeeds from the caller's perspective.
///
/// Unlike [`stop`], the entry is left in the registry during the wait so the
/// stdout reader thread owns the normal EOF teardown path (it emits the
/// `Exited` status + `[process terminated]` marker, which the UI uses to sync
/// the sidebar status). We only remove the entry ourselves on the timeout path.
pub fn stop_graceful(
    app_handle: &AppHandle,
    instance_id: &str,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();

    // 1. Send the polite shutdown command. We hold the stdin lock only for the
    //    write, then drop it immediately so the reader threads (and any pending
    //    console input) aren't blocked.
    {
        let mut map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        let proc = match map.get_mut(instance_id) {
            Some(p) => p,
            None => return Ok(()), // not running — idempotent, like stop()
        };
        let mut guard = proc
            .stdin
            .lock()
            .map_err(|e| format!("stdin lock poisoned: {e}"))?;
        if let Some(stdin) = guard.as_mut() {
            // "stop" is the canonical graceful-shutdown command for vanilla /
            // Bukkit / Paper / Forge / Fabric servers. The trailing newline
            // submits it to the server's command console.
            if let Err(e) = stdin.write_all(b"stop\n") {
                // A closed stdin means the child is already tearing itself down
                // (or never had one) — fall through to the wait; the timeout +
                // kill fallback still guarantees we don't hang.
                eprintln!("[process] graceful stop: stdin write failed ({e}) — waiting for exit");
            }
            let _ = stdin.flush();
        }
    }

    // 2. Wait for the child to exit on its own. We poll the exit status (which
    //    reaps a zombie without blocking) on a short cadence until either it has
    //    exited or we hit the timeout. Polling — rather than `child.wait()` on
    //    the locked handle — keeps the lock uncontended: the stdout reader
    //    thread needs the same handle for its teardown `wait()`, and holding it
    //    for the whole timeout would deadlock that path.
    let deadline = std::time::Instant::now() + timeout;
    loop {
        // try_wait needs the child lock, so only hold it for the probe itself.
        let exited = {
            let map = registry
                .processes
                .lock()
                .map_err(|e| format!("process registry lock poisoned: {e}"))?;
            match map.get(instance_id) {
                Some(proc) => {
                    let mut child = proc
                        .child
                        .lock()
                        .map_err(|e| format!("child lock poisoned: {e}"))?;
                    match child.try_wait() {
                        Ok(Some(_)) => true,  // exited
                        Ok(None) => false,    // still running
                        Err(_) => true,       // couldn't query — treat as gone
                    }
                }
                None => return Ok(()), // already torn down by the reader thread
            }
        };
        if exited {
            // The child is gone; the stdout reader thread will (or already has)
            // run the normal gen-guarded teardown — emit Exited + marker. We
            // don't touch the entry so `still_mine` stays true.
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    // 3. Timed out — the process didn't heed `stop`. Force it so the stop
    //    button can never hang. This is the same path as stop(): remove the
    //    entry (so the reader thread's `still_mine` check fails and it stays
    //    silent), then kill + wait.
    let removed = {
        let mut map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        map.remove(instance_id)
    };
    if let Some(proc) = removed {
        let mut child = proc.child.into_inner().expect("child lock poisoned");
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

/// Writes bytes to a running instance's stdin stream.
///
/// Returns an error if the instance is not currently tracked as running, or if
/// the write itself fails (e.g. the child's stdin pipe was closed).
pub fn write_stdin(
    app_handle: &AppHandle,
    instance_id: &str,
    data: &str,
) -> Result<(), String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let mut map = registry
        .processes
        .lock()
        .map_err(|e| format!("process registry lock poisoned: {e}"))?;
    let proc = map
        .get_mut(instance_id)
        .ok_or_else(|| format!("instance '{instance_id}' is not running"))?;
    let mut guard = proc
        .stdin
        .lock()
        .map_err(|e| format!("stdin lock poisoned: {e}"))?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| format!("instance '{instance_id}' has no stdin pipe"))?;
    stdin
        .write_all(data.as_bytes())
        .map_err(|e| format!("failed to write stdin to '{instance_id}': {e}"))?;
    Ok(())
}

/// Whether an instance currently has a tracked running process — either an
/// owned Child handle or a re-adopted PID-only monitor.
pub fn is_running(app_handle: &AppHandle, instance_id: &str) -> bool {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let owned = registry
        .processes
        .lock()
        .map(|m| m.contains_key(instance_id))
        .unwrap_or(false);
    if owned {
        return true;
    }
    registry
        .adopted
        .lock()
        .map(|m| m.contains_key(instance_id))
        .unwrap_or(false)
}

/// Returns the OS process id for a running instance, if it has one. Used by the
/// metrics sampler to resolve the process tree without locking the `Child`.
pub fn pid_for(app_handle: &AppHandle, instance_id: &str) -> Option<u32> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    registry.pid_for(instance_id)
}

/// True if this instance is a re-adopted PID-only monitor (no Child handle).
pub fn is_adopted(app_handle: &AppHandle, instance_id: &str) -> bool {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    registry.is_adopted(instance_id)
}
