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
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

/// Structured status payload emitted on `status:<id>` — the UI can switch on
/// `state` rather than parsing a free-form string.
///
/// Serializes internally-tagged so it matches the frontend's discriminated-union
/// contract: `Running` → `{ "state": "running" }`, `Stopping` →
/// `{ "state": "stopping" }`, and `Exited { code, forced }` →
/// `{ "state": "exited", "code": <n|null>, "forced": <bool> }`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum StatusPayload {
    /// Process spawned and now streaming output.
    Running,
    /// A stop was requested; the graceful phase is in progress.
    Stopping,
    /// Process terminated. `forced` is true when the graceful window expired
    /// and the tree had to be killed (the UI shows "stopped (forced)").
    Exited { code: Option<i32>, forced: bool },
}

/// Handle to a Windows Job Object grouping a child's whole process tree.
/// Dropping it closes the handle (the processes keep running, matching kern's
/// "servers outlive the app" policy); explicit tree termination goes through
/// `TerminateJobObject`.
#[cfg(windows)]
struct JobHandle(isize);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
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
    /// Set by the stop path right before a forced kill, so the teardown can
    /// report `Exited { forced: true }` instead of a generic error exit.
    forced: Arc<AtomicBool>,
    /// Set when the user (or a delete/restart) asked for the stop, so the
    /// crash watchdog doesn't treat it as an unexpected exit.
    intentional: Arc<AtomicBool>,
    /// Windows Job Object covering the whole tree (None if assignment failed).
    #[cfg(windows)]
    job: Option<JobHandle>,
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
    /// Ids with a launch in flight. An `Arc` so `StartReservation` can hold a
    /// clone without borrowing the Tauri `State`.
    starting: Arc<Mutex<std::collections::HashSet<String>>>,
    /// One-shot children (installers, ad-hoc terminal commands) that the Stop
    /// control can cancel. Tracked by pid only: the calling command owns the
    /// `Child` and blocks on it.
    tasks: Mutex<HashMap<String, TaskEntry>>,
}

/// A tracked one-shot child.
struct TaskEntry {
    pid: u32,
    /// Set by `stop_task` so the owning command can report a cancel rather
    /// than a failure exit code.
    forced: Arc<AtomicBool>,
}

/// Handle returned by [`register_task`]; lets the owning command tell whether
/// the task was canceled while it was waiting.
pub struct TaskRegistration {
    forced: Arc<AtomicBool>,
}

impl TaskRegistration {
    /// True when the task was force-killed by a stop request.
    pub fn was_forced(&self) -> bool {
        self.forced.load(Ordering::SeqCst)
    }
}

/// Clears its id from the registry's `starting` set on drop, so every early
/// return from a launch path releases the reservation automatically.
pub struct StartReservation {
    starting: Arc<Mutex<std::collections::HashSet<String>>>,
    id: String,
}

impl Drop for StartReservation {
    fn drop(&mut self) {
        if let Ok(mut set) = self.starting.lock() {
            set.remove(&self.id);
        }
    }
}

/// Atomically reserves a start slot for `id`. Fails if the instance is already
/// running/adopted or another start is in flight — closing the check-then-spawn
/// race that let two launches share one port.
pub fn reserve_start(app_handle: &AppHandle, id: &str) -> Result<StartReservation, String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let starting = registry.starting.clone();
    let mut set = starting
        .lock()
        .map_err(|e| format!("start reservation lock poisoned: {e}"))?;
    if set.contains(id) {
        return Err(format!("instance '{id}' is already starting"));
    }
    let owned = registry
        .processes
        .lock()
        .map_err(|e| format!("process registry lock poisoned: {e}"))?
        .contains_key(id);
    let adopted = registry
        .adopted
        .lock()
        .map_err(|e| format!("adopted registry lock poisoned: {e}"))?
        .contains_key(id);
    if owned || adopted {
        return Err(format!("instance '{id}' is already running"));
    }
    set.insert(id.to_string());
    drop(set);
    Ok(StartReservation {
        starting,
        id: id.to_string(),
    })
}

