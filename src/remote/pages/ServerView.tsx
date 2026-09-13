import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, apiRaw } from "../lib/api";
import { fmtAgo, fmtBytes, fmtUptime, statusDotClass } from "../lib/format";
import { navigate } from "../lib/router";
import { can, canServer } from "../lib/roles";
import { useServers } from "../lib/servers";
import { downloadInstanceFile, useSse } from "../lib/sse";
import { useToast } from "../lib/toast";
import type {
  AuthUser,
  Backup,
  BackupSchedule,
  MetricSample,
  RconPlayers,
  ServerSummary,
  Task,
} from "../lib/types";

const FilesFeature = lazy(() =>
  import("../features/files/FilesFeature").then((module) => ({
    default: module.FilesFeature,
  })),
);

const InstanceForm = lazy(() =>
  import("../features/instances/InstanceForm").then((module) => ({
    default: module.InstanceForm,
  })),
);

const TABS = ["console", "metrics", "files", "backups", "tasks"];

export function ServerView({
  id,
  tab,
  user,
}: {
  id: string;
  tab: string;
  user: AuthUser;
}) {
  const { servers, refresh } = useServers();
  const { push } = useToast();
  const server = servers.find((entry) => entry.id === id);
  const tabs = can(user, "admin") ? [...TABS, "settings"] : [...TABS];
  const active = tabs.includes(tab) ? tab : "console";
  const allowed = !!server && can(user, "control") && canServer(user, server.id);

  if (!server) {
    return (
      <div>
        <button onClick={() => navigate("/overview")} className="font-mono text-xs text-signal-high">
          ← overview
        </button>
        <p className="mt-6 font-mono text-xs text-zinc-600">instance not found.</p>
      </div>
    );
  }

  async function act(action: string) {
    if (!server) return;
    try {
      await api(`/servers/${encodeURIComponent(server.id)}/${action}`, { method: "POST" });
      push(`${action} requested`, action === "stop" ? "warn" : "success");
      window.setTimeout(() => void refresh(), 900);
    } catch (err) {
      push(err instanceof Error ? err.message : "action failed", "error");
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <button
        onClick={() => navigate("/overview")}
        className="self-start font-mono text-[11px] lowercase text-zinc-500 hover:text-zinc-200"
      >
        ← overview
      </button>

      <header className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`h-2 w-2 rounded-full ${statusDotClass(server.status)}`} />
        <h1 className="font-mono text-sm lowercase text-zinc-100">{server.name}</h1>
        <span className="border border-grid-bounds px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
          {server.status}
        </span>
        {server.orphaned && (
          <span className="border border-fault-vector/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-fault-vector">
            orphan
          </span>
        )}
        <span className="font-mono text-[11px] text-zinc-600">
          {server.type}
          {server.uptimeSecs ? ` · up ${fmtUptime(server.uptimeSecs)}` : ""}
        </span>
        <span className="ml-auto flex gap-1.5">
          {can(user, "admin") && !server.running && (
            <button
              onClick={() => void act("install")}
              className="border border-grid-bounds px-3 py-1 font-mono text-[11px] lowercase text-zinc-300 hover:bg-bg-surface"
            >
              install
            </button>
          )}
          {allowed && !server.running && (
            <button
              onClick={() => void act("start")}
              className="border border-signal-high/40 px-3 py-1 font-mono text-[11px] lowercase text-signal-high hover:bg-signal-high/10"
            >
              start
            </button>
          )}
          {allowed && server.running && (
            <>
              <button
                onClick={() => void act("restart")}
                className="border border-grid-bounds px-3 py-1 font-mono text-[11px] lowercase text-zinc-300 hover:bg-bg-surface"
              >
                restart
              </button>
              <button
                onClick={() => void act("stop")}
                className="border border-fault-vector/40 px-3 py-1 font-mono text-[11px] lowercase text-fault-vector hover:bg-fault-vector/10"
              >
                stop
              </button>
            </>
          )}
        </span>
      </header>

      <nav className="mt-4 flex flex-wrap gap-1 border-b border-grid-bounds">
        {tabs.map((item) => (
          <button
            key={item}
            onClick={() => navigate(`/s/${encodeURIComponent(server.id)}/${item}`)}
            className={`-mb-px border-b-2 px-3 py-2 font-mono text-[11px] lowercase ${
              active === item
                ? "border-signal-high text-signal-high"
                : "border-transparent text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {item}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 pt-4">
        {active === "console" && <ConsoleTab server={server} allowed={allowed} />}
        {active === "metrics" && <MetricsTab server={server} />}
        {active === "files" && (
          <Suspense
            fallback={
              <p className="py-8 text-center font-mono text-[11px] text-zinc-600">
                loading editor…
              </p>
            }
          >
            <FilesFeature serverId={server.id} allowed={allowed} />
          </Suspense>
        )}
        {active === "backups" && <BackupsTab server={server} allowed={allowed} />}
        {active === "tasks" && <TasksTab server={server} allowed={allowed} />}
        {active === "settings" && (
          <Suspense
            fallback={
              <p className="py-8 text-center font-mono text-[11px] text-zinc-600">loading…</p>
            }
          >
            <InstanceForm
              serverId={server.id}
              onDone={(nextId) => {
                if (nextId) {
                  void refresh();
                } else {
                  navigate("/overview");
                }
              }}
              onCancel={() => navigate(`/s/${encodeURIComponent(server.id)}/console`)}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/* ── console ─────────────────────────────────────────────────────────── */

function ansiClass(line: string): string {
  if (/\[(ERROR|FATAL)\]/i.test(line)) return "text-fault-vector";
  if (/\[(WARN|WARNING)\]/i.test(line)) return "text-warn-vector";
  if (/\[(INFO)\]/i.test(line)) return "text-signal-high";
  return "text-zinc-300";
}

function ConsoleTab({ server, allowed }: { server: ServerSummary; allowed: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const { push } = useToast();
  const [snippets, setSnippets] = useState<string[]>([]);
  const [players, setPlayers] = useState<string[] | null>(null);
  const [playersError, setPlayersError] = useState("");

  useEffect(() => {
    void api<string[]>(`/servers/${encodeURIComponent(server.id)}/snippets`)
      .then((list) => setSnippets(list ?? []))
      .catch(() => setSnippets([]));
  }, [server.id]);

  const status = useSse(`/servers/${encodeURIComponent(server.id)}/console`, (event, data) => {
    if (event === "tail" || event === "log") {
      const payload = data as { lines?: string[] };
      setLines((prev) => [...prev, ...(payload.lines ?? [])].slice(-4000));
    } else if (event === "reset") {
      setLines((prev) => [...prev, "— log rotated —"]);
    }
  });

  useEffect(() => {
    if (!autoscroll || !boxRef.current) return;
    boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, autoscroll]);

  async function sendLine(line: string) {
    try {
      await api(`/servers/${encodeURIComponent(server.id)}/stdin`, { json: { line } });
    } catch (err) {
      push(err instanceof Error ? err.message : "send failed", "error");
    }
  }

  async function send() {
    const line = draft.trim();
    if (!line) return;
    setDraft("");
    setHistory((prev) => [...prev, line]);
    setHistoryIndex(-1);
    await sendLine(line);
  }

  async function downloadLog() {
    try {
      const res = await apiRaw(`/servers/${encodeURIComponent(server.id)}/log/download`);
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${server.name}-latest.log`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    } catch (err) {
      push(err instanceof Error ? err.message : "download failed", "error");
    }
  }

  async function loadPlayers() {
    setPlayersError("");
    try {
      const data = await api<RconPlayers>(`/servers/${encodeURIComponent(server.id)}/players`);
      setPlayers(data.players ?? []);
    } catch (err) {
      setPlayers(null);
      setPlayersError(err instanceof Error ? err.message : "rcon unavailable");
    }
  }

  const visible = useMemo(
    () => (filter ? lines.filter((line) => line.toLowerCase().includes(filter.toLowerCase())) : lines),
    [lines, filter],
  );

  return (
    <div className="flex h-[calc(100dvh-16rem)] min-h-[320px] flex-col border border-grid-bounds bg-black">
      <div className="flex items-center gap-2 border-b border-grid-bounds px-2 py-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="w-40 border border-grid-bounds bg-bg-core px-2 py-1 font-mono text-[11px] text-zinc-200"
        />
        <button
          onClick={() => setAutoscroll((value) => !value)}
          className={`border px-2 py-1 font-mono text-[10px] lowercase ${
            autoscroll ? "border-signal-high/40 text-signal-high" : "border-grid-bounds text-zinc-500"
          }`}
        >
          autoscroll
        </button>
        <button
          onClick={() => setLines([])}
          className="border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-500 hover:text-zinc-300"
        >
          clear
        </button>
        <button
          onClick={() => void downloadLog()}
          className="border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-500 hover:text-zinc-300"
        >
          download
        </button>
        <button
          onClick={() => void loadPlayers()}
          className="border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-500 hover:text-zinc-300"
        >
          players
        </button>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
          {status === "live" ? "streaming" : status}
        </span>
      </div>

      {playersError && (
        <p className="border-b border-grid-bounds px-2 py-1 font-mono text-[10px] text-warn-vector">
          {playersError}
        </p>
      )}
      {players && (
        <div className="border-b border-grid-bounds px-2 py-1 font-mono text-[10px] text-zinc-500">
          {players.length} online{players.length ? `: ${players.join(", ")}` : ""}
        </div>
      )}

      <div ref={boxRef} className="flex-1 overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed">
        {visible.map((line, index) => (
          <div key={index} className={`whitespace-pre-wrap break-all ${ansiClass(line)}`}>
            {line}
          </div>
        ))}
        {visible.length === 0 && <p className="text-zinc-600">no output yet.</p>}
      </div>

      {snippets.length > 0 && allowed && (
        <div className="flex flex-wrap gap-1 border-t border-grid-bounds px-2 py-1.5">
          {snippets.map((snippet) => (
            <button
              key={snippet}
              onClick={() => void sendLine(snippet)}
              className="border border-grid-bounds px-2 py-0.5 font-mono text-[10px] text-zinc-400 hover:text-signal-high"
            >
              {snippet}
            </button>
          ))}
        </div>
      )}

      {allowed && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex border-t border-grid-bounds"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
                if (history[next]) {
                  setHistoryIndex(next);
                  setDraft(history[next]);
                }
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (historyIndex < 0) return;
                const next = historyIndex + 1;
                if (next >= history.length) {
                  setHistoryIndex(-1);
                  setDraft("");
                } else {
                  setHistoryIndex(next);
                  setDraft(history[next]);
                }
              }
            }}
            placeholder="type a command and press enter"
            className="flex-1 border-0 bg-transparent px-3 py-2 font-mono text-xs text-zinc-100 outline-none"
          />
          <button
            type="submit"
            className="border-l border-grid-bounds px-4 font-mono text-[11px] lowercase text-signal-high"
          >
            send
          </button>
        </form>
      )}
    </div>
  );
}

