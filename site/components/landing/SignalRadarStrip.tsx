import { RadarMark } from "@/components/brand/RadarMark";
import { Section } from "@/components/ui/Section";

/*
  §10.3 — Signal Radar / brand strip. A short, poetic paragraph in the kern
  voice explaining the radar metaphor: status as light-emitting micro-nodes.
*/
export function SignalRadarStrip() {
  return (
    <Section band size="tight">
      <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
        <RadarMark size="lg" className="shrink-0" />
        <div className="max-w-2xl">
          <p className="font-mono text-sm lowercase leading-relaxed text-zinc-300">
            every status is a signal. kern renders instance state as arrays of
            light-emitting micro-nodes — a glowing core, concentric rings, a
            slow sweep. green is running, amber is transitional, crimson is
            fault. the panel never lies about what&rsquo;s alive.
          </p>
        </div>
      </div>
    </Section>
  );
}
