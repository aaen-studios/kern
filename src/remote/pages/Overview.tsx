import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtUptime, statusDotClass } from "../lib/format";
import { navigate } from "../lib/router";
import { can, canServer } from "../lib/roles";
import { useServers } from "../lib/servers";
import { useToast } from "../lib/toast";
import type { AuthUser, HostStatus, ServerSummary } from "../lib/types";

export function Overview({ user }: { user: AuthUser }) {
  const { servers, loading, refresh } = useServers();
  const { push } = useToast();
  const [host, setHost] = useState<HostStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const data = await api<HostStatus>("/status");
        if (!disposed) setHost(data);
      } catch {
        /* transient */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const running = servers.filter((server) => server.running).length;

  async function act(server: ServerSummary, action: string) {
    try {
      await api(`/servers/${encodeURIComponent(server.id)}/${action}`, { method: "POST" });
      push(`${server.name}: ${action} requested`, action === "stop" ? "warn" : "success");
      window.setTimeout(() => void refresh(), 900);
    } catch (err) {
      push(err instanceof Error ? err.message : "action failed", "error");
    }
  }

  const groups = new Map<string, ServerSummary[]>();
  for (const server of servers) {
    const key = server.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), server]);
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <h1 className="font-mono text-sm uppercase tracking-[0.2em] text-zinc-100">overview</h1>
        {user.role === "admin" && (
          <button
            onClick={() => navigate("/new")}
            className="ml-auto border border-signal-high/40 px-3 py-1 font-mono text-[11px] lowercase text-signal-high"
          >
            + new instance
          </button>
        )}
      </div>
      <p className="mt-1 font-mono text-[11px] text-zinc-500">
        {running}/{servers.length} running
        {host
          ? ` · host cpu ${Math.round((host.host.cpu || 0) * 100)}% · ram ${Math.round(
              (host.host.ram || 0) * 100,
            )}%`
          : ""}
      </p>

      {loading && servers.length === 0 ? (
        <p className="mt-8 font-mono text-xs text-zinc-600">loading instances…</p>
      ) : servers.length === 0 ? (
        <p className="mt-8 font-mono text-xs text-zinc-600">
          no instances registered yet. create one in the kern desktop app.
        </p>
      ) : (
        [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, list]) => (
            <section key={group || "ungrouped"} className="mt-6">
              {group && (
                <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                  {group}
                </h2>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    user={user}
                    onAction={act}
                  />
                ))}
              </div>
            </section>
          ))
      )}
    </div>
  );
}

function ServerCard({
  server,
  user,
  onAction,
}: {
  server: ServerSummary;
  user: AuthUser;
  onAction: (server: ServerSummary, action: string) => void;
}) {
  const cpu = Math.round(((server.metrics?.cpu ?? 0) || 0) * 100);
  const ram = Math.round(((server.metrics?.ram ?? 0) || 0) * 100);
  const allowed = can(user, "control") && canServer(user, server.id);

  return (
    <div className="border border-grid-bounds bg-bg-surface">
      <button
        onClick={() => navigate(`/s/${encodeURIComponent(server.id)}/console`)}
        className="w-full border-b border-grid-bounds px-3 py-2.5 text-left hover:bg-bg-core"
      >
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(server.status)}`} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-100">
            {server.name}
          </span>
          <span
            className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] ${
              server.orphaned
                ? "border-fault-vector/40 text-fault-vector"
                : "border-grid-bounds text-zinc-500"
            }`}
          >
            {server.orphaned ? "orphan" : server.status}
          </span>
        </div>
        <div className="mt-1 font-mono text-[10px] text-zinc-600">
          {server.type}
          {server.uptimeSecs ? ` · up ${fmtUptime(server.uptimeSecs)}` : ""}
        </div>
      </button>

      <div className="space-y-1.5 px-3 py-2">
        <Meter label="cpu" value={cpu} tone="bg-signal-high" />
        <Meter label="ram" value={ram} tone="bg-warn-vector" />
      </div>

      {allowed && (
        <div className="flex border-t border-grid-bounds">
          {server.running ? (
            <>
              <button
                onClick={() => onAction(server, "restart")}
                className="flex-1 border-r border-grid-bounds py-1.5 font-mono text-[11px] lowercase text-zinc-300 hover:bg-bg-core"
              >
                restart
              </button>
              <button
                onClick={() => onAction(server, "stop")}
                className="flex-1 py-1.5 font-mono text-[11px] lowercase text-fault-vector hover:bg-bg-core"
              >
                stop
              </button>
            </>
          ) : (
            <button
              onClick={() => onAction(server, "start")}
              disabled={server.orphaned}
              className="flex-1 py-1.5 font-mono text-[11px] lowercase text-signal-high hover:bg-bg-core disabled:opacity-40"
            >
              start
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Meter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-zinc-600">
        {label} {value}%
      </div>
      <div className="mt-1 h-1 bg-grid-bounds">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}
