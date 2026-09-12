/**
 * Instance monitor — a consolidated panel of per-instance tools:
 *   - Listening ports + quick-connect
 *   - Energy / cost estimate
 *   - Metrics history graph (CPU/RAM over the last 24h)
 *   - Backup schedule config
 *   - Health-alert thresholds config
 *   - Find & replace across files
 *
 * Rendered as the "monitor" built-in tab in ServerDetailView so all the
 * analytical/power features live in one place rather than cluttering the
 * terminal/files surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../../hooks/useToast";
import { useUiState } from "../../hooks/useUiState";
import type {
  ListeningPort,
  MetricSample,
  EnergyCost,
  ReplaceResult,
} from "../../types/features";
import type { ServerInstance, BackupSchedule, AlertRules, ScheduledTask } from "../../types/server";
import { isFeatureEnabled } from "./instanceFeatures";

interface InstanceMonitorProps {
  server: ServerInstance;
  /** Whether the instance process is currently running (drives ports/metrics). */
  running: boolean;
  /** Drop a command into the terminal input (history panel → run). */
  onUseCommand?: (cmd: string) => void;
  /** Called after schedule saves so the registry reloads. */
  onServerSaved?: () => void;
}

export function InstanceMonitor({
  server,
  running,
  onUseCommand,
  onServerSaved,
}: InstanceMonitorProps) {
  const { notify } = useToast();
  const has = (key: string) => isFeatureEnabled(server, key);
  const monitorFeatureKeys = [
    "ports",
    "energy",
    "metrics-history",
    "backups",
    "alerts",
    "find-replace",
    "env",
    "history",
    "schedules",
    "rcon",
  ];
  const anyVisible = monitorFeatureKeys.some(has);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl p-4 space-y-6">
        {!anyVisible && (
          <p className="text-[11px] text-zinc-600">
            All monitor features are hidden for this instance. Turn them on under
            the "settings" tab.
          </p>
        )}
        <CrashCard server={server} />
        {has("ports") && <PortsCard server={server} running={running} notify={notify} />}
        {has("energy") && <EnergyCard server={server} />}
        {has("metrics-history") && <MetricsCard server={server} running={running} />}
        {has("backups") && <BackupCard server={server} running={running} notify={notify} />}
        {has("alerts") && <AlertsCard server={server} />}
        {has("env") && <EnvEditorCard server={server} notify={notify} />}
        {has("history") && <HistoryCard server={server} onUseCommand={onUseCommand} notify={notify} />}
        {has("schedules") && (
          <TasksCard server={server} onSaved={onServerSaved} notify={notify} />
        )}
        {has("rcon") && <RconCard server={server} notify={notify} />}
        {has("find-replace") && <FindReplaceCard server={server} notify={notify} />}
      </div>
    </div>
  );
}

/* ── Card primitives ───────────────────────────────────────────────────── */

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-grid-bounds">
      <div className="px-3 py-2 border-b border-grid-bounds">
        <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">{title}</h3>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-1 text-[11px]">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200 font-mono">{value}</span>
    </div>
  );
}

/* ── Last crash ───────────────────────────────────────────────────────── */

interface CrashReport {
  at: number;
  exitCode?: number | null;
  forced?: boolean;
  tail?: string[];
}

/**
 * "Why did it die?" card — populated by the backend when a restartable process
 * exits unexpectedly. Hidden entirely when there is no crash to show.
 */
function CrashCard({ server }: { server: ServerInstance }) {
  const [report, setReport] = useState<CrashReport | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    invoke<CrashReport | null>("get_last_crash", { id: server.id })
      .then(setReport)
      .catch(() => setReport(null));
  }, [server.id, server.status]);

  if (!report) return null;
  const when = new Date(report.at * 1000).toLocaleString();
  const code = report.exitCode != null ? `exit ${report.exitCode}` : "no exit code";
  const tail = report.tail ?? [];

  return (
    <Card title="last crash">
      <p className="text-[11px] text-zinc-400">
        {server.name} exited unexpectedly on {when} ({code}).
      </p>
      {tail.length > 0 && (
        <>
          <button
            onClick={() => setExpanded((value) => !value)}
            className="mt-1 text-[11px] text-signal-low hover:underline"
          >
            {expanded ? "hide log tail" : "show log tail"}
          </button>
          {expanded && (
            <pre className="mt-2 max-h-48 overflow-auto border border-grid-bounds bg-black/40 p-2 text-[10px] leading-relaxed text-zinc-500 whitespace-pre-wrap">
              {tail.join("\n")}
            </pre>
          )}
        </>
      )}
      <div className="mt-2">
        <button
          onClick={() => {
            void invoke("clear_last_crash", { id: server.id }).then(() =>
              setReport(null),
            );
          }}
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          dismiss
        </button>
      </div>
    </Card>
  );
}

