import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PreflightReport } from "../types/server";

/**
 * Process lifecycle + live log streaming for a single server instance.
 *
 * Spec: ArchitecturePlan §5 (Phase 2) — the Rust core streams stdout/stderr
 * line-by-line over a `log:<id>:stream` event and emits a structured
 * `StatusPayload` over `status:<id>` on state transitions. This hook seeds the
 * buffer from `get_log_tail`, then appends each streamed line as it arrives.
 *
 * Phase 4 extension: supports install, restart, and arbitrary lifecycle steps.
 * When a process exits, persisted status is synced to "stopped" or "error"
 * depending on the exit code.
 */

/** Mirrors StatusPayload in src-tauri/src/process.rs. */
type StatusPayload =
  | { state: "running" }
  | { state: "stopping" }
  | { state: "exited"; code: number | null; forced?: boolean };

/** Max lines held in memory before older entries are trimmed. */
const MAX_LINES = 2000;

/**
 * Monotonically increasing subscription generation. Bumped every time the
 * log/status subscription effect (re)starts; each callback captures the value
 * at attach time and no-ops if a newer generation has since taken over. This
 * prevents double-rendering when the effect fires twice before the first async
 * `listen` resolves (React StrictMode, fast remounts, page refresh).
 */
let subscriptionGen = 0;

/** Formats the current wall-clock time as `[HH:MM:SS]` — mirrors the Rust backend's `process::timestamp()`. */
function timestamp(): string {
  const now = new Date();
  const p = (n: number) => n.toString().padStart(2, "0");
  return `[${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}]`;
}

// Mirrors the Rust side's check so we never double-stamp a line that arrived
// with a timestamp already attached (e.g. an emulated console that prints its
// own). Liberal on purpose — false positives just mean we skip a redundant
// prefix that wasn't going to be needed.
const HAS_TIMESTAMP_RE =
  /^\s*\[?\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(?:[AP]M?)?\]?\s*/i;

function hasTimestamp(line: string): boolean {
  return HAS_TIMESTAMP_RE.test(line);
}

interface UseServerControlResult {
  logs: string[];
  running: boolean;
  /** True while a graceful stop is in progress (process still alive). */
  stopping: boolean;
  launching: boolean;
  /** True while a non-start lifecycle step (install, build, etc.) is running. */
  busy: boolean;
  /** Launch the instance's start lifecycle step. */
  launch: () => Promise<void>;
  /** Terminate the instance. Idempotent. */
  stop: () => Promise<void>;
  /** Run the "install" lifecycle step (e.g. npm install, cargo build). Resolves
   *  true on success so callers can gate the `.installed` marker. */
  install: () => Promise<boolean>;
  /** Restart a running instance (stop then start). */
  restart: () => Promise<void>;
  /** Run an arbitrary lifecycle step by name. */
  runStep: (stepName: string) => Promise<void>;
  /** Append a line directly to the local log buffer (for local echo, etc.). */
  pushLine: (line: string) => void;
  error: string | null;
  /**
   * Set when a launch/restart found actionable issues (port conflicts, a
   * pending EULA). Render a confirm dialog from it, then call
   * `confirmPreflight` or `cancelPreflight`.
   */
  preflight: { action: "launch" | "restart"; report: PreflightReport } | null;
  confirmPreflight: () => Promise<void>;
  cancelPreflight: () => void;
}