/* ── metrics ─────────────────────────────────────────────────────────── */

const WINDOWS = [
  { label: "1h", secs: 3600 },
  { label: "6h", secs: 21600 },
  { label: "24h", secs: 86400 },
  { label: "7d", secs: 604800 },
];

function MetricsTab({ server }: { server: ServerSummary }) {
  const [windowSecs, setWindowSecs] = useState(3600);
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const { push } = useToast();

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const data = await api<{ samples: MetricSample[] }>(
          `/servers/${encodeURIComponent(server.id)}/metrics?window=${windowSecs}`,
        );
        if (!disposed) setSamples(data.samples ?? []);
      } catch (err) {
        if (!disposed) push(err instanceof Error ? err.message : "metrics failed", "error");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [server.id, windowSecs, push]);

  return (
    <div>
      <div className="flex items-center gap-1.5">
        {WINDOWS.map((option) => (
          <button
            key={option.secs}
            onClick={() => setWindowSecs(option.secs)}
            className={`border px-2.5 py-1 font-mono text-[11px] ${
              windowSecs === option.secs
                ? "border-signal-high text-signal-high"
                : "border-grid-bounds text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          {samples.length} samples · green cpu · amber ram
        </span>
      </div>
      <div className="mt-3 border border-grid-bounds bg-bg-surface p-3">
        <Chart samples={samples} />
      </div>
    </div>
  );
}

function Chart({ samples }: { samples: MetricSample[] }) {
  if (samples.length < 2) {
    return <p className="py-12 text-center font-mono text-xs text-zinc-600">not enough samples yet</p>;
  }
  const width = 800;
  const height = 180;
  const start = samples[0].at;
  const span = Math.max(1, samples[samples.length - 1].at - start);
  const points = (key: "cpu" | "ram") =>
    samples
      .map((sample) => {
        const x = ((sample.at - start) / span) * width;
        const y = height - Math.min(1, Math.max(0, sample[key])) * (height - 8) - 4;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full" preserveAspectRatio="none">
      {[0.25, 0.5, 0.75].map((fraction) => (
        <line
          key={fraction}
          x1={0}
          x2={width}
          y1={height * fraction}
          y2={height * fraction}
          stroke="#161920"
          strokeWidth={1}
        />
      ))}
      <polyline points={points("cpu")} fill="none" stroke="#4cf5a0" strokeWidth={1.5} />
      <polyline points={points("ram")} fill="none" stroke="#f5a04c" strokeWidth={1.5} />
    </svg>
  );
}



/* -- backups (schedule + snapshots) ------------------------------------ */

function BackupsTab({ server, allowed }: { server: ServerSummary; allowed: boolean }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const loadBackups = async () => {
    try {
      const data = await api<{ backups: Backup[] }>(
        `/servers/${encodeURIComponent(server.id)}/backups`,
      );
      setBackups(data.backups ?? []);
    } catch (err) {
      push(err instanceof Error ? err.message : "backups failed", "error");
    }
  };

  useEffect(() => {
    void loadBackups();
    void api<BackupSchedule>(`/servers/${encodeURIComponent(server.id)}/backup-schedule`)
      .then(setSchedule)
      .catch(() => setSchedule(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  return (
    <div>
      {/* schedule */}
      {schedule && (
        <div className="mb-4 border border-grid-bounds bg-bg-surface p-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
            automatic backups
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-zinc-600">every (minutes, 0 = off)</span>
              <input
                value={String(Math.round((schedule.intervalSecs || 0) / 60))}
                onChange={(event) =>
                  setSchedule({
                    ...schedule,
                    intervalSecs: Math.max(0, Number(event.target.value) || 0) * 60,
                  })
                }
                disabled={!allowed}
                inputMode="numeric"
                className="input w-32"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-zinc-600">keep</span>
              <input
                value={String(schedule.keep ?? 12)}
                onChange={(event) =>
                  setSchedule({ ...schedule, keep: Math.max(1, Number(event.target.value) || 1) })
                }
                disabled={!allowed}
                inputMode="numeric"
                className="input w-20"
              />
            </label>
            <label className="flex items-center gap-2 pb-1.5 font-mono text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={!!schedule.onStop}
                onChange={(event) => setSchedule({ ...schedule, onStop: event.target.checked })}
                disabled={!allowed}
              />
              also on clean stop
            </label>
            {allowed && (
              <button
                onClick={async () => {
                  try {
                    await api(`/servers/${encodeURIComponent(server.id)}/backup-schedule`, {
                      method: "PUT",
                      json: schedule,
                    });
                    push("schedule saved", "success");
                  } catch (err) {
                    push(err instanceof Error ? err.message : "save failed", "error");
                  }
                }}
                className="border border-signal-high/40 px-3 py-1.5 font-mono text-[11px] lowercase text-signal-high"
              >
                save schedule
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-zinc-600">
          plugin-defined snapshots (minecraft worlds today)
        </span>
        {allowed && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/servers/${encodeURIComponent(server.id)}/backup`, { method: "POST" });
                push("backup accepted — this can take a moment", "warn");
                window.setTimeout(() => void loadBackups(), 2500);
              } catch (err) {
                push(err instanceof Error ? err.message : "backup failed", "error");
              } finally {
                setBusy(false);
              }
            }}
            className="ml-auto border border-signal-high/40 px-3 py-1 font-mono text-[11px] lowercase text-signal-high disabled:opacity-40"
          >
            backup now
          </button>
        )}
      </div>

      <table className="mt-3 w-full border-collapse">
        <thead>
          <tr className="border-b border-grid-bounds text-left font-mono text-[10px] lowercase text-zinc-600">
            <th className="py-1.5 pr-2 font-normal">name</th>
            <th className="py-1.5 pr-2 font-normal">size</th>
            <th className="py-1.5 pr-2 font-normal">created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {backups.map((backup) => (
            <tr key={backup.name} className="border-b border-grid-bounds/40 font-mono text-[11px]">
              <td className="py-2 pr-2 text-zinc-300">{backup.name}</td>
              <td className="py-2 pr-2 text-zinc-600">{fmtBytes(backup.size)}</td>
              <td className="py-2 pr-2 text-zinc-600">{fmtAgo(backup.created)}</td>
              <td className="py-2 text-right">
                <button
                  onClick={() =>
                    void downloadInstanceFile(server.id, `backups/${backup.name}`, backup.name)
                  }
                  className="mr-3 text-zinc-400 hover:text-signal-high"
                >
                  download
                </button>
                {allowed && (
                  <>
                    <button
                      onClick={async () => {
                        if (!confirm(`restore ${backup.name}? the current world is replaced.`)) return;
                        try {
                          await api(
                            `/servers/${encodeURIComponent(server.id)}/backups/${encodeURIComponent(backup.name)}/restore`,
                            { method: "POST" },
                          );
                          push("restore accepted", "warn");
                        } catch (err) {
                          push(err instanceof Error ? err.message : "restore failed", "error");
                        }
                      }}
                      className="mr-3 text-zinc-400 hover:text-signal-high"
                    >
                      restore
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`delete ${backup.name}?`)) return;
                        try {
                          await api(
                            `/servers/${encodeURIComponent(server.id)}/backups/${encodeURIComponent(backup.name)}`,
                            { method: "DELETE" },
                          );
                          push("deleted", "warn");
                        } catch (err) {
                          push(err instanceof Error ? err.message : "delete failed", "error");
                        }
                      }}
                      className="text-fault-vector"
                    >
                      delete
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {backups.length === 0 && (
        <p className="mt-4 font-mono text-[11px] text-zinc-600">no backups yet.</p>
      )}
    </div>
  );
}

