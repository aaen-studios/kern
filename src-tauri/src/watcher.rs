//! Filesystem watcher — emits a Tauri event whenever a watched instance
//! directory changes, so the frontend file explorer can refresh in real time.
//!
//! Uses `notify-debouncer-mini` so a burst of writes from a running server
//! process collapses into a single coalesced event (otherwise a log append
//! would spam dozens of refreshes per second).
//!
//! Each instance root is watched recursively. Watches are keyed by instance id
//! and reference-counted per canonical path, so two instances sharing one
//! directory don't accidentally unwatch each other and directory-spelling
//! differences (`C:\x` vs `C:\x\`) map to a single underlying watch.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use notify_debouncer_mini::{
    notify::{RecursiveMode, RecommendedWatcher},
    DebouncedEvent, new_debouncer,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::command;

/// Global event name emitted on any watched filesystem change.
pub const FS_CHANGED_EVENT: &str = "server://fs-changed";

/// Payload for [`FS_CHANGED_EVENT`].
#[derive(Clone, Serialize)]
struct FsChanged {
    /// Absolute path of the file/dir that changed (best-effort from notify).
    path: String,
}

/// Holds the shared debouncer and the watch bookkeeping.
///
/// The debouncer owns its background thread; we keep it behind an `Option` so
/// it can be lazily started on the first `watch` call. Locks are always taken
/// in the order `debouncer → watched → refcounts`.
pub struct WatcherState {
    debouncer: Mutex<Option<notify_debouncer_mini::Debouncer<RecommendedWatcher>>>,
    /// instance id → canonical root currently watched for that instance.
    watched: Mutex<HashMap<String, PathBuf>>,
    /// canonical root → number of instances watching it.
    refcounts: Mutex<HashMap<PathBuf, usize>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            debouncer: Mutex::new(None),
            watched: Mutex::new(HashMap::new()),
            refcounts: Mutex::new(HashMap::new()),
        }
    }
}

/// Lazily creates the debouncer (if absent) and adds a recursive watch on the
/// instance root. Idempotent: re-watching an already-watched instance is a
/// no-op.
#[command]
pub fn watch_server_directory(
    app_handle: AppHandle,
    state: State<'_, WatcherState>,
    id: String,
) -> Result<(), String> {
    let cfg = crate::config::load_config(&app_handle)?;
    let instance = cfg
        .servers
        .get(&id)
        .ok_or_else(|| format!("server '{id}' not found"))?;
    let root = PathBuf::from(&instance.path);

    // Don't silently create a missing directory here — that would mask an
    // intentionally-deleted instance folder and resurrect it just because the
    // user opened the files tab. If the path is gone, surface the error so the
    // frontend can log it and the orphaned state stays honest.
    if !root.is_dir() {
        return Err(format!(
            "instance directory '{}' does not exist",
            root.display()
        ));
    }
    // Canonical key so spelling variants and symlinks share one watch.
    let canonical = root.canonicalize().unwrap_or(root);
    let handle = app_handle.clone();

    // 1. Lazily initialise the debouncer (lock released before bookkeeping so
    //    `release_path` can take it without deadlocking).
    {
        let mut debouncer_guard = state
            .debouncer
            .lock()
            .map_err(|e| format!("watcher lock poisoned: {e}"))?;
        if debouncer_guard.is_none() {
            let app_for_cb = handle.clone();
            let debouncer = new_debouncer(
                std::time::Duration::from_millis(300),
                move |res: Result<Vec<DebouncedEvent>, _>| {
                    let Ok(events) = res else { return };
                    if events.is_empty() { return }
                    // Emit once per debounced batch — the frontend ignores the
                    // specific path and just refreshes, so a single event
                    // suffices. We still send the first changed path for
                    // context/debugging.
                    let path = events
                        .first()
                        .and_then(|e| e.path.to_str())
                        .unwrap_or("")
                        .to_string();
                    let _ = app_for_cb.emit(FS_CHANGED_EVENT, FsChanged { path });
                },
            )
            .map_err(|e| format!("failed to create watcher: {e}"))?;
            *debouncer_guard = Some(debouncer);
        }
    }

    // 2. Replace a stale watch if the instance moved to a different path.
    let stale = {
        let watched = state
            .watched
            .lock()
            .map_err(|e| format!("watcher lock poisoned: {e}"))?;
        match watched.get(&id) {
            Some(existing) if *existing == canonical => return Ok(()), // already watching
            Some(existing) => Some(existing.clone()),
            None => None,
        }
    };
    if let Some(old) = stale {
        {
            let mut watched = state
                .watched
                .lock()
                .map_err(|e| format!("watcher lock poisoned: {e}"))?;
            watched.remove(&id);
        }
        release_path(&state, &old)?;
    }

    // 3. Add a reference to this path; the first holder installs the OS watch.
    let first_watch = {
        let mut refcounts = state
            .refcounts
            .lock()
            .map_err(|e| format!("watcher lock poisoned: {e}"))?;
        let count = refcounts.entry(canonical.clone()).or_insert(0);
        *count += 1;
        *count == 1
    };

    if first_watch {
        let mut debouncer_guard = state
            .debouncer
            .lock()
            .map_err(|e| format!("watcher lock poisoned: {e}"))?;
        let debouncer = debouncer_guard
            .as_mut()
            .ok_or_else(|| "watcher not initialised".to_string())?;
        if let Err(e) = debouncer
            .watcher()
            .watch(&canonical, RecursiveMode::Recursive)
        {
            // Roll back the refcount so a retry can succeed.
            drop(debouncer_guard);
            if let Ok(mut refs) = state.refcounts.lock() {
                if let Some(c) = refs.get_mut(&canonical) {
                    *c = c.saturating_sub(1);
                    if *c == 0 {
                        refs.remove(&canonical);
                    }
                }
            }
            return Err(format!("failed to watch '{}': {e}", canonical.display()));
        }
    }

    let mut watched = state
        .watched
        .lock()
        .map_err(|e| format!("watcher lock poisoned: {e}"))?;
    watched.insert(id, canonical);
    Ok(())
}