/// Registers a one-shot child (installer / ad-hoc command) so the Stop control
/// can cancel it. Fails if a task is already tracked for the id.
pub fn register_task(app_handle: &AppHandle, id: &str, pid: u32) -> Result<TaskRegistration, String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let mut tasks = registry
        .tasks
        .lock()
        .map_err(|e| format!("task registry lock poisoned: {e}"))?;
    if let Some(existing) = tasks.get(id) {
        if pid_alive(existing.pid) {
            return Err(format!("a task is already running for '{id}'"));
        }
        // Stale entry (owning command died before unregistering) — replace it.
        tasks.remove(id);
    }
    let forced = Arc::new(AtomicBool::new(false));
    tasks.insert(
        id.to_string(),
        TaskEntry {
            pid,
            forced: forced.clone(),
        },
    );
    Ok(TaskRegistration { forced })
}

/// Removes a task from the registry (called by the owning command on exit).
pub fn unregister_task(app_handle: &AppHandle, id: &str) {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let _ = registry.tasks.lock().map(|mut tasks| tasks.remove(id));
}

/// True while a one-shot task is tracked for this instance.
pub fn is_task_running(app_handle: &AppHandle, id: &str) -> bool {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    registry
        .tasks
        .lock()
        .map(|t| t.contains_key(id))
        .unwrap_or(true)
}

/// Cancels a tracked task: force-kills the tree and confirms death. Returns
/// `Ok(true)` when a task was running and is now gone.
pub fn stop_task(app_handle: &AppHandle, id: &str) -> Result<bool, String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let entry = {
        let mut tasks = registry
            .tasks
            .lock()
            .map_err(|e| format!("task registry lock poisoned: {e}"))?;
        tasks.remove(id)
    };
    let Some(entry) = entry else {
        return Ok(false);
    };
    entry.forced.store(true, Ordering::SeqCst);

    #[cfg(windows)]
    let _ = terminate_tree(entry.pid, &None);
    #[cfg(unix)]
    let _ = terminate_tree(entry.pid, &());

    for _ in 0..25 {
        if !pid_alive(entry.pid) {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "task for '{id}' (pid {}) survived the force-kill",
        entry.pid
    ))
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
    if i >= len || bytes[i] != b':' || digits(bytes, &mut i, 2).is_break() {
        return false;
    }

    // Optional ':SS' (seconds).
    if i < len && bytes[i] == b':'
        && digits(bytes, &mut i, 2).is_break() {
            return false;
        }

    // Optional sub-second fraction ('.' then 1+ digits).
    if i < len && bytes[i] == b'.' {
        i += 1;
        if digits(bytes, &mut i, 1).is_break() {
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

/// Epoch seconds, for run-duration math.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Formats the current wall-clock time as `[HH:MM:SS]` for log prefixes.
fn timestamp() -> String {    let secs = SystemTime::now()
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

/// Creates a [`Command`] for `program` with the Windows console window already
/// suppressed. This is the sanctioned constructor for every subprocess the app
/// spawns: routing through it makes a console flash impossible to introduce by
/// forgetting a `suppress_window` call. `scripts/check-silent-spawns.mjs`
/// enforces this in CI.
pub(crate) fn silent_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program); // silent-spawn-ok: constructor definition
    suppress_window(&mut cmd);
    cmd
}

/// Rewrites every shell-command segment that begins with `start` into
/// `start /B`. `start` otherwise opens a brand-new console window even when the
/// wrapping `cmd.exe` was spawned with `CREATE_NO_WINDOW`; `/B` starts the
/// program in the current (hidden) console instead. Quote-aware (a `start`
/// inside a quoted string is untouched and `^`-escapes are skipped), splitting
/// on the unquoted cmd operators `&&`, `||`, `&`, and `|`.
///
/// Windows-only semantics, but compiled on every platform: the call sites are
/// `if cfg!(windows)` runtime branches, so a `#[cfg(windows)]` here would break
/// the Unix build (the branch body is still type-checked there).
fn neutralize_start_commands(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + 8);
    let mut in_quotes = false;
    let mut segment_start = 0usize;
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => in_quotes = !in_quotes,
            b'^' if !in_quotes => {
                i += 2; // skip the escaped byte
                continue;
            }
            b'&' | b'|' if !in_quotes => {
                let mut j = i + 1;
                if j < bytes.len() && bytes[j] == bytes[i] {
                    j += 1;
                }
                push_start_segment(&mut out, &line[segment_start..i]);
                out.push_str(&line[i..j]);
                segment_start = j;
                i = j;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    push_start_segment(&mut out, &line[segment_start..]);
    out
}

/// Appends one shell segment to `out`, inserting `/B` when the first command
/// position is the `start` builtin (leading whitespace and `(`-groups are
/// treated as a prefix).
fn push_start_segment(out: &mut String, segment: &str) {
    let mut prefix_len = 0usize;
    for (idx, ch) in segment.char_indices() {
        if ch == '(' || ch == ' ' || ch == '\t' {
            prefix_len = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    let rest = &segment[prefix_len..];
    let is_start =
        rest == "start" || rest.starts_with("start ") || rest.starts_with("start\t");
    if is_start {
        out.push_str(&segment[..prefix_len]);
        out.push_str("start /B");
        out.push_str(&rest["start".len()..]);
    } else {
        out.push_str(segment);
    }
}

/// Platform handle covering a child's whole process tree.
#[cfg(windows)]
type TreeHandle = Option<JobHandle>;
#[cfg(unix)]
type TreeHandle = ();

/// Puts the freshly spawned child into a process tree we can terminate as a
/// unit. On Windows that's a Job Object; on Unix `spawn` already created a new
/// process group (`process_group(0)`), so there's nothing extra to attach.
#[cfg(windows)]
fn attach_tree(child: &Child) -> TreeHandle {
    create_job_for(child)
}
#[cfg(unix)]
fn attach_tree(_child: &Child) -> TreeHandle {}

/// Creates a Job Object covering `child`'s process tree. With the handle held
/// for the process lifetime, `TerminateJobObject` is a guaranteed tree kill —
/// `child.kill()` only terminates the direct child, which on Windows is often
/// the `cmd.exe` wrapper rather than the real server (which then survives,
/// holding its port).
#[cfg(windows)]
fn create_job_for(child: &Child) -> Option<JobHandle> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let handle = child.as_raw_handle() as HANDLE;
        if AssignProcessToJobObject(job, handle) == 0 {
            CloseHandle(job);
            return None;
        }
        Some(JobHandle(job as isize))
    }
}

/// Terminates the whole tree for a removed registry entry. Returns true when
/// the tree-kill call was issued (death is still verified separately).
#[cfg(windows)]
fn terminate_tree(pid: u32, tree: &TreeHandle) -> bool {
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
    if let Some(job) = tree {
        unsafe {
            if TerminateJobObject(job.0 as _, 1) != 0 {
                return true;
            }
        }
    }
    // Job assignment failed (or no job) — fall back to taskkill /T.
    let mut cmd = silent_command("taskkill");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(unix)]
fn terminate_tree(pid: u32, _tree: &TreeHandle) -> bool {
    signal_group(pid, libc::SIGKILL)
}

/// Sends a signal to the child's process group (pgid == pid).
#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) -> bool {
    unsafe { libc::kill(-(pid as i32), signal) == 0 }
}

