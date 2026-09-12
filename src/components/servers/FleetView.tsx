/**
 * Fleet dashboard — a grid of every instance with live status, CPU/RAM, and
 * bulk lifecycle controls. Complements the per-server detail view for people
 * running several servers at once.
 */

import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerInstance } from "../../types/server";
import { useMetrics } from "../../hooks/useMetrics";
import { statusColor, statusHex } from "./status";
import { useToast } from "../../hooks/useToast";

interface FleetViewProps {
  servers: ServerInstance[];
  onSelect: (id: string) => void;
  /** Called after lifecycle actions so the registry reloads. */
  onRegistryChanged: () => void;
}

type Action = "start" | "stop" | "restart";

function commandFor(action: Action): string {
  return action === "start"
    ? "launch_server_instance"
    : action === "stop"
      ? "stop_server_instance"
      : "restart_server_instance";
}

function isRunning(server: ServerInstance): boolean {
  return server.status === "running" || server.status === "stopping";
}

export function FleetView({ servers, onSelect, onRegistryChanged }: FleetViewProps) {
  const { notify } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkStop, setConfirmBulkStop] = useState(false);

  const runningCount = servers.filter(isRunning).length;

  const runOne = useCallback(
    async (server: ServerInstance, action: Action, quiet = false) => {
      setBusyId(server.id);
      try {
        await invoke(commandFor(action), { id: server.id });
        if (!quiet) {
          notify({ kind: "success", title: `${server.name}: ${action} requested` });
        }
      } catch (e) {
        notify({
          kind: "error",
          title: `${server.name}: ${action} failed`,
          message: String(e),
        });
      } finally {
        setBusyId(null);
      }
    },
    [notify],
  );

  const runBulk = useCallback(
    async (action: Action) => {
      const targets =
        action === "start"
          ? servers.filter((s) => !isRunning(s) && !s.isOrphaned)
          : servers.filter(isRunning);
      if (targets.length === 0) {
        notify({ kind: "info", title: `nothing to ${action}` });
        return;
      }
      setBulkBusy(true);
      setConfirmBulkStop(false);
      for (const server of targets) {
        await runOne(server, action, true);
      }
      setBulkBusy(false);
      notify({
        kind: "success",
        title: `${action} requested for ${targets.length} instance${targets.length === 1 ? "" : "s"}`,
      });
      onRegistryChanged();
    },
    [servers, runOne, notify, onRegistryChanged],
  );

  // Group cards by the same folders the sidebar uses.
  const groups = useMemo(() => {
    const map = new Map<string, ServerInstance[]>();
    for (const server of servers) {
      const key = server.group?.trim() || "";
      const list = map.get(key);
      if (list) list.push(server);
      else map.set(key, [server]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    });
  }, [servers]);

  const hasGroups = servers.some((s) => (s.group ?? "").trim().length > 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
            fleet{" "}
            <span className="text-zinc-600 tabular-nums">
              ({runningCount}/{servers.length} running)
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void runBulk("start")}
              disabled={bulkBusy || servers.length === 0}
              className="btn-mono disabled:opacity-40 disabled:cursor-not-allowed"
            >
              start all
            </button>
            <button
              onClick={() => void runBulk("restart")}
              disabled={bulkBusy || runningCount === 0}
              className="btn-mono disabled:opacity-40 disabled:cursor-not-allowed"
            >
              restart all
            </button>
            {confirmBulkStop ? (
              <>
                <button
                  onClick={() => void runBulk("stop")}
                  disabled={bulkBusy}
                  className="btn-mono text-fault-vector"
                >
                  confirm stop all
                </button>
                <button
                  onClick={() => setConfirmBulkStop(false)}
                  className="btn-mono"
                >
                  cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmBulkStop(true)}
                disabled={bulkBusy || runningCount === 0}
                className="btn-mono disabled:opacity-40 disabled:cursor-not-allowed"
              >
                stop all
              </button>
            )}
          </div>
        </div>

        {servers.length === 0 && (
          <p className="text-[11px] text-zinc-600">
            no instances registered — add one from the sidebar.
          </p>
        )}

        {groups.map(([group, list]) => (
          <section key={`group:${group}`}>
            {hasGroups && (
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-600 mb-2">
                {group || "ungrouped"}
              </h3>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {list.map((server) => (
                <FleetCard
                  key={server.id}
                  server={server}
                  busy={busyId === server.id || bulkBusy}
                  onSelect={() => onSelect(server.id)}
                  onAction={(action) => void runOne(server, action)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function FleetCard({
  server,
  busy,
  onSelect,
  onAction,
}: {
  server: ServerInstance;
  busy: boolean;
  onSelect: () => void;
  onAction: (action: Action) => void;
}) {
  const metrics = useMetrics(server.id);
  const running = isRunning(server);
  const dot = statusHex(statusColor(server));

  return (
    <div className="border border-grid-bounds bg-bg-surface flex flex-col">
      <button
        onClick={onSelect}
        className="text-left px-3 py-2 border-b border-grid-bounds hover:bg-bg-core transition-colors"
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: dot, boxShadow: `0 0 4px ${dot}` }}
          />
          <span className="text-xs text-zinc-100 truncate flex-1 min-w-0">
            {server.name}
          </span>
          {server.isOrphaned && (
            <span className="text-[9px] text-fault-vector uppercase">orphan</span>
          )}
        </div>
        <div className="mt-0.5 text-[10px] text-zinc-600 font-mono truncate">
          {server.serverType}
          {server.tags && server.tags.length > 0
            ? ` · ${server.tags.join(" ")}`
            : ""}
        </div>
      </button>

      <div className="px-3 py-2 space-y-1.5 flex-1">
        <Meter label="cpu" value={running ? metrics.cpu : 0} color="#4cf5a0" />
        <Meter label="ram" value={running ? metrics.ram : 0} color="#f5a04c" />
        <div className="text-[10px] text-zinc-600 font-mono truncate" title={server.path}>
          {server.status}
        </div>
      </div>

      <div className="flex border-t border-grid-bounds">
        {running ? (
          <>
            <button
              onClick={() => onAction("restart")}
              disabled={busy}
              className="flex-1 py-1.5 text-[11px] text-zinc-300 hover:bg-bg-core border-r border-grid-bounds disabled:opacity-40"
            >
              restart
            </button>
            <button
              onClick={() => onAction("stop")}
              disabled={busy}
              className="flex-1 py-1.5 text-[11px] text-fault-vector hover:bg-bg-core disabled:opacity-40"
            >
              stop
            </button>
          </>
        ) : (
          <button
            onClick={() => onAction("start")}
            disabled={busy || server.isOrphaned}
            className="flex-1 py-1.5 text-[11px] text-signal-high hover:bg-bg-core disabled:opacity-40 disabled:cursor-not-allowed"
          >
            start
          </button>
        )}
      </div>
    </div>
  );
}

function Meter({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 text-[9px] uppercase text-zinc-600">{label}</span>
      <span className="flex-1 h-1 bg-bg-core border border-grid-bounds overflow-hidden">
        <span
          className="block h-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
      <span className="w-8 text-right text-[9px] text-zinc-600 tabular-nums">
        {Math.round(pct)}%
      </span>
    </div>
  );
}