/* -- tasks (full editor) ----------------------------------------------- */

const TASK_ACTIONS = ["restart", "start", "stop", "command", "backup", "health"];

function TasksTab({ server, allowed }: { server: ServerSummary; allowed: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dirty, setDirty] = useState(false);
  const { push } = useToast();

  useEffect(() => {
    api<{ tasks: Task[] }>(`/servers/${encodeURIComponent(server.id)}/tasks`)
      .then((data) => setTasks(data.tasks ?? []))
      .catch((err) => push(err instanceof Error ? err.message : "tasks failed", "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const update = (id: string, patch: Partial<Task>) => {
    setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, ...patch } : task)));
    setDirty(true);
  };

  const scheduleMode = (task: Task): "daily" | "interval" | "cron" | "manual" => {
    if (task.dailyAt) return "daily";
    if (task.intervalSecs) return "interval";
    if (task.cron) return "cron";
    return "manual";
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-zinc-600">
          scheduled actions � saved per instance, run by the host scheduler.
        </span>
        {allowed && (
          <>
            <button
              onClick={() => {
                setTasks((prev) => [
                  ...prev,
                  {
                    id: `task_${Date.now().toString(36)}`,
                    name: "new task",
                    enabled: true,
                    action: "restart",
                    command: "",
                    intervalSecs: 0,
                    dailyAt: "",
                    cron: "",
                  },
                ]);
                setDirty(true);
              }}
              className="ml-auto border border-grid-bounds px-3 py-1 font-mono text-[11px] lowercase text-zinc-300"
            >
              add task
            </button>
            <button
              disabled={!dirty}
              onClick={async () => {
                try {
                  await api(`/servers/${encodeURIComponent(server.id)}/tasks`, {
                    method: "PUT",
                    json: { tasks },
                  });
                  push("tasks saved", "success");
                  setDirty(false);
                } catch (err) {
                  push(err instanceof Error ? err.message : "save failed", "error");
                }
              }}
              className="border border-signal-high/40 px-3 py-1 font-mono text-[11px] lowercase text-signal-high disabled:opacity-40"
            >
              save tasks
            </button>
          </>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {tasks.map((task) => (
          <div key={task.id} className="border border-grid-bounds bg-bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={task.name ?? ""}
                onChange={(event) => update(task.id, { name: event.target.value })}
                disabled={!allowed}
                placeholder="name"
                className="input max-w-[180px]"
              />
              <select
                value={task.action ?? "restart"}
                onChange={(event) => update(task.id, { action: event.target.value })}
                disabled={!allowed}
                className="input max-w-[130px]"
              >
                {TASK_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                <input
                  type="checkbox"
                  checked={task.enabled !== false}
                  onChange={(event) => update(task.id, { enabled: event.target.checked })}
                  disabled={!allowed}
                />
                enabled
              </label>
              <select
                value={scheduleMode(task)}
                onChange={(event) => {
                  const mode = event.target.value;
                  update(task.id, {
                    dailyAt: mode === "daily" ? task.dailyAt || "04:00" : "",
                    intervalSecs: mode === "interval" ? task.intervalSecs || 3600 : 0,
                    cron: mode === "cron" ? task.cron || "0 4 * * *" : "",
                  });
                }}
                disabled={!allowed}
                className="input max-w-[110px]"
              >
                <option value="manual">manual</option>
                <option value="daily">daily at</option>
                <option value="interval">every</option>
                <option value="cron">cron</option>
              </select>
              {scheduleMode(task) === "daily" && (
                <input
                  value={task.dailyAt ?? ""}
                  onChange={(event) => update(task.id, { dailyAt: event.target.value })}
                  disabled={!allowed}
                  placeholder="04:00"
                  className="input max-w-[90px]"
                />
              )}
              {scheduleMode(task) === "interval" && (
                <label className="flex items-center gap-1 font-mono text-[10px] text-zinc-500">
                  <input
                    value={String(Math.round((task.intervalSecs ?? 0) / 60))}
                    onChange={(event) =>
                      update(task.id, {
                        intervalSecs: Math.max(1, Number(event.target.value) || 1) * 60,
                      })
                    }
                    disabled={!allowed}
                    inputMode="numeric"
                    className="input max-w-[70px]"
                  />
                  min
                </label>
              )}
              {scheduleMode(task) === "cron" && (
                <input
                  value={task.cron ?? ""}
                  onChange={(event) => update(task.id, { cron: event.target.value })}
                  disabled={!allowed}
                  placeholder="0 4 * * *"
                  className="input max-w-[130px]"
                />
              )}
              {allowed && (
                <>
                  <button
                    onClick={async () => {
                      try {
                        await api(
                          `/servers/${encodeURIComponent(server.id)}/tasks/${encodeURIComponent(task.id)}/run`,
                          { method: "POST" },
                        );
                        push("task started", "success");
                      } catch (err) {
                        push(err instanceof Error ? err.message : "run failed", "error");
                      }
                    }}
                    className="text-zinc-400 hover:text-signal-high"
                  >
                    run now
                  </button>
                  <button
                    onClick={() => {
                      setTasks((prev) => prev.filter((entry) => entry.id !== task.id));
                      setDirty(true);
                    }}
                    className="ml-auto text-fault-vector"
                  >
                    remove
                  </button>
                </>
              )}
            </div>
            {task.action === "command" && (
              <input
                value={task.command ?? ""}
                onChange={(event) => update(task.id, { command: event.target.value })}
                disabled={!allowed}
                placeholder="command (stdin while running, shell when stopped)"
                className="input mt-2"
              />
            )}
          </div>
        ))}
        {tasks.length === 0 && (
          <p className="font-mono text-[11px] text-zinc-600">no scheduled tasks.</p>
        )}
      </div>
    </div>
  );
}