/// Graceful platform signal: SIGTERM to the group on Unix (Node/Python/JVM
/// shutdown hooks run); Windows has no portable equivalent for windowless
/// console children, so the stdin command is the only graceful channel there.
#[cfg(unix)]
fn graceful_signal(pid: u32) -> bool {
    signal_group(pid, libc::SIGTERM)
}
#[cfg(windows)]
fn graceful_signal(_pid: u32) -> bool {
    false
}

/// The OS start time of a process (epoch seconds), used with the pid to verify
/// identity across app restarts (pid reuse guard). `None` when not running.
pub fn process_start_time(pid: u32) -> Option<u64> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    sys.process(Pid::from_u32(pid)).map(|p| p.start_time())
}

/// True while the pid is a live process.
pub fn pid_alive(pid: u32) -> bool {
    process_start_time(pid).is_some()
}

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
        let mut c = silent_command("cmd.exe");
        c.arg("/C").arg(neutralize_start_commands(raw_line));
        c
    } else {
        let mut c = silent_command("sh");
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
        let mut c = silent_command("cmd.exe");
        c.arg("/C").arg(neutralize_start_commands(&line));
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
        let mut c = silent_command("sh");
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
#[allow(clippy::too_many_arguments)]
pub fn launch(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    command: &str,
    args: &[String],
    use_shell: bool,
    java_path: Option<&str>,
    restartable: bool,
) -> Result<(), String> {
    // Build the command. When `use_shell` is true the command is invoked
    // through the OS shell so lifecycle steps naming a script (Forge/NeoForge's
    // generated run.sh / run.bat) can run, which `Command::new` can't do
    // directly. Otherwise the program is spawned directly.
    let cmd = if use_shell {
        build_shell_command(command, args)
    } else {
        let mut c = silent_command(command);
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
        restartable,
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
    restartable: bool,
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
        restartable,
    )
}

/// Runs a manifest `stop` lifecycle step (e.g. an RCON or helper command) in
/// the instance directory, bounded by `timeout`, streaming its output to the
/// terminal. The helper is deliberately NOT registered in the process table —
/// it is a short-lived action accompanying the stop, not the server itself.
pub fn run_stop_step(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    step: &crate::manifest::LifecycleStep,
    timeout: Duration,
) -> Result<(), String> {
    let cmd = if step.use_shell {
        build_shell_command(&step.command, &step.args)
    } else {
        let mut c = silent_command(&step.command);
        c.args(&step.args);
        c
    };
    run_helper(app_handle, instance_id, working_dir, cmd, timeout)
}

/// Runs a raw shell line as an untracked, bounded helper (scheduled commands,
/// ad-hoc maintenance) with output streamed to the terminal.
pub fn run_shell_helper(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    raw_line: &str,
    timeout: Duration,
) -> Result<(), String> {
    let cmd = build_adhoc_shell_command(raw_line);
    run_helper(app_handle, instance_id, working_dir, cmd, timeout)
}

/// Spawns a bounded helper command, forwarding stdout/stderr to the terminal,
/// and force-kills it if it overruns `timeout`.
fn run_helper(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    mut cmd: Command,
    timeout: Duration,
) -> Result<(), String> {
    cmd.current_dir(working_dir);
    suppress_window(&mut cmd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn stop step: {e}"))?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stop step has no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stop step has no stderr pipe".to_string())?;

    let event_name = format!("log:{instance_id}:stream");
    let log_path = working_dir.join("latest.log");

    let spawn_reader = |stream: Box<dyn std::io::Read + Send>, handle: AppHandle| {
        let event = event_name.clone();
        let log = log_path.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                forward_plain(&handle, &event, &log, line.as_bytes());
            }
        })
    };
    let out_thread = spawn_reader(Box::new(stdout), app_handle.clone());
    let err_thread = spawn_reader(Box::new(stderr), app_handle.clone());

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = out_thread.join();
                let _ = err_thread.join();
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("stop step exited with {:?}", status.code()))
                };
            }
            Ok(None) => {}
            Err(e) => {
                return Err(format!("failed to poll stop step: {e}"));
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_thread.join();
            let _ = err_thread.join();
            return Err(format!("stop step timed out after {:?} (pid {pid})", timeout));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Forwards one line to the UI + disk without registry/generation guards
/// (used by helper processes that aren't tracked in the process table).
fn forward_plain(handle: &AppHandle, event_name: &str, log_path: &Path, bytes: &[u8]) {
    let lossy = String::from_utf8_lossy(bytes);
    let trimmed = lossy.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
        return;
    }
    append_log(log_path, trimmed.as_bytes());
    let stamped = if has_timestamp(trimmed) {
        trimmed.to_string()
    } else {
        format!("{} {}", timestamp(), trimmed)
    };
    let _ = handle.emit(event_name, stamped);
}

