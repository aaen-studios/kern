import { SectionHeading, Reveal } from "@/components/ui/Reveal";

/*
  §10.5 — Reactor channel / telemetry. The matrix bar mockup with cpu/ram/
  log-activity readouts. Real-time CPU + RAM per instance via sysinfo; turns
  amber >90% cpu and red on fault.
*/

function Channel({
  label,
  value,
  pct,
  bars,
  tone,
}: {
  label: string;
  value: string;
  pct: number;
  bars: number;
  tone: "signal" | "warn" | "fault";
}) {
  const active = Math.round((pct / 100) * bars);
  const color =
    tone === "warn"
      ? "bg-warn-vector"
      : tone === "fault"
        ? "bg-fault-vector"
        : "bg-signal-high";
  return (
    <div className="flex items-center gap-4">
      <span className="w-16 shrink-0 font-mono text-[11px] lowercase text-signal-low">
        {label}
      </span>
      <div className="flex flex-1 gap-[3px]">
        {Array.from({ length: bars }).map((_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`h-4 flex-1 ${i < active ? color : "bg-grid-bounds"}`}
          />
        ))}
      </div>
      <span
        className={`w-14 shrink-0 text-right font-mono text-[11px] ${
          tone === "warn"
            ? "text-warn-vector"
            : tone === "fault"
              ? "text-fault-vector"
              : "text-signal-high"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function ReactorMock() {
  return (
    <section className="border-y border-grid-bounds/40 bg-bg-surface/30">
      <div className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
        <Reveal>
          <SectionHeading
            kicker="reactor channel"
            title="per-process telemetry"
          >
            real-time cpu + ram per instance via sysinfo, surfaced as a reactor
            channel matrix bar that turns amber above 90% cpu and red on fault.
          </SectionHeading>
        </Reveal>

        <Reveal delay={0.1}>
          <div
            className="bg-bg-core p-6"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="mb-5 flex items-center justify-between border-b border-grid-bounds/50 pb-3">
              <span className="font-mono text-[11px] lowercase text-signal-low">
                web_api · reactor
              </span>
              <span className="font-mono text-[11px] lowercase text-signal-high">
                running
              </span>
            </div>
            <div className="space-y-3">
              <Channel label="cpu" value="34%" pct={34} bars={24} tone="signal" />
              <Channel label="ram" value="2.1g" pct={52} bars={24} tone="signal" />
              <Channel
                label="heap"
                value="91%"
                pct={91}
                bars={24}
                tone="warn"
              />
              <Channel
                label="log/s"
                value="18"
                pct={18}
                bars={24}
                tone="signal"
              />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
