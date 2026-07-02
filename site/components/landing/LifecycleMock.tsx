import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { StatusDots } from "@/components/ui/StatusDots";

/*
  §10.6 — Lifecycle. Start / Stop / Restart / Install, driven by each plugin's
  lifecycle manifest block. Graceful shutdown with a 15-second timeout before
  hard-kill — deliberately tuned so minecraft world saves complete
  (chunk flush + level.dat) before teardown.
*/

function LifeButton({
  label,
  tone,
}: {
  label: string;
  tone: "signal" | "warn" | "fault" | "muted";
}) {
  const cls = {
    signal: "text-signal-high ring-signal-high/40 hover:bg-signal-high/10",
    warn: "text-warn-vector ring-warn-vector/40 hover:bg-warn-vector/10",
    fault: "text-fault-vector ring-fault-vector/40 hover:bg-fault-vector/10",
    muted: "text-signal-low ring-grid-bounds hover:text-zinc-300",
  }[tone];
  return (
    <button
      type="button"
      disabled
      className={`inline-flex items-center gap-2 bg-bg-surface px-4 py-2 font-mono text-xs lowercase ring-1 transition-colors ${cls}`}
    >
      {label}
    </button>
  );
}

export function LifecycleMock() {
  return (
    <section className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <Reveal>
        <SectionHeading kicker="lifecycle" title="start. stop. restart. gracefully.">
          driven by each plugin&rsquo;s lifecycle manifest. commands support{" "}
          <code className="text-signal-high">{"{{userOverrides.*}}"}</code>{" "}
          templating resolved at launch by rust.
        </SectionHeading>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
          {/* controls */}
          <div
            className="bg-bg-core p-6"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="mb-5 flex items-center justify-between border-b border-grid-bounds/50 pb-3">
              <span className="font-mono text-[11px] lowercase text-signal-low">
                discord_bot · lifecycle
              </span>
              <StatusDots status="breathe" label="starting" count={4} />
            </div>
            <div className="flex flex-wrap gap-3">
              <LifeButton label="start" tone="signal" />
              <LifeButton label="stop" tone="warn" />
              <LifeButton label="restart" tone="muted" />
              <LifeButton label="install" tone="fault" />
            </div>
          </div>

          {/* graceful shutdown callout */}
          <div
            className="flex flex-col justify-center bg-warn-vector/5 p-6 ring-1 ring-warn-vector/30"
          >
            <p className="font-mono text-[11px] lowercase text-warn-vector">
              {"// "}graceful shutdown
            </p>
            <p className="mt-2 font-mono text-sm lowercase text-zinc-200">
              15-second timeout before hard-kill.
            </p>
            <p className="mt-2 font-mono text-xs text-signal-low">
              deliberately tuned so minecraft world saves complete — chunk flush
              and level.dat — before teardown. no silent drops.
            </p>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