/// Shared spawn + streaming tail used by both [`launch`] (manifest lifecycle
/// steps) and [`launch_via_shell`] (custom start commands). Truncates
/// `latest.log` for a fresh run, applies cwd / Windows window-suppression / the
/// instance's `.env` / the selected JDK's `JAVA_HOME` + `PATH` / piped stdio to
/// the (already-built) `cmd`, spawns it, registers the child in the process
/// registry, echoes `display_line` to the terminal + log, and starts the two
/// stdout/stderr reader threads. `spawn_label` is what shows up in the
/// spawn-failure error message.
#[allow(clippy::too_many_arguments)]
fn spawn_and_stream(
    app_handle: &AppHandle,
    instance_id: &str,
    working_dir: &Path,
    mut cmd: Command,
    display_line: String,
    spawn_label: String,
    java_path: Option<&str>,
    restartable: bool,
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

    // Own process group on Unix so the whole tree can be signalled as a unit.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // 2. Spawn. Errors propagate to run_step → the red error banner in the UI,
    //    so a missing binary / bad command never fails silently.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{spawn_label}': {e}"))?;

    // Capture the OS pid up front (before the child handle is moved into the
    // registry) so the metrics sampler can resolve the process tree without
    // contending for the child mutex.
    let pid = child.id();

    // Tree handle (job object on Windows) + forced-kill flag shared with the
    // teardown so `Exited { forced }` is accurate.
    #[cfg(windows)]
    let tree = attach_tree(&child);
    #[cfg(unix)]
    attach_tree(&child);
    let forced = Arc::new(AtomicBool::new(false));
    let intentional = Arc::new(AtomicBool::new(false));
    let started_secs = process_start_time(pid).unwrap_or_else(now_secs);

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
                forced: forced.clone(),
                intentional: intentional.clone(),
                #[cfg(windows)]
                job: tree,
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
            match read_line_capped(&mut reader, &mut buf) {
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
    let stdout_forced = forced.clone();
    let stdout_intentional = intentional.clone();
    std::thread::spawn(move || {
        let registry: tauri::State<'_, ProcessRegistry> = stdout_handle.state();
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match read_line_capped(&mut reader, &mut buf) {
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
            // If the entry is already gone, the force-kill path owns the
            // teardown events — stay silent to avoid a duplicate Exited.
            let Some(removed) = registry
                .processes
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&id))
            else {
                return;
            };
            let child_opt = Some(
                removed
                    .child
                    .into_inner()
                    .expect("child lock poisoned"),
            );
            // The owned process exited — clear its persisted pid so a future
            // app restart doesn't try to re-adopt a dead process.
            let clear_handle = stdout_handle.clone();
            let clear_id = id.clone();
            let _ = crate::config::with_config_mut(&clear_handle, |cfg| {
                if let Some(instance) = cfg.servers.get_mut(&clear_id) {
                    instance.pid = None;
                    instance.pid_started = None;
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
            let was_forced = stdout_forced.load(Ordering::SeqCst);
            let _ = stdout_handle.emit(
                &status_event,
                StatusPayload::Exited {
                    code: exit_code,
                    forced: was_forced,
                },
            );
            // The running set just shrank — notify the tray so its "active
            // servers" section + tooltip refresh.
            let _ = stdout_handle.emit("kern://running-set-changed", ());
            let label = if was_forced {
                "killed".to_string()
            } else {
                match exit_code {
                    Some(c) => format!("exit {c}"),
                    None => "no exit code".to_string(),
                }
            };
            let marker = format!("[process terminated ({})]", label);
            // Persist the marker to disk too — otherwise re-entering the view
            // (which re-seeds from latest.log) would lose it, making the
            // termination look like it "disappeared". append_log adds the
            // timestamp prefix itself, so pass the bare marker.
            append_log(&log_path, marker.as_bytes());
            let _ = stdout_handle.emit(&event_name, format!("{} {}", timestamp(), marker));

            // Crash watchdog: restart unexpected exits of restartable launch
            // steps (a "start" step, not an install/build step).
            if restartable {
                let was_intentional = stdout_intentional.load(Ordering::SeqCst);
                let run_secs = now_secs().saturating_sub(started_secs);
                if !was_intentional {
                    // Snapshot the exit code + log tail so the UI can explain
                    // the crash after the fact (and the notification links to it).
                    crate::crash::record(&stdout_handle, &id, exit_code, was_forced);
                }
                crate::watchdog::on_process_exit(
                    &stdout_handle,
                    &id,
                    exit_code,
                    was_intentional,
                    run_secs,
                );
            }
        }
    });

    Ok(())
}

/// Maximum bytes buffered for a single log line. A server that never emits a
/// newline (binary garbage, a stuck progress bar) must not grow kern's memory
/// without bound.
const MAX_LOG_LINE_BYTES: usize = 256 * 1024;

/// Reads up to and including the next `\n` into `buf`, capping how much is
/// buffered at [`MAX_LOG_LINE_BYTES`]. Any excess is drained without buffering
/// so the stream stays line-aligned. Returns total bytes consumed (0 = EOF).
fn read_line_capped<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    buf.clear();
    let mut total = 0usize;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(total);
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let take = newline.map(|p| p + 1).unwrap_or(available.len());
        if buf.len() < MAX_LOG_LINE_BYTES {
            let room = MAX_LOG_LINE_BYTES - buf.len();
            buf.extend_from_slice(&available[..take.min(room)]);
        }
        reader.consume(take);
        total += take;
        if newline.is_some() {
            return Ok(total);
        }
        if buf.len() >= MAX_LOG_LINE_BYTES {
            // Line exceeded the cap — drain to the newline without buffering.
            loop {
                let more = reader.fill_buf()?;
                if more.is_empty() {
                    return Ok(total);
                }
                match more.iter().position(|b| *b == b'\n') {
                    Some(pos) => {
                        reader.consume(pos + 1);
                        total += pos + 1;
                        return Ok(total);
                    }
                    None => {
                        let len = more.len();
                        reader.consume(len);
                        total += len;
                    }
                }
            }
        }
    }
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
    let mut trimmed = lossy.trim_end_matches(['\r', '\n']).to_string();
    if trimmed.is_empty() {
        return;
    }
    if bytes.len() >= MAX_LOG_LINE_BYTES {
        trimmed.push_str(" … [line truncated]");
    }
    append_log(log_path, trimmed.as_bytes());
    // Only stamp if the line didn't already arrive with its own timestamp;
    // emulated consoles sometimes print one of their own and we don't want to
    // double up.
    let stamped = if has_timestamp(&trimmed) {
        trimmed
    } else {
        format!("{} {}", timestamp(), trimmed)
    };
    // User-defined log-pattern alerts (no-op when none are configured).
    crate::logwatch::check(handle, id, &stamped);
    let _ = handle.emit(event_name, stamped);
}