/* ── Ports ────────────────────────────────────────────────────────────── */

function PortsCard({
  server,
  running,
  notify,
}: {
  server: ServerInstance;
  running: boolean;
  notify: ReturnType<typeof useToast>["notify"];
}) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPorts(await invoke<ListeningPort[]>("get_instance_ports", { id: server.id }));
    } catch {
      setPorts([]);
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    if (running) void refresh();
    if (!running) setPorts([]);
  }, [running, refresh]);

  return (
    <Card title="ports & quick-connect">
      {!running && (
        <p className="text-[11px] text-zinc-600">start the instance to detect listening ports.</p>
      )}
      {running && loading && <p className="text-[11px] text-zinc-600">scanning…</p>}
      {running && !loading && ports.length === 0 && (
        <p className="text-[11px] text-zinc-600">no listening TCP ports detected.</p>
      )}
      {ports.map((p) => (
        <Row
          key={p.port}
          label={`:${p.port}`}
          value={
            <button
              onClick={() => {
                navigator.clipboard?.writeText(p.connect);
                notify({ kind: "info", title: "Copied", message: p.connect });
              }}
              className="text-signal-high hover:underline"
            >
              {p.connect} ⧉
            </button>
          }
        />
      ))}
    </Card>
  );
}

/* ── Energy ───────────────────────────────────────────────────────────── */

function EnergyCard({ server }: { server: ServerInstance }) {
  const [cost, setCost] = useState<EnergyCost | null>(null);

  useEffect(() => {
    invoke<EnergyCost>("get_instance_energy", { id: server.id })
      .then(setCost)
      .catch(() => setCost(null));
  }, [server.id]);

  if (!cost || cost.cost === 0) {
    return (
      <Card title="energy & cost">
        <p className="text-[11px] text-zinc-600">
          Set an electricity price in settings to see a running-cost estimate here.
        </p>
      </Card>
    );
  }

  return (
    <Card title="energy & cost">
      <Row label="running hours" value={`${cost.hours.toFixed(0)} h`} />
      <Row label="est. draw" value={`${cost.estWatts.toFixed(0)} W`} />
      <Row label="est. cost" value={cost.cost.toFixed(2)} />
    </Card>
  );
}

/* ── Metrics history graph ────────────────────────────────────────────── */

function MetricsCard({ server, running }: { server: ServerInstance; running: boolean }) {
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [windowH, setWindowH] = useState<24 | 168>(24);

  useEffect(() => {
    invoke<MetricSample[]>("get_metrics_history", {
      id: server.id,
      windowSecs: windowH * 3600,
    })
      .then(setSamples)
      .catch(() => setSamples([]));
  }, [server.id, windowH, running]);

  return (
    <Card title={`resource history · last ${windowH === 24 ? "24h" : "7d"}`}>
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setWindowH(24)}
          className={`text-[10px] px-2 py-1 border ${windowH === 24 ? "border-signal-high text-signal-high" : "border-grid-bounds text-zinc-500"}`}
        >
          24h
        </button>
        <button
          onClick={() => setWindowH(168)}
          className={`text-[10px] px-2 py-1 border ${windowH === 168 ? "border-signal-high text-signal-high" : "border-grid-bounds text-zinc-500"}`}
        >
          7d
        </button>
      </div>
      {samples.length === 0 ? (
        <p className="text-[11px] text-zinc-600">
          no history yet — samples accumulate while the instance runs.
        </p>
      ) : (
        <Sparkline samples={samples} />
      )}
    </Card>
  );
}