/// Drops one reference to `canonical`, unwatching the OS watcher at zero.
fn release_path(state: &State<'_, WatcherState>, canonical: &PathBuf) -> Result<(), String> {
    let should_unwatch = {
        let mut refcounts = state
            .refcounts
            .lock()
            .map_err(|e| format!("watcher lock poisoned: {e}"))?;
        let Some(count) = refcounts.get_mut(canonical) else {
            return Ok(());
        };
        *count = count.saturating_sub(1);
        if *count == 0 {
            refcounts.remove(canonical);
            true
        } else {
            false
        }
    };
    if should_unwatch {
        let mut debouncer_guard = state
            .debouncer
            .lock()
            .map_err(|e| format!("watcher lock poisoned: {e}"))?;
        if let Some(debouncer) = debouncer_guard.as_mut() {
            let _ = debouncer.watcher().unwatch(canonical);
        }
    }
    Ok(())
}

/// Removes the watch for the given instance. No-op if it wasn't watched.
#[command]
pub fn unwatch_server_directory(
    app_handle: AppHandle,
    state: State<'_, WatcherState>,
    id: String,
) -> Result<(), String> {
    // The instance may already be deleted (delete_server unwatches before it
    // removes the record), so a missing id is not an error — just clean up
    // whatever this id holds.
    let _ = app_handle;
    let canonical = {
        let watched = state.watched.lock().map_err(|e| format!("watcher lock poisoned: {e}"))?;
        watched.get(&id).cloned()
    };
    let Some(canonical) = canonical else {
        return Ok(());
    };
    {
        let mut watched = state.watched.lock().map_err(|e| format!("watcher lock poisoned: {e}"))?;
        watched.remove(&id);
    }
    release_path(&state, &canonical)
}

/// Non-command cleanup used by `delete_server`: drops the instance's watch
/// (and the OS watch when it was the last holder).
pub fn unwatch_instance(app_handle: &AppHandle, id: &str) {
    let state: State<'_, WatcherState> = app_handle.state();
    let canonical = {
        let Ok(watched) = state.watched.lock() else { return };
        watched.get(id).cloned()
    };
    let Some(canonical) = canonical else { return };
    if let Ok(mut watched) = state.watched.lock() {
        watched.remove(id);
    }
    let _ = release_path(&state, &canonical);
}
