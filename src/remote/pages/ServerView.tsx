import { useEffect, useMemo, useRef, useState } from "react";
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
  FileEntry,
  MetricSample,
  ServerSummary,
  Task,
} from "../lib/types";

const TABS = ["console", "metrics", "files", "backups", "tasks"] as const;
type Tab = (typeof TABS)[number];

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
  const active = (TABS as readonly string[]).includes(tab) ? (tab as Tab) : "console";
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
        {TABS.map((item) => (
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
        {active === "files" && <FilesTab server={server} allowed={allowed} />}
        {active === "backups" && <BackupsTab server={server} allowed={allowed} />}
        {active === "tasks" && <TasksTab server={server} allowed={allowed} />}
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

  async function send() {
    const line = draft.trim();
    if (!line) return;
    setDraft("");
    setHistory((prev) => [...prev, line]);
    setHistoryIndex(-1);
    try {
      await api(`/servers/${encodeURIComponent(server.id)}/stdin`, { json: { line } });
    } catch (err) {
      push(err instanceof Error ? err.message : "send failed", "error");
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
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
          {status === "live" ? "streaming" : status}
        </span>
      </div>

      <div ref={boxRef} className="flex-1 overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed">
        {visible.map((line, index) => (
          <div key={index} className={`whitespace-pre-wrap break-all ${ansiClass(line)}`}>
            {line}
          </div>
        ))}
        {visible.length === 0 && <p className="text-zinc-600">no output yet.</p>}
      </div>

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

/* ── files (basic; upgraded to Monaco/tree/tabs next) ────────────────── */

function FilesTab({ server, allowed }: { server: ServerSummary; allowed: boolean }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<{ path: string; content: string; mtime: number } | null>(null);
  const { push } = useToast();

  const load = async (target = path) => {
    try {
      const data = await api<{ entries: FileEntry[] }>(
        `/servers/${encodeURIComponent(server.id)}/files?path=${encodeURIComponent(target)}`,
      );
      setEntries(
        [...(data.entries ?? [])].sort((a, b) =>
          a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
        ),
      );
    } catch (err) {
      push(err instanceof Error ? err.message : "listing failed", "error");
    }
  };

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const openFile = async (rel: string) => {
    try {
      const data = await api<{ content: string; mtime: number }>(
        `/servers/${encodeURIComponent(server.id)}/file?path=${encodeURIComponent(rel)}`,
      );
      setFile({ path: rel, content: data.content, mtime: data.mtime });
    } catch (err) {
      push(err instanceof Error ? err.message : "read failed", "error");
    }
  };

  const save = async () => {
    if (!file) return;
    try {
      await api(`/servers/${encodeURIComponent(server.id)}/file`, {
        method: "PUT",
        json: { path: file.path, content: file.content, expectedMtime: file.mtime },
      });
      push("saved", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "save failed";
      if (message.includes("conflict:")) {
        if (confirm("this file changed on disk. overwrite anyway?")) {
          await api(`/servers/${encodeURIComponent(server.id)}/file`, {
            method: "PUT",
            json: { path: file.path, content: file.content },
          });
          push("saved (overwrote)", "warn");
        }
      } else {
        push(message, "error");
      }
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="border border-grid-bounds bg-bg-surface">
        <div className="flex items-center gap-1 border-b border-grid-bounds px-2 py-1.5">
          <button
            onClick={() => {
              const parts = path.split("/").filter(Boolean);
              parts.pop();
              const next = parts.join("/");
              setPath(next);
              void load(next);
            }}
            className="font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            ↑ up
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600">
            /{path}
          </span>
          {allowed && (
            <button
              onClick={async () => {
                const name = prompt("upload file");
                if (!name) return;
                const input = document.createElement("input");
                input.type = "file";
                input.onchange = async () => {
                  const chosen = input.files?.[0];
                  if (!chosen) return;
                  const rel = path ? `${path}/${chosen.name}` : chosen.name;
                  try {
                    const res = await apiRaw(
                      `/servers/${encodeURIComponent(server.id)}/upload?path=${encodeURIComponent(rel)}`,
                      { method: "POST", body: chosen },
                    );
                    if (!res.ok) throw new Error("upload failed");
                    push(`uploaded ${chosen.name}`, "success");
                    void load(path);
                  } catch (err) {
                    push(err instanceof Error ? err.message : "upload failed", "error");
                  }
                };
                input.click();
              }}
              className="font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
            >
              upload
            </button>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {entries.map((entry) => {
            const rel = path ? `${path}/${entry.name}` : entry.name;
            return (
              <div
                key={entry.name}
                className="flex cursor-pointer items-center gap-2 border-b border-grid-bounds/40 px-2 py-1.5 hover:bg-bg-core"
                onClick={() => {
                  if (entry.isDir) {
                    setPath(rel);
                    void load(rel);
                  } else {
                    void openFile(rel);
                  }
                }}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">
                  {entry.isDir ? "▸ " : ""}
                  {entry.name}
                </span>
                {!entry.isDir && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void downloadInstanceFile(server.id, rel, entry.name).catch(() =>
                        push("download failed", "error"),
                      );
                    }}
                    className="font-mono text-[10px] text-zinc-600 hover:text-signal-high"
                  >
                    get
                  </button>
                )}
                <span className="font-mono text-[10px] text-zinc-600">
                  {entry.isDir ? "" : fmtBytes(entry.size)}
                </span>
              </div>
            );
          })}
          {entries.length === 0 && (
            <p className="px-2 py-3 font-mono text-[11px] text-zinc-600">empty.</p>
          )}
        </div>
      </div>

      <div className="border border-grid-bounds bg-bg-surface">
        {file ? (
          <>
            <div className="flex items-center gap-2 border-b border-grid-bounds px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">
                {file.path}
              </span>
              {allowed && (
                <button
                  onClick={() => void save()}
                  className="font-mono text-[10px] text-signal-high"
                >
                  save
                </button>
              )}
              <button
                onClick={() => setFile(null)}
                className="font-mono text-[10px] text-zinc-500"
              >
                close
              </button>
            </div>
            <textarea
              value={file.content}
              onChange={(e) => setFile({ ...file, content: e.target.value })}
              spellCheck={false}
              className="h-[55vh] w-full resize-none bg-black p-3 font-mono text-[11.5px] leading-relaxed text-zinc-200 outline-none"
            />
          </>
        ) : (
          <p className="px-3 py-4 font-mono text-[11px] text-zinc-600">
            select a file to edit. (a full editor with a tree, tabs and search is
            landing in this build.)
          </p>
        )}
      </div>
    </div>
  );
}

/* ── backups ─────────────────────────────────────────────────────────── */

function BackupsTab({ server, allowed }: { server: ServerSummary; allowed: boolean }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const load = async () => {
    try {
      const data = await api<{ backups: Backup[] }>(`/servers/${encodeURIComponent(server.id)}/backups`);
      setBackups(data.backups ?? []);
    } catch (err) {
      push(err instanceof Error ? err.message : "backups failed", "error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  return (
    <div>
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
                window.setTimeout(() => void load(), 2500);
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
                          void load();
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

/* ── tasks ───────────────────────────────────────────────────────────── */

function TasksTab({ server, allowed }: { server: ServerSummary; allowed: boolean }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const { push } = useToast();

  useEffect(() => {
    api<{ tasks: Task[] }>(`/servers/${encodeURIComponent(server.id)}/tasks`)
      .then((data) => setTasks(data.tasks ?? []))
      .catch((err) => push(err instanceof Error ? err.message : "tasks failed", "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  return (
    <div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-grid-bounds text-left font-mono text-[10px] lowercase text-zinc-600">
            <th className="py-1.5 pr-2 font-normal">task</th>
            <th className="py-1.5 pr-2 font-normal">action</th>
            <th className="py-1.5 pr-2 font-normal">when</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="border-b border-grid-bounds/40 font-mono text-[11px]">
              <td className="py-2 pr-2 text-zinc-300">{task.name || task.id}</td>
              <td className="py-2 pr-2 text-zinc-600">{task.action}</td>
              <td className="py-2 pr-2 text-zinc-600">
                {task.dailyAt
                  ? `daily ${task.dailyAt}`
                  : task.intervalSecs
                    ? `every ${Math.round(task.intervalSecs / 60)}m`
                    : "—"}
              </td>
              <td className="py-2 text-right">
                {allowed && (
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
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && (
        <p className="mt-4 font-mono text-[11px] text-zinc-600">no scheduled tasks.</p>
      )}
    </div>
  );
}