/// Outcome of a stop request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// The process exited on its own after the graceful request.
    Graceful,
    /// The graceful window expired and the process tree was force-killed.
    Forced,
}

/// Stops a running instance with a staged, verified pipeline:
///
/// 1. **Graceful** — write `stdin_command` (if any) to the child's stdin and,
///    on Unix, send SIGTERM to its process group (JVM/Node shutdown hooks run).
/// 2. **Wait** — poll for exit up to `timeout`.
/// 3. **Force** — terminate the whole tree (Job Object on Windows, SIGKILL to
///    the process group on Unix), reap the child, then confirm the OS pid is
///    actually gone before reporting success.
///
/// Idempotent: `Ok(Graceful)` when nothing is registered. Emits `Stopping`
/// when a graceful phase starts; the normal reader-thread teardown emits
/// `Exited { forced: false }`, while the forced path removes the entry itself
/// and emits `Exited { forced: true }`.
pub fn stop_managed(
    app_handle: &AppHandle,
    instance_id: &str,
    timeout: Duration,
    stdin_command: Option<&str>,
) -> Result<StopOutcome, String> {
    let registry: tauri::State<'_, ProcessRegistry> = app_handle.state();
    let status_event = format!("status:{instance_id}");

    // Adopted processes have no child handle or pipes — force-kill by pid.
    if registry.is_adopted(instance_id) {
        crate::watchdog::reset(app_handle, instance_id);
        let _ = app_handle.emit(&status_event, StatusPayload::Stopping);
        force_kill_adopted(app_handle, instance_id)?;
        return Ok(StopOutcome::Forced);
    }

    // Not tracked at all: nothing to stop. Never claim a kill we didn't do.
    let pid = {
        let map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        match map.get(instance_id) {
            Some(proc) => {
                // Mark the exit as user-requested so the crash watchdog does
                // not immediately restart it.
                proc.intentional.store(true, Ordering::SeqCst);
                proc.pid
            }
            None => return Ok(StopOutcome::Graceful),
        }
    };
    crate::watchdog::reset(app_handle, instance_id);

    let _ = app_handle.emit(&status_event, StatusPayload::Stopping);

    // 1. Graceful phase: stdin command, then the platform signal.
    if let Some(cmd) = stdin_command.map(str::trim).filter(|c| !c.is_empty()) {
        let map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        if let Some(proc) = map.get(instance_id) {
            let mut guard = proc
                .stdin
                .lock()
                .map_err(|e| format!("stdin lock poisoned: {e}"))?;
            if let Some(stdin) = guard.as_mut() {
                // A closed stdin means the child is already tearing down.
                if stdin.write_all(format!("{cmd}\n").as_bytes()).is_err() {
                    eprintln!("[process] graceful stop: stdin write failed — waiting for exit");
                }
                let _ = stdin.flush();
            }
        }
    }
    graceful_signal(pid);

    // 2. Wait for the process to exit on its own.
    let deadline = std::time::Instant::now() + timeout;
    loop {
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
                    !matches!(child.try_wait(), Ok(None))
                }
                None => true, // reader thread already tore it down
            }
        };
        if exited {
            return Ok(StopOutcome::Graceful);
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    // 3. Force. Mark forced + remove the entry under one lock so a racing
    //    reader thread either sees `forced` or owns teardown, never both.
    let removed = {
        let mut map = registry
            .processes
            .lock()
            .map_err(|e| format!("process registry lock poisoned: {e}"))?;
        map.remove(instance_id).inspect(|proc| {
            proc.forced.store(true, Ordering::SeqCst);
        })
    };
    let Some(proc) = removed else {
        // Reader thread won the race (process exited right at the deadline);
        // it owns the teardown event. Report the timeout truthfully.
        return Ok(StopOutcome::Forced);
    };

    #[cfg(windows)]
    let tree_killed = terminate_tree(proc.pid, &proc.job);
    #[cfg(unix)]
    let tree_killed = terminate_tree(proc.pid, &());

    let mut child = proc
        .child
        .into_inner()
        .map_err(|_| "child lock poisoned".to_string())?;
    let _ = child.kill();
    let _ = child.wait(); // reap the direct child

    // Verify the OS pid is actually gone — job/taskkill are asynchronous and
    // may fail silently (permissions, already-recycled pid, …).
    let mut gone = false;
    for _ in 0..25 {
        if !pid_alive(proc.pid) {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if !gone {
        return Err(format!(
            "process {} (pid {}) survived the force-kill{}",
            instance_id,
            proc.pid,
            if tree_killed { "" } else { " (tree-kill call failed)" }
        ));
    }

    // Own the teardown events for the forced path.
    let _ = crate::config::with_config_mut(app_handle, |cfg| {
        if let Some(instance) = cfg.servers.get_mut(instance_id) {
            instance.pid = None;
            instance.pid_started = None;
        }
        Ok(())
    });
    let marker = "[process terminated (killed)]";
    append_log(&proc.working_dir.join("latest.log"), marker.as_bytes());
    let _ = app_handle.emit(
        &format!("log:{instance_id}:stream"),
        format!("{} {}", timestamp(), marker),
    );
    let _ = app_handle.emit(
        &status_event,
        StatusPayload::Exited {
            code: None,
            forced: true,
        },
    );
    let _ = app_handle.emit("kern://running-set-changed", ());
    Ok(StopOutcome::Forced)
}

/// Force-kills a re-adopted (PID-only) process by OS pid and removes it from
/// the adopted registry. Used when the user stops a server that was re-adopted
/// from a previous session — there's no Child handle or stdin pipe, so graceful
/// shutdown is impossible; this is the only option. Emits the termination
/// events so the UI + tray sync.
pub fn force_kill_adopted(app_handle: &AppHandle, instance_id: &str) -> Result<(), String> {
    crate::watchdog::reset(app_handle, instance_id);
    // Read the pid without removing — `unadopt` (called below) does the removal
    // + emits kern://running-set-changed.
    let Some(pid) = pid_for(app_handle, instance_id) else {
        return Ok(()); // wasn't adopted — nothing to do
    };
    if !is_adopted(app_handle, instance_id) {
        return Ok(()); // owned, not adopted — not our path
    }

    // Kill the process tree by PID. Adopted processes have no Job Object, so
    // Windows falls back to taskkill /T and Unix signals the process group
    // (falling back to the single pid for pids adopted from older versions).
    #[cfg(target_os = "windows")]
    {
        let mut cmd = silent_command("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let _ = cmd.status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        if !signal_group(pid, libc::SIGKILL) {
            let _ = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
    }

    // Confirm death before claiming success.
    let mut gone = false;
    for _ in 0..25 {
        if !pid_alive(pid) {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if !gone {
        return Err(format!(
            "adopted process for '{instance_id}' (pid {pid}) survived the force-kill"
        ));
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
        StatusPayload::Exited {
            code: None,
            forced: true,
        },
    );
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

/// Whether an instance currently has a tracked running process — an owned
/// Child handle, a re-adopted PID-only monitor, or a start in flight.
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
    let adopted = registry
        .adopted
        .lock()
        .map(|m| m.contains_key(instance_id))
        .unwrap_or(true); // poisoned = assume running (fail safe)
    if adopted {
        return true;
    }
    registry
        .starting
        .lock()
        .map(|s| s.contains(instance_id))
        .unwrap_or(true)
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

#[cfg(test)]
mod tree_tests {
    use super::*;

    /// Polls until the pid disappears or ~5s elapses.
    fn wait_gone(pid: u32) -> bool {
        for _ in 0..25 {
            if !pid_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        false
    }

    /// Windows: the Job Object must terminate the whole tree, including a
    /// grandchild (the real-world case: cmd.exe wrapping java/node).
    #[cfg(windows)]
    #[test]
    fn job_object_kills_process_tree() {
        let mut cmd = silent_command("cmd.exe");
        // Outer cmd spawns an inner cmd which runs a long ping — a real
        // grandchild that a bare child.kill() would leave alive.
        cmd.args(["/C", "cmd.exe /C ping -n 120 127.0.0.1 > nul"]);
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        cmd.stdin(Stdio::null());
        let mut child = cmd.spawn().expect("spawn test process");
        let pid = child.id();
        let job = create_job_for(&child).expect("job object assignment");

        let _ = terminate_tree(pid, &Some(job));
        assert!(
            wait_gone(pid),
            "process tree survived TerminateJobObject"
        );
        let _ = child.wait(); // reap the direct child
    }

    /// Unix: signalling the child's process group must kill the whole tree.
    #[cfg(unix)]
    #[test]
    fn process_group_sigkill_kills_tree() {
        use std::os::unix::process::CommandExt;
        // silent-spawn-ok: unix test — console windows don't exist here.
        let mut cmd = Command::new("sh");
        // The shell forks a background sleep; both must die with the group.
        cmd.args(["-c", "sleep 120 & sleep 120"]);
        cmd.process_group(0);
        cmd.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null());
        let mut child = cmd.spawn().expect("spawn test process");
        let pid = child.id();

        assert!(signal_group(pid, libc::SIGKILL), "killpg failed");
        assert!(wait_gone(pid), "process group survived SIGKILL");
        let _ = child.wait(); // reap the direct child
    }

    /// A `start` at the beginning of any shell segment must be rewritten to
    /// `start /B` so it can't open a fresh console window. Pure string logic —
    /// exercised on every platform (Windows semantics, no OS calls).
    #[test]
    fn leading_start_is_neutralized() {
        assert_eq!(
            neutralize_start_commands("start server.bat"),
            "start /B server.bat"
        );
        assert_eq!(neutralize_start_commands("start"), "start /B");
        assert_eq!(
            neutralize_start_commands("  start /wait foo"),
            "  start /B /wait foo"
        );
        assert_eq!(neutralize_start_commands("start\tfoo"), "start /B\tfoo");
        assert_eq!(
            neutralize_start_commands("echo hi && start foo"),
            "echo hi && start /B foo"
        );
        assert_eq!(
            neutralize_start_commands("a || start b | start c"),
            "a || start /B b | start /B c"
        );
        assert_eq!(
            neutralize_start_commands("(start b)"),
            "(start /B b)"
        );
        // Untouched: quoted text, lookalike names, non-leading positions.
        assert_eq!(
            neutralize_start_commands("echo \"start foo\""),
            "echo \"start foo\""
        );
        assert_eq!(neutralize_start_commands("startswith foo"), "startswith foo");
        assert_eq!(neutralize_start_commands("start.bat"), "start.bat");
        assert_eq!(neutralize_start_commands("echo start foo"), "echo start foo");
    }

    /// Windows: the behavioral proof behind the "no console windows ever"
    /// guarantee — a child spawned through `silent_command` owns no top-level
    /// window at all, no matter the console subsystem it uses.
    #[cfg(windows)]
    #[test]
    fn silent_command_child_owns_no_window() {
        use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};

        struct Probe {
            pid: u32,
            found: bool,
        }

        extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let probe = unsafe { &mut *(lparam as *mut Probe) };
            let mut pid = 0u32;
            unsafe {
                GetWindowThreadProcessId(hwnd, &mut pid);
            }
            if pid == probe.pid {
                probe.found = true;
                return 0; // stop enumerating
            }
            1
        }

        let mut cmd = silent_command("cmd.exe");
        cmd.args(["/C", "ping -n 3 127.0.0.1 > nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().expect("spawn hidden child");
        let pid = child.id();
        // Give an (unwanted) console window time to materialize.
        std::thread::sleep(Duration::from_millis(600));

        let mut probe = Probe { pid, found: false };
        unsafe {
            EnumWindows(Some(visit), &mut probe as *mut Probe as LPARAM);
        }

        let _ = child.kill();
        let _ = child.wait();
        assert!(
            !probe.found,
            "silent child owned a top-level window (pid {pid})"
        );
    }
}
