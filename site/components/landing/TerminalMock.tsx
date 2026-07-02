import { StatusDots } from "@/components/ui/StatusDots";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";

/*
  §10.4 — Live terminal mockup. Faux terminal with a streaming dot-wave status
  banner and ANSI-colored sample log lines. Streams live in the real app;
  here it's a static taste of the voice. Input box doubles as a command
  dispatcher (start/stop/restart/install).
*/

// ANSI-ish color mapping → semantic token classes (the app parses real ANSI).
const LOGS: Array<{ ts: string; level: string; msg: string; tone: string }> = [
  {
    ts: "12:04:28",
    level: "INFO",
    msg: "Starting web server (node 22)",
    tone: "text-zinc-300",
  },
  {
    ts: "12:04:29",
    level: "WARN",
    msg: "No .env found, using defaults",
    tone: "text-warn-vector",
  },
  {
    ts: "12:04:31",
    level: "INFO",
    msg: "listening on 0.0.0.0:3000",
    tone: "text-signal-high",
  },
  {
    ts: "12:05:02",
    level: "INFO",
    msg: "GET /api/health 200 2ms",
    tone: "text-zinc-300",
  },
  {
    ts: "12:05:44",
    level: "INFO",
    msg: "POST /api/users 201 14ms",
    tone: "text-zinc-400",
  },
  {
    ts: "12:05:44",
    level: "INFO",
    msg: "server ready",
    tone: "text-signal-high",
  },
];

const levelColor: Record<string, string> = {
  INFO: "text-signal-high",
  WARN: "text-warn-vector",
  ERROR: "text-fault-vector",
};

export function TerminalMock() {
  return (
    <section id="features" className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <Reveal>
        <SectionHeading kicker="live terminal" title="stream stdout. pipe stdin.">
          process stdout/stderr streamed live to the ui, appended to
          latest.log, with full ansi color parsing, dimmed timestamps, and
          command history. the input box is a command dispatcher.
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
              web_api · latest.log
            </span>
            <StatusDots status="wave" label="streaming — running" count={5} />
          </div>

          {/* log body */}
          <div className="p-4 font-mono text-[12px] leading-relaxed">
            {LOGS.map((l, i) => (
              <div key={i} className="flex gap-3">
                <span className="shrink-0 text-signal-low/70">[{l.ts}]</span>
                <span
                  className={`shrink-0 ${levelColor[l.level] ?? "text-zinc-400"}`}
                >
                  [{l.level}]
                </span>
                <span className={l.tone}>{l.msg}</span>
              </div>
            ))}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-signal-high">$</span>
              <span className="inline-block h-3.5 w-2 animate-pulse bg-signal-high/80" />
            </div>
          </div>

          {/* input / dispatcher */}
          <div className="flex items-center gap-2 border-t border-grid-bounds/60 px-4 py-2.5">
            <span className="font-mono text-[11px] text-signal-low">dispatch:</span>
            <span className="rounded-sm bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-signal-low ring-1 ring-grid-bounds">
              start
            </span>
            <span className="rounded-sm bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-signal-low ring-1 ring-grid-bounds">
              stop
            </span>
            <span className="rounded-sm bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-signal-low ring-1 ring-grid-bounds">
              restart
            </span>
            <span className="font-mono text-[11px] text-signal-low/60">
              · or type a command
            </span>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
