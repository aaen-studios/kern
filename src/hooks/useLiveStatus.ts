import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ServerStatus } from "../types/server";

/**
 * Global live-status overlay.
 *
 * Problem this solves: the sidebar and main list read `server.status` from the
 * persisted config document, which is only refreshed on explicit `reload()`.
 * Process state changes fire asynchronously (`status:<id>` events) and the
 * persisted write races the reload — so the sidebar got stuck showing "stopped"
 * while a process was actually running, and only corrected on exit.
 *
 * Fix: subscribe once (at the app root) to the wildcard-ish `status:<id>`
 * channel for every instance id, hold a live status map, and persist the new
 * status so the next cold load is correct. Components merge this map over the
 * persisted list: live status wins when present.
 *
 * Mirrors StatusPayload in src-tauri/src/process.rs.
 */
type StatusPayload =
  | { state: "running" }
  | { state: "stopping" }
  | { state: "exited"; code: number | null; forced?: boolean };

/** Map of instanceId → live status. */
export type LiveStatusMap = Record<string, ServerStatus>;
/** Set of instance ids that are re-adopted PID-only monitors (no graceful stop). */
export type LiveAdoptedSet = Set<string>;

/** Wildcard pattern prefix used for status events. */
const STATUS_EVENT_PREFIX = "status:";

interface UseLiveStatusResult {
  /** Live status per instance id, overlaid on persisted status. */
  liveStatus: LiveStatusMap;
  /** Ids of re-adopted (PID-only) processes — surfaced as a distinct badge. */
  liveAdopted: LiveAdoptedSet;
}

/**
 * Subscribes to `status:<id>` events for every id in `ids` and returns a live
 * status map. Also persists transitions so a restart of the app reflects the
 * last known state. Meant to be mounted once at the app root.
 */
export function useLiveStatus(ids: string[]): UseLiveStatusResult {
  const [liveStatus, setLiveStatus] = useState<LiveStatusMap>({});
  const [liveAdopted, setLiveAdopted] = useState<LiveAdoptedSet>(new Set());

  useEffect(() => {
    if (ids.length === 0) return;
    let disposed = false;
    const unlistens: UnlistenFn[] = [];

    (async () => {
      // Seed the adopted set once from the running-servers list, so re-adopted
      // processes (from a previous session) are badged immediately on open.
      try {
        const running = await invoke<Array<{ id: string; adopted: boolean }>>(
          "list_running_servers",
        );
        if (!disposed) {
          setLiveAdopted(new Set(running.filter((r) => r.adopted).map((r) => r.id)));
        }
      } catch { /* non-fatal */ }

      for (const id of ids) {
        try {
          // Seed from the actual process registry: if a process is already
          // running when the app (re)opens — e.g. after a crash/restart while
          // the persisted doc still says "stopped" — correct the overlay now
          // rather than waiting for the next status event.
          try {
            const isRunning = await invoke<boolean>("is_server_running", { id });
            if (isRunning) setLiveStatus((prev) => ({ ...prev, [id]: "running" }));
          } catch { /* non-fatal seed */ }

          const un = await listen<StatusPayload>(`${STATUS_EVENT_PREFIX}${id}`, (event) => {
            if (disposed) return;
            const payload = event.payload;
            if (payload.state === "running") {
              setLiveStatus((prev) => ({ ...prev, [id]: "running" }));
              void invoke("update_server_status", { id, status: "running" });
            } else if (payload.state === "stopping") {
              // Graceful phase in progress — keep the process listed as running
              // until it actually exits, but surface the transitional status.
              setLiveStatus((prev) => ({ ...prev, [id]: "stopping" }));
              void invoke("update_server_status", { id, status: "stopping" });
            } else {
              // exited — map exit code to stopped/error and persist. A forced
              // kill is a deliberate user action, not a crash.
              const next: ServerStatus = payload.forced
                ? "stopped-forced"
                : payload.code != null && payload.code !== 0
                  ? "error"
                  : "stopped";
              setLiveStatus((prev) => ({ ...prev, [id]: next }));
              setLiveAdopted((prev) => {
                if (!prev.has(id)) return prev;
                const n = new Set(prev);
                n.delete(id);
                return n;
              });
              void invoke("update_server_status", { id, status: next });
            }
          });
          if (disposed) {
            un();
            return;
          }
          unlistens.push(un);
        } catch {
          // Subscription failure is non-fatal — persisted status still loads.
        }
      }
    })();

    return () => {
      disposed = true;
      unlistens.forEach((un) => un());
    };
  }, [ids.join(",")]); // re-subscribe when the set of ids changes

  return { liveStatus, liveAdopted };
}