export function useServerControl(
  serverId: string | null,
  onChange?: () => void,
): UseServerControlResult {
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [busy, setBusy] = useState(false); // non-start step in progress
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<{
    action: "launch" | "restart";
    report: PreflightReport;
  } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Log lines are buffered and flushed on a short cadence instead of calling
  // setState per line. A chatty server can emit hundreds of lines per second;
  // a single state append every 100ms keeps rendering bounded while still
  // feeling live.
  const bufferedLinesRef = useRef<string[]>([]);
  const flushTimerRef = useRef<number | null>(null);

  const flushBufferedLines = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const batch = bufferedLinesRef.current;
    if (batch.length === 0) return;
    bufferedLinesRef.current = [];
    setLogs((prev) => {
      const next = [...prev, ...batch];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  // Seed the log buffer + running state whenever the selected server changes.
  useEffect(() => {
    let cancelled = false;
    setLogs([]);
    setError(null);
    setStopping(false);
    if (!serverId) {
      setRunning(false);
      return;
    }
    (async () => {
      try {
        const [tail, isRunning] = await Promise.all([
          invoke<string[]>("get_log_tail", { id: serverId, maxLines: 500 }),
          invoke<boolean>("is_server_running", { id: serverId }),
        ]);
        if (cancelled) return;
        // Merge the historical tail *before* any line that already streamed in
        // while this async load was in flight — a plain setLogs(tail) would
        // clobber a live line that beat the seed.
        setLogs((prev) => (prev.length ? [...tail, ...prev] : tail));
        setRunning(isRunning);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serverId]);

  // Subscribe to the live log + status streams for this instance.
  //
  // Generation guard: this effect spins up an async IIFE that awaits the two
  // `listen` calls. Under React StrictMode (and on fast remounts / page
  // refresh), the effect can run twice before the first IIFE resolves — which
  // would attach two live listeners and render every streamed line twice. We
  // bump a generation counter on each (re)entry and capture it in a ref; each
  // callback checks the ref and no-ops if a newer subscription has since taken
  // over. The cleanup then unsubscribes whichever listener actually landed.
  useEffect(() => {
    if (!serverId) return;
    const gen = ++subscriptionGen;
    // Track whether this effect cycle was cleaned up before its async listen()
    // calls resolved. Under React StrictMode the effect fires twice on mount;
    // without this guard the first cycle's listeners attach *after* its own
    // cleanup ran, so they'd never be unlistened and would leak (silently, but
    // still). If we detect that, we drop the just-resolved listener right away.
    let disposed = false;
    let unlistenLog: UnlistenFn | undefined;
    let unlistenStatus: UnlistenFn | undefined;

    (async () => {
      try {
        const logUnlisten = await listen<string>(`log:${serverId}:stream`, (event) => {
          // Ignore events from a subscription a newer effect cycle has superseded.
          if (subscriptionGen !== gen) return;
          bufferedLinesRef.current.push(event.payload);
          if (flushTimerRef.current === null) {
            flushTimerRef.current = window.setTimeout(flushBufferedLines, 100);
          }
        });
        if (disposed) {
          // Effect already cleaned up before this listener resolved — detach it.
          logUnlisten();
          return;
        }
        unlistenLog = logUnlisten;

        const statusUnlisten = await listen<StatusPayload>(`status:${serverId}`, (event) => {
          if (subscriptionGen !== gen) return;
          const payload = event.payload;
          if (payload.state === "running") {
            setRunning(true);
            setStopping(false);
            setBusy(false);
          } else if (payload.state === "stopping") {
            // Graceful phase in progress — the process is still alive.
            setStopping(true);
          } else {
            // exited — sync persisted status so the sidebar matches reality.
            setRunning(false);
            setStopping(false);
            setBusy(false);
            const newStatus = payload.forced
              ? "stopped-forced"
              : payload.code != null && payload.code !== 0
                ? "error"
                : "stopped";
            void invoke("update_server_status", { id: serverId, status: newStatus });
          }
          onChangeRef.current?.();
        });
        if (disposed) {
          statusUnlisten();
          return;
        }
        unlistenStatus = statusUnlisten;
      } catch (e) {
        // A listener failure would otherwise die as an unhandled rejection and
        // streaming would silently stop forever. Surface it instead.
        console.error("[useServerControl] failed to attach stream listeners:", e);
        setError(`Failed to subscribe to live output: ${String(e)}`);
      }
    })();

    return () => {
      disposed = true;
      unlistenLog?.();
      unlistenStatus?.();
      // Discard buffered lines from the previous server — the next view
      // re-seeds from the on-disk tail, and flushing here would pollute it.
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      bufferedLinesRef.current = [];
    };
  }, [serverId, flushBufferedLines]);

  const doLaunch = useCallback(async () => {
    if (!serverId || launching) return;
    setLaunching(true);
    setError(null);
    try {
      await invoke("launch_server_instance", { id: serverId });
      setRunning(true);
      onChangeRef.current?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLaunching(false);
    }
  }, [serverId, launching]);

  /**
   * Advisory pre-start checks: ports the instance used last time now held by
   * another process, and a pending Minecraft EULA. A failed check never blocks
   * the start — only a positive finding opens the confirm dialog.
   */
  const runPreflight = useCallback(
    async (action: "launch" | "restart"): Promise<boolean> => {
      if (!serverId) return true;
      try {
        const report = await invoke<PreflightReport>("preflight_launch", { id: serverId });
        if (report.conflicts.length > 0 || report.eulaPending) {
          setPreflight({ action, report });
          return false;
        }
      } catch {
        // Advisory only.
      }
      return true;
    },
    [serverId],
  );

  const launch = useCallback(async () => {
    if (!serverId || launching) return;
    if (!(await runPreflight("launch"))) return;
    await doLaunch();
  }, [serverId, launching, runPreflight, doLaunch]);

  const doRestart = useCallback(async () => {
    if (!serverId || launching) return;
    setLaunching(true);
    setError(null);
    try {
      await invoke("restart_server_instance", { id: serverId });
      setRunning(true);
      onChangeRef.current?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLaunching(false);
    }
  }, [serverId, launching]);

  const restart = useCallback(async () => {
    if (!serverId || launching) return;
    if (!(await runPreflight("restart"))) return;
    await doRestart();
  }, [serverId, launching, runPreflight, doRestart]);

  const cancelPreflight = useCallback(() => setPreflight(null), []);

  const confirmPreflight = useCallback(async () => {
    const pending = preflight;
    if (!pending || !serverId) return;
    setPreflight(null);
    if (pending.report.eulaPending) {
      try {
        await invoke("write_server_file", {
          id: serverId,
          relPath: "eula.txt",
          content: "eula=true\n",
          expectedMtime: null,
        });
      } catch (e) {
        setError(`Could not accept the EULA: ${String(e)}`);
        return;
      }
    }
    if (pending.action === "launch") {
      await doLaunch();
    } else {
      await doRestart();
    }
  }, [preflight, serverId, doLaunch, doRestart]);

  const stop = useCallback(async () => {
    if (!serverId) return;
    setError(null);
    try {
      await invoke("stop_server_instance", { id: serverId });
      // Stop runs async in background; the status event will set running=false.
    } catch (e) {
      setError(String(e));
    }
  }, [serverId]);

  const install = useCallback(async (): Promise<boolean> => {
    if (!serverId || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await invoke("install_server_instance", { id: serverId });
      onChangeRef.current?.();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [serverId, busy]);

  const runStep = useCallback(async (stepName: string) => {
    if (!serverId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("run_lifecycle_step", { id: serverId, stepName });
      onChangeRef.current?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [serverId, busy]);

  // Append a line directly to the local log buffer without going through the
  // streaming event — used to echo user-typed commands back into the terminal.
  // Prefixed with a timestamp so local-echo lines match streamed ones.
  const pushLine = useCallback((line: string) => {
    // Only stamp if the line doesn't already carry a timestamp — stdout that
    // emulates a console often prefixes its own `[HH:MM:SS]`.
    const stamped = hasTimestamp(line) ? line : `${timestamp()} ${line}`;
    setLogs((prev) =>
      prev.length >= MAX_LINES
        ? [...prev.slice(1), stamped]
        : [...prev, stamped],
    );
  }, []);

  return {
    logs,
    running,
    stopping,
    launching,
    busy,
    launch,
    stop,
    install,
    restart,
    runStep,
    pushLine,
    error,
    preflight,
    confirmPreflight,
    cancelPreflight,
  };
}