/** Tiny inline sparkline of CPU/RAM samples. */
function Sparkline({ samples }: { samples: MetricSample[] }) {
  if (samples.length < 2) {
    return <p className="text-[11px] text-zinc-600">collecting… ({samples.length} samples)</p>;
  }
  const w = 600;
  const h = 80;
  const step = w / (samples.length - 1);
  const cpuPts = samples.map((s, i) => `${i * step},${h - s.cpu * h}`).join(" ");
  const ramPts = samples.map((s, i) => `${i * step},${h - s.ram * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-20 bg-bg-core border border-grid-bounds">
      <polyline points={cpuPts} fill="none" stroke="var(--color-signal-high, #4cf5a0)" strokeWidth="1" />
      <polyline points={ramPts} fill="none" stroke="var(--color-warn-vector, #f5a04c)" strokeWidth="1" />
    </svg>
  );
}

/* ── Backup schedule + archive browser ────────────────────────────────── */

interface BackupEntry {
  name: string;
  size: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function BackupCard({
  server,
  running,
  notify,
}: {
  server: ServerInstance;
  running: boolean;
  notify: ReturnType<typeof useToast>["notify"];
}) {
  const [sched, setSched] = useState<BackupSchedule>(
    server.backupSchedule ?? { intervalSecs: 0, keep: 12, onStop: false, lastBackupSecs: 0 },
  );
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBackups(await invoke<BackupEntry[]>("list_backups", { id: server.id }));
    } catch {
      setBackups([]);
    }
  }, [server.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setBusy(true);
    try {
      await invoke("update_backup_schedule", { id: server.id, schedule: sched });
      notify({ kind: "success", title: "Backup schedule saved" });
    } catch (e) {
      notify({ kind: "error", title: "Save failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function snapshotNow() {
    setBusy(true);
    try {
      await invoke("backup_world", { id: server.id });
      notify({ kind: "success", title: "Snapshot created" });
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "Snapshot failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function restore(name: string) {
    setBusy(true);
    try {
      await invoke("restore_world", { id: server.id, backupName: name });
      notify({ kind: "success", title: "World restored", message: name });
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "Restore failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    try {
      await invoke("delete_backup", { id: server.id, backupName: name });
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "Delete failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="backup schedule">
      <div className="space-y-2">
        <label className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-500">interval (hours, 0 = off)</span>
          <input
            type="number"
            min={0}
            value={Math.floor(sched.intervalSecs / 3600)}
            onChange={(e) => setSched({ ...sched, intervalSecs: (parseInt(e.target.value) || 0) * 3600 })}
            className="w-20 bg-bg-core border border-grid-bounds px-2 py-1 text-zinc-200"
          />
        </label>
        <label className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-500">keep last (snapshots)</span>
          <input
            type="number"
            min={1}
            value={sched.keep}
            onChange={(e) => setSched({ ...sched, keep: parseInt(e.target.value) || 12 })}
            className="w-20 bg-bg-core border border-grid-bounds px-2 py-1 text-zinc-200"
          />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={sched.onStop}
            onChange={(e) => setSched({ ...sched, onStop: e.target.checked })}
            className="accent-signal-high"
          />
          <span>also snapshot when the server stops</span>
        </label>
        <div className="flex gap-2 pt-1">
          <button onClick={save} disabled={busy} className="btn-mono-primary">
            save schedule
          </button>
          <button onClick={snapshotNow} disabled={busy} className="btn-mono">
            snapshot now
          </button>
        </div>

        {/* Archive browser — restore/delete anything under backups/. */}
        <div className="pt-3 mt-1 border-t border-grid-bounds">
          <p className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-2">
            archives
          </p>
          {backups.length === 0 ? (
            <p className="text-[11px] text-zinc-600">no backup archives yet.</p>
          ) : (
            <ul className="space-y-1">
              {backups.map((b) => (
                <li key={b.name} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-zinc-300 truncate flex-1 min-w-0" title={b.name}>
                    {b.name}
                  </span>
                  <span className="text-zinc-600 tabular-nums shrink-0">
                    {formatBytes(b.size)}
                  </span>
                  {pendingRestore === b.name ? (
                    <>
                      <button
                        onClick={() => {
                          setPendingRestore(null);
                          void restore(b.name);
                        }}
                        disabled={busy}
                        className="text-fault-vector hover:underline shrink-0"
                      >
                        confirm restore
                      </button>
                      <button
                        onClick={() => setPendingRestore(null)}
                        className="text-zinc-500 hover:text-zinc-200 shrink-0"
                      >
                        cancel
                      </button>
                    </>
                  ) : pendingDelete === b.name ? (
                    <>
                      <button
                        onClick={() => {
                          setPendingDelete(null);
                          void remove(b.name);
                        }}
                        disabled={busy}
                        className="text-fault-vector hover:underline shrink-0"
                      >
                        confirm delete
                      </button>
                      <button
                        onClick={() => setPendingDelete(null)}
                        className="text-zinc-500 hover:text-zinc-200 shrink-0"
                      >
                        cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setPendingRestore(b.name)}
                        disabled={busy || running}
                        title={running ? "stop the server before restoring" : "restore this world archive"}
                        className="text-signal-high hover:underline disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                      >
                        restore
                      </button>
                      <button
                        onClick={() => setPendingDelete(b.name)}
                        disabled={busy}
                        className="text-zinc-500 hover:text-fault-vector shrink-0"
                      >
                        delete
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {running && backups.length > 0 && (
            <p className="text-[10px] text-zinc-600 mt-2">
              Restoring is disabled while the server runs — stop it first.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ── Alert thresholds ─────────────────────────────────────────────────── */

function AlertsCard({ server }: { server: ServerInstance }) {
  const [rules, setRules] = useState<AlertRules>(
    server.alertRules ?? { cpuThreshold: 0.9, ramThreshold: 0.9, sustainedSecs: 60 },
  );
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();

  async function save() {
    setBusy(true);
    try {
      await invoke("update_alert_rules", { id: server.id, rules });
      notify({ kind: "success", title: "Alert rules saved" });
    } catch (e) {
      notify({ kind: "error", title: "Save failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="health alerts">
      <div className="space-y-2">
        <label className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-500">alert if CPU over (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            value={rules.cpuThreshold != null ? Math.round(rules.cpuThreshold * 100) : 0}
            onChange={(e) =>
              setRules({ ...rules, cpuThreshold: (parseInt(e.target.value) || 0) / 100 })
            }
            className="w-20 bg-bg-core border border-grid-bounds px-2 py-1 text-zinc-200"
          />
        </label>
        <label className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-500">alert if RAM over (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            value={rules.ramThreshold != null ? Math.round(rules.ramThreshold * 100) : 0}
            onChange={(e) =>
              setRules({ ...rules, ramThreshold: (parseInt(e.target.value) || 0) / 100 })
            }
            className="w-20 bg-bg-core border border-grid-bounds px-2 py-1 text-zinc-200"
          />
        </label>
        <label className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-500">sustained for (seconds)</span>
          <input
            type="number"
            min={1}
            value={rules.sustainedSecs}
            onChange={(e) => setRules({ ...rules, sustainedSecs: parseInt(e.target.value) || 60 })}
            className="w-20 bg-bg-core border border-grid-bounds px-2 py-1 text-zinc-200"
          />
        </label>
        <p className="text-[10px] text-zinc-600 pt-1">
          Alerts fire as a toast when a threshold is crossed for the sustained window.
        </p>
        <button onClick={save} disabled={busy} className="btn-mono-primary">
          save rules
        </button>
      </div>
    </Card>
  );
}

/* ── Environment (.env) editor ────────────────────────────────────────── */

function EnvEditorCard({
  server,
  notify,
}: {
  server: ServerInstance;
  notify: ReturnType<typeof useToast>["notify"];
}) {
  const [original, setOriginal] = useState("");
  const [draft, setDraft] = useState("");
  const [mtime, setMtime] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const res = await invoke<{ content: string; mtime: number }>("read_server_file", {
          id: server.id,
          relPath: ".env",
        });
        if (cancelled) return;
        setOriginal(res.content);
        setDraft(res.content);
        setMtime(res.mtime);
      } catch {
        if (cancelled) return;
        setOriginal("");
        setDraft("");
        setMtime(0);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server.id]);

  async function save() {
    setBusy(true);
    try {
      const newMtime = await invoke<number>("write_server_file", {
        id: server.id,
        relPath: ".env",
        content: draft,
        expectedMtime: mtime,
      });
      setMtime(newMtime);
      setOriginal(draft);
      notify({ kind: "success", title: ".env saved" });
    } catch (e) {
      notify({ kind: "error", title: "Save failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="environment (.env)">
      {!loaded ? (
        <p className="text-[11px] text-zinc-600">loading…</p>
      ) : (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={"KEY=value\nDISCORD_TOKEN=…"}
            className="w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-[11px] font-mono text-zinc-200 resize-y"
          />
          <p className="text-[10px] text-zinc-600">
            Parsed and injected into the process environment at launch.
          </p>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy || draft === original} className="btn-mono-primary">
              save .env
            </button>
            <button
              onClick={() => setDraft(original)}
              disabled={busy || draft === original}
              className="btn-mono"
            >
              revert
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ── Command history ──────────────────────────────────────────────────── */

function HistoryCard({
  server,
  onUseCommand,
  notify,
}: {
  server: ServerInstance;
  onUseCommand?: (cmd: string) => void;
  notify: ReturnType<typeof useToast>["notify"];
}) {
  const { uiState, updateServer } = useUiState();
  const history = uiState.servers[server.id]?.commandHistory ?? [];
  const newestFirst = [...history].reverse();

  return (
    <Card title="command history">
      {newestFirst.length === 0 ? (
        <p className="text-[11px] text-zinc-600">no commands yet.</p>
      ) : (
        <div className="space-y-2">
          <ul className="max-h-48 overflow-y-auto space-y-0.5">
            {newestFirst.map((cmd, i) => (
              <li key={`${i}:${cmd}`}>
                <button
                  onClick={() => onUseCommand?.(cmd)}
                  title={`use: ${cmd}`}
                  className="w-full text-left font-mono text-[11px] text-zinc-300 hover:text-signal-high truncate"
                >
                  {cmd}
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={async () => {
              await updateServer(server.id, { commandHistory: [] });
              notify({ kind: "info", title: "Command history cleared" });
            }}
            className="btn-mono"
          >
            clear history
          </button>
        </div>
      )}
    </Card>
  );
}

/* ── Scheduled tasks ──────────────────────────────────────────────────── */

const TASK_ACTIONS = [
  { value: "restart", label: "restart" },
  { value: "start", label: "start" },
  { value: "stop", label: "stop" },
  { value: "command", label: "send command" },
  { value: "backup", label: "backup" },
  { value: "health", label: "health check" },
];

function newTaskDraft(): ScheduledTask {
  return {
    id: `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    enabled: true,
    action: "restart",
    command: "",
    intervalSecs: 0,
    dailyAt: "",
    cron: "",
    lastRunSecs: 0,
  };
}

