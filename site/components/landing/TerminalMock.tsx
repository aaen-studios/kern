"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { StatusDots } from "@/components/ui/StatusDots";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { useReducedMotion } from "motion/react";

/*
  Live interactive terminal — §10.4.
  Type commands at the dispatch prompt and watch simulated server output
  stream in with realistic delays. A taste of the kern terminal experience
  that doesn't require installing anything.

  Commands: help, clear, kern list, kern install <name>, kern start <name>,
  kern stop <name>. Unknown commands get a playful error.
*/

const SERVERS = [
  { id: "web_api", runtime: "node 22", port: 3000 },
  { id: "discord_bot", runtime: "bun 1.2", port: 0 },
  { id: "minecraft_vanilla", runtime: "java 21", port: 25565 },
  { id: "postgres", runtime: "postgres 16", port: 5432 },
];

type ServerState = "offline" | "starting" | "running" | "stopping";

const STATUS_DOT: Record<ServerState, "idle" | "breathe" | "wave" | "blink"> = {
  offline: "idle",
  starting: "breathe",
  running: "wave",
  stopping: "blink",
};

type LogEntry = {
  ts: string;
  text: string;
  tone: "info" | "success" | "warn" | "error" | "dim";
};

const TONE_CLASS: Record<LogEntry["tone"], string> = {
  info: "text-zinc-300",
  success: "text-signal-high",
  warn: "text-warn-vector",
  error: "text-fault-vector",
  dim: "text-signal-low",
};

function now() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function logLine(text: string, tone: LogEntry["tone"] = "info"): LogEntry {
  return { ts: now(), text, tone };
}