function formatInterval(secs: number): string {
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

function scheduleSummary(t: ScheduledTask): string {
  const parts: string[] = [];
  if (t.intervalSecs > 0) parts.push(`every ${formatInterval(t.intervalSecs)}`);
  if (t.dailyAt) parts.push(`daily ${t.dailyAt}`);
  if (t.cron) parts.push(`cron ${t.cron}`);
  return parts.length ? parts.join(" · ") : "no schedule";
}

function TasksCard({
  server,
  onSaved,
  notify,
}: {
  server: ServerInstance;
  onSaved?: () => void;
  notify: ReturnType<typeof useToast>["notify"];
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>(server.tasks ?? []);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ScheduledTask>(newTaskDraft);
  const [mode, setMode] = useState<"interval" | "daily" | "cron">("interval");
  const [intervalHours, setIntervalHours] = useState(24);

  useEffect(() => {
    setTasks(server.tasks ?? []);
  }, [server.id, server.tasks]);

  async function persist(next: ScheduledTask[]) {
    setBusy(true);
    try {
      await invoke("update_server_tasks", { id: server.id, tasks: next });
      setTasks(next);
      notify({ kind: "success", title: "Scheduled tasks saved" });
      onSaved?.();
    } catch (e) {
      notify({ kind: "error", title: "Save failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const t: ScheduledTask = { ...draft };
    if (mode === "interval") {      t.intervalSecs = Math.max(60, Math.round(intervalHours * 3600));
      t.dailyAt = "";
      t.cron = "";
    } else if (mode === "daily") {
      t.intervalSecs = 0;
      t.cron = "";
      if (!t.dailyAt) {
        notify({ kind: "warn", title: "Pick a daily time" });
        return;
      }
    } else {
      t.intervalSecs = 0;
      t.dailyAt = "";
      if (!t.cron.trim()) {
        notify({ kind: "warn", title: "Enter a cron expression" });
        return;
      }
    }
    if (t.action === "command" && !t.command.trim()) {
      notify({ kind: "warn", title: "Enter the command to send" });
      return;
    }
    void persist([...tasks, t]);
    setDraft(newTaskDraft());
  }

  async function runNow(t: ScheduledTask) {
    setBusy(true);
    try {
      await invoke("run_task_now", { id: server.id, taskId: t.id });
      notify({ kind: "success", title: `Ran "${t.name || t.action}"` });
      onSaved?.();
    } catch (e) {
      notify({ kind: "error", title: "Task failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "bg-bg-core border border-grid-bounds px-2 py-1 text-[11px] text-zinc-200 font-mono";

  return (
    <Card title="scheduled tasks">
      <div className="space-y-2">
        {tasks.length === 0 ? (
          <p className="text-[11px] text-zinc-600">no scheduled tasks yet.</p>
        ) : (
          <ul className="space-y-1">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 text-[11px] py-1 border-b border-grid-bounds last:border-0"
              >
                <input
                  type="checkbox"
                  checked={t.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void persist(
                      tasks.map((x) =>
                        x.id === t.id ? { ...x, enabled: e.target.checked } : x,
                      ),
                    )
                  }
                  className="accent-signal-high shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="text-zinc-200">
                    {t.name || t.action}
                  </span>
                  <span className="text-zinc-600">
                    {" "}
                    — {TASK_ACTIONS.find((a) => a.value === t.action)?.label ?? t.action}
                    {t.command && t.action !== "health" ? `: ${t.command}` : ""}
                    {t.action === "health" && t.command ? ` (${t.command})` : ""}
                  </span>
                  <span className="block text-[10px] text-zinc-600 font-mono">
                    {scheduleSummary(t)}
                    {(t.announceMinutes ?? []).length > 0
                      ? ` · announce ${(t.announceMinutes ?? []).join("/")}m before`
                      : ""}
                  </span>
                </span>
                {t.action === "restart" && (
                  <input
                    key={`${t.id}-${(t.announceMinutes ?? []).join(",")}`}
                    defaultValue={(t.announceMinutes ?? []).join(",")}
                    placeholder="5,1"
                    title="Minutes before the restart to announce in the server console (comma-separated)"
                    disabled={busy}
                    onBlur={(e) => {
                      const minutes = e.target.value
                        .split(",")
                        .map((v) => parseInt(v.trim(), 10))
                        .filter((n) => Number.isFinite(n) && n > 0);
                      void persist(
                        tasks.map((x) =>
                          x.id === t.id ? { ...x, announceMinutes: minutes } : x,
                        ),
                      );
                    }}
                    className="w-14 bg-bg-core border border-grid-bounds px-1 py-0.5 text-[10px] font-mono text-zinc-300 shrink-0"
                  />
                )}
                <button
                  onClick={() => void runNow(t)}
                  disabled={busy}
                  className="text-zinc-500 hover:text-signal-high shrink-0"
                >
                  run
                </button>
                <button
                  onClick={() => void persist(tasks.filter((x) => x.id !== t.id))}
                  disabled={busy}
                  className="text-zinc-500 hover:text-fault-vector shrink-0"
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Add-task form */}
        <div className="pt-3 mt-1 border-t border-grid-bounds space-y-2">
          <p className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
            add task
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="name (optional)"
              className={`${inputCls} flex-1 min-w-[140px]`}
            />
            <select
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
              className={inputCls}
            >
              {TASK_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              className={inputCls}
            >
              <option value="interval">every N hours</option>
              <option value="daily">daily at</option>
              <option value="cron">cron</option>
            </select>
            {mode === "interval" && (
              <input
                type="number"
                min={1}
                value={intervalHours}
                onChange={(e) => setIntervalHours(parseInt(e.target.value) || 1)}
                className={`${inputCls} w-20`}
              />
            )}
            {mode === "daily" && (
              <input
                type="time"
                value={draft.dailyAt}
                onChange={(e) => setDraft({ ...draft, dailyAt: e.target.value })}
                className={inputCls}
              />
            )}
            {mode === "cron" && (
              <input
                value={draft.cron}
                onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                placeholder="0 4 * * *"
                className={`${inputCls} w-36`}
              />
            )}
          </div>
          {(draft.action === "command" || draft.action === "health") && (
            <input
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder={
                draft.action === "command"
                  ? "command (stdin when running, shell when stopped)"
                  : "health policy: notify or restart"
              }
              className={`${inputCls} w-full`}
            />
          )}
          <button onClick={add} disabled={busy} className="btn-mono-primary">
            add task
          </button>
        </div>
      </div>
    </Card>
  );
}

/* ── RCON console / players ───────────────────────────────────────────── */

interface RconStatus {
  host: string;
  port: number;
  hasPassword: boolean;
}

function RconCard({
  server,
  notify,
}: {
  server: ServerInstance;
  notify: ReturnType<typeof useToast>["notify"];
}) {
  const [status, setStatus] = useState<RconStatus | null>(null);
  const [host, setHost] = useState(server.rcon?.host ?? "127.0.0.1");
  const [port, setPort] = useState(server.rcon?.port ?? 25575);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<"unknown" | "ok" | "failed">("unknown");
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [players, setPlayers] = useState<string[]>([]);
  const [pendingKick, setPendingKick] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<RconStatus>("rcon_get_status", { id: server.id })
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setHost(s.host);
        setPort(s.port);
      })
      .catch(() => {});
    setConnection("unknown");
    setOutput([]);
    setPlayers([]);
    return () => {
      cancelled = true;
    };
  }, [server.id]);

  async function saveConfig() {
    setBusy(true);
    try {
      await invoke("rcon_set_config", {
        id: server.id,
        host,
        port,
        password: password ? password : null,
      });
      setPassword("");
      notify({ kind: "success", title: "RCON settings saved" });
      setStatus(await invoke<RconStatus>("rcon_get_status", { id: server.id }));
    } catch (e) {
      notify({ kind: "error", title: "Save failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    try {
      await invoke("rcon_test", { id: server.id });
      setConnection("ok");
      notify({ kind: "success", title: "RCON connected" });
    } catch (e) {
      setConnection("failed");
      notify({ kind: "error", title: "RCON connection failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function appendOutput(line: string) {
    setOutput((prev) => [...prev.slice(-199), line]);
    requestAnimationFrame(() => {
      consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
    });
  }

  async function send() {
    const trimmed = command.trim();
    if (!trimmed) return;
    appendOutput(`> ${trimmed}`);
    setCommand("");
    setBusy(true);
    try {
      const response = await invoke<string>("rcon_execute", {
        id: server.id,
        command: trimmed,
      });
      if (response) appendOutput(response);
      if (trimmed.toLowerCase().startsWith("list")) {
        void refreshPlayers();
      }
    } catch (e) {
      appendOutput(`[error] ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPlayers() {
    try {
      const res = await invoke<{ raw: string; players: string[] }>("rcon_players", {
        id: server.id,
      });
      setPlayers(res.players);
      if (res.raw) appendOutput(res.raw);
    } catch (e) {
      appendOutput(`[error] ${String(e)}`);
    }
  }

  async function kick(name: string) {
    setPendingKick(null);
    setBusy(true);
    try {
      await invoke("rcon_execute", { id: server.id, command: `kick ${name}` });
      notify({ kind: "success", title: `kicked ${name}` });
      await refreshPlayers();
    } catch (e) {
      notify({ kind: "error", title: "Kick failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "bg-bg-core border border-grid-bounds px-2 py-1 text-[11px] text-zinc-200 font-mono";

  return (
    <Card title="RCON console">
      <div className="space-y-3">
        {/* Connection settings */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="host"
            className={`${inputCls} w-36`}
          />
          <input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(parseInt(e.target.value) || 25575)}
            className={`${inputCls} w-24`}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={status?.hasPassword ? "•••••• (saved)" : "password"}
            className={`${inputCls} w-40`}
          />
          <button onClick={saveConfig} disabled={busy} className="btn-mono">
            save
          </button>
          <button onClick={testConnection} disabled={busy} className="btn-mono">
            test
          </button>
          {connection === "ok" && (
            <span className="text-[10px] text-signal-high">connected</span>
          )}
          {connection === "failed" && (
            <span className="text-[10px] text-fault-vector">failed</span>
          )}
        </div>
        <p className="text-[10px] text-zinc-600">
          Password is stored in the OS credential vault, not in config.
        </p>

        {/* Console */}
        <div
          ref={consoleRef}
          className="h-40 overflow-y-auto bg-bg-core border border-grid-bounds p-2 font-mono text-[11px] text-zinc-300 whitespace-pre-wrap break-all"
        >
          {output.length === 0 ? (
            <span className="text-zinc-700">console output appears here…</span>
          ) : (
            output.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex items-center gap-2"
        >
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="e.g. list, say hello, time set day"
            className={`${inputCls} flex-1`}
          />
          <button type="submit" disabled={busy || !command.trim()} className="btn-mono-primary">
            send
          </button>
        </form>

        {/* Players */}
        <div className="pt-2 border-t border-grid-bounds">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
              online players {players.length > 0 ? `(${players.length})` : ""}
            </span>
            <button
              onClick={() => void refreshPlayers()}
              className="text-[10px] text-zinc-400 hover:text-signal-high"
            >
              refresh
            </button>
          </div>
          {players.length === 0 ? (
            <p className="text-[11px] text-zinc-600">
              no players (or run "refresh" while connected).
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {players.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 text-[10px] border border-grid-bounds px-1.5 py-0.5 text-zinc-300"
                >
                  {name}
                  {pendingKick === name ? (
                    <>
                      <button
                        onClick={() => void kick(name)}
                        disabled={busy}
                        className="text-fault-vector hover:underline"
                      >
                        confirm kick
                      </button>
                      <button
                        onClick={() => setPendingKick(null)}
                        className="text-zinc-500 hover:text-zinc-200"
                      >
                        cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setPendingKick(name)}
                      className="text-zinc-500 hover:text-fault-vector"
                    >
                      kick
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ── Find & replace across files ──────────────────────────────────────── */

function FindReplaceCard({
  server,
  notify,
}: {
  server: ServerInstance;
  notify: ReturnType<typeof useToast>["notify"];
}) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!find) return;
    setBusy(true);
    try {
      const res = await invoke<ReplaceResult>("find_replace_in_files", {
        id: server.id,
        query: find,
        replacement: replace,
        exclude: "node_modules/**,.git/**,target/**,backups/**",
      });
      notify({
        kind: res.filesChanged > 0 ? "success" : "info",
        title: res.filesChanged > 0 ? `Replaced in ${res.filesChanged} files` : "No matches",
        message: `${res.replacements} replacement${res.replacements !== 1 ? "s" : ""}`,
      });
    } catch (e) {
      notify({ kind: "error", title: "Replace failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="find & replace across files">
      <div className="space-y-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="find"
          className="w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 font-mono"
        />
        <input
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          placeholder="replace with"
          className="w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 font-mono"
        />
        <p className="text-[10px] text-zinc-600">
          Case-sensitive. Excludes node_modules, .git, target, backups. Max 500 files, 1 MiB each.
        </p>
        <button onClick={run} disabled={busy || !find} className="btn-mono-primary">
          replace all
        </button>
      </div>
    </Card>
  );
}