export function TerminalMock() {
  const reduce = useReducedMotion();
  const [logs, setLogs] = useState<LogEntry[]>([
    logLine("Terminal ready — type a command to begin", "dim"),
    logLine('Try: help, kern list, kern install <name>', "dim"),
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverStates, setServerStates] = useState<Record<string, ServerState>>(
    () => Object.fromEntries(SERVERS.map((s) => [s.id, "offline"])),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hasUserInteracted = useRef(false);

  // Auto-scroll to bottom when logs update (skip initial mount + only when user has interacted)
  useEffect(() => {
    if (hasUserInteracted.current) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const addLogs = useCallback((lines: LogEntry[]) => {
    setLogs((prev) => [...prev, ...lines]);
  }, []);

  const appendLog = useCallback(
    (text: string, tone: LogEntry["tone"] = "info") => {
      addLogs([logLine(text, tone)]);
    },
    [addLogs],
  );

  const delayedAppend = useCallback(
    (text: string, tone: LogEntry["tone"], delay: number) => {
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          appendLog(text, tone);
          resolve();
        }, delay);
        abortRef.current = new AbortController();
        abortRef.current.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
    [appendLog],
  );

  const updateServer = useCallback((id: string, state: ServerState) => {
    setServerStates((prev) => ({ ...prev, [id]: state }));
  }, []);

  const runCommand = useCallback(
    async (cmd: string) => {
      if (busy) return;
      hasUserInteracted.current = true;
      setBusy(true);
      abortRef.current?.abort();
      abortRef.current = null;

      const trimmed = cmd.trim().toLowerCase();
      const parts = trimmed.split(/\s+/);

      appendLog(`$ ${cmd}`, "dim");

      if (trimmed === "" || trimmed === "help") {
        await delayedAppend("available commands:", "dim", 100);
        await delayedAppend("  help                        — show this", "info", 80);
        await delayedAppend("  clear                       — clear terminal", "info", 80);
        await delayedAppend("  kern list                   — list running servers", "info", 80);
        await delayedAppend("  kern install <name>          — install a server type", "info", 80);
        await delayedAppend("  kern start <name>            — start a server", "info", 80);
        await delayedAppend("  kern stop <name>             — stop a server", "info", 80);
        await delayedAppend("  kern ping                   — ping the kern daemon", "info", 80);
        await delayedAppend("available servers:", "dim", 100);
        SERVERS.forEach((s) => {
          appendLog(`  ${s.id} (${s.runtime})`, "info");
        });
      } else if (trimmed === "clear") {
        setLogs([]);
      } else if (parts[0] === "kern" && parts[1] === "list") {
        const running = SERVERS.filter((s) => serverStates[s.id] === "running");
        if (running.length === 0) {
          await delayedAppend("no servers running.", "warn", 150);
        } else {
          await delayedAppend(`${running.length} server(s) running:`, "dim", 100);
          for (const s of running) {
            await delayedAppend(
              `  ${s.id} · ${s.runtime} · port ${s.port} · running`,
              "success",
              120,
            );
          }
        }
      } else if (parts[0] === "kern" && parts[1] === "ping") {
        await delayedAppend("pong · kern daemon is alive (pid 3821)", "success", 200);
      } else if (
        parts[0] === "kern" &&
        (parts[1] === "install" || parts[1] === "start" || parts[1] === "stop")
      ) {
        const name = parts[2];
        const server = SERVERS.find((s) => s.id === name);
        if (!server) {
          await delayedAppend(
            `unknown server "${name ?? ""}". try: kern list`,
            "error",
            150,
          );
        } else if (parts[1] === "install") {
          if (serverStates[server.id] !== "offline") {
            await delayedAppend(`${server.id} is already installed.`, "warn", 150);
          } else {
            await delayedAppend(`installing ${server.id}…`, "info", 200);
            updateServer(server.id, "starting");
            await delayedAppend(`  downloading ${server.runtime} runtime…`, "info", reduce ? 200 : 500);
            await delayedAppend(`  extracting…`, "info", reduce ? 200 : 600);
            await delayedAppend(`  writing manifest…`, "info", reduce ? 200 : 400);
            await delayedAppend(`  ✔ ${server.id} installed (${server.runtime})`, "success", reduce ? 200 : 500);
            updateServer(server.id, "offline");
          }
        } else if (parts[1] === "start") {
          if (serverStates[server.id] === "running") {
            await delayedAppend(`${server.id} is already running.`, "warn", 150);
          } else {
            await delayedAppend(`starting ${server.id}…`, "info", 200);
            updateServer(server.id, "starting");
            await delayedAppend(`  spawning process…`, "info", reduce ? 150 : 400);
            await delayedAppend(`  listening on 0.0.0.0:${server.port}`, "success", reduce ? 150 : 500);
            await delayedAppend(`  ✔ ${server.id} is running`, "success", reduce ? 150 : 300);
            updateServer(server.id, "running");
          }
        } else if (parts[1] === "stop") {
          if (serverStates[server.id] === "offline") {
            await delayedAppend(`${server.id} is not running.`, "warn", 150);
          } else {
            await delayedAppend(`stopping ${server.id}…`, "info", 200);
            updateServer(server.id, "stopping");
            await delayedAppend(`  sending SIGTERM…`, "info", reduce ? 150 : 400);
            await delayedAppend(`  draining active connections…`, "info", reduce ? 150 : 600);
            await delayedAppend(`  ✔ ${server.id} stopped gracefully`, "success", reduce ? 150 : 400);
            updateServer(server.id, "offline");
          }
        }
      } else if (
        parts[0] === "kern" &&
        parts[1] === "status"
      ) {
        // Show all servers and their states
        await delayedAppend("server status:", "dim", 100);
        for (const s of SERVERS) {
          const state = serverStates[s.id];
          await delayedAppend(
            `  ${s.id} · ${s.runtime} · ${state === "offline" ? "🟢" : "🟢"} ${state}`,
            state === "running" ? "success" : "dim",
            120,
          );
        }
      } else {
        await delayedAppend(
          `unknown command: ${cmd}. try: help`,
          "error",
          150,
        );
      }

      setBusy(false);
    },
    [busy, serverStates, appendLog, delayedAppend, updateServer, reduce],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy || !input.trim()) return;
    runCommand(input.trim());
    setInput("");
  };

  // A running server count for the header bar
  const runningCount = Object.values(serverStates).filter(
    (s) => s === "running",
  ).length;
  const headerStatus =
    runningCount > 0
      ? { dots: "wave" as const, label: `${runningCount} running` }
      : { dots: "idle" as const, label: "no servers active" };

  /* Derive a mock "latest.log" label from servers */
  const activeLabel =
    runningCount > 0
      ? `kern · ${runningCount} server${runningCount > 1 ? "s" : ""} running`
      : "kern · terminal";

  return (
    <section id="features" className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <Reveal>
        <SectionHeading kicker="live terminal" title="stream stdout. pipe stdin.">
          process stdout/stderr streamed live to the ui, appended to
          latest.log, with full ansi color parsing. type a command below to try
          it yourself.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div
          className="overflow-hidden bg-bg-core"
          style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
        >
          {/* window chrome */}
          <div className="flex items-center justify-between border-b border-grid-bounds/60 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-fault-vector/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-warn-vector/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-signal-high/70" />
            </div>
            <span className="font-mono text-[11px] lowercase text-signal-low">
              {activeLabel}
            </span>
            <StatusDots status={headerStatus.dots} label={headerStatus.label} count={5} />
          </div>

          {/* log body — scrollable */}
          <div
            className="h-72 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed"
            role="log"
            aria-live="polite"
            onClick={() => inputRef.current?.focus()}
          >
            {logs.length === 0 && (
              <p className="text-signal-low/60 italic">terminal cleared.</p>
            )}
            {logs.map((l, i) => (
              <div key={i} className="flex gap-3">
                <span className="shrink-0 text-signal-low/70">[{l.ts}]</span>
                <span className={TONE_CLASS[l.tone]}>{l.text}</span>
              </div>
            ))}
            {busy && (
              <div className="mt-1 flex items-center gap-2">
                <span className="inline-block h-3 w-2 animate-pulse bg-signal-high/80" />
              </div>
            )}
            <div ref={logEndRef} />
          </div>

          {/* input / dispatcher */}
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 border-t border-grid-bounds/60 px-4 py-2.5"
          >
            <span className="font-mono text-[11px] text-signal-low shrink-0">
              dispatch:
            </span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
              placeholder={busy ? "running…" : "type a command or help"}
              aria-label="terminal command"
              className="flex-1 bg-transparent font-mono text-[11px] text-zinc-200 placeholder:text-signal-low/40 focus:outline-none disabled:opacity-50"
              autoComplete="off"
              spellCheck={false}
            />
            {busy ? (
              <StatusDots status="breathe" label="busy" count={3} />
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="rounded-sm bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-signal-low ring-1 ring-grid-bounds transition hover:text-signal-high disabled:opacity-30"
              >
                enter
              </button>
            )}
          </form>
        </div>
      </Reveal>
    </section>
  );
}