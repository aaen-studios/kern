import type { ReactNode } from "react";

/*
  StatRow — a labelled value in an instrument readout. Used by the hero HUD
  and the comparison table. Tone is semantic; default is standby.
*/

type Tone = "signal" | "warn" | "fault" | "muted";

const tones: Record<Tone, string> = {
  signal: "text-signal-high",
  warn: "text-warn-vector",
  fault: "text-fault-vector",
  muted: "text-zinc-300",
};

export function StatRow({
  label,
  value,
  tone = "muted",
  note,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 border-b border-grid-bounds/50 py-2.5 ${className}`}
    >
      <span className="font-mono text-[11px] lowercase text-signal-low">
        {label}
      </span>
      <span className="text-right">
        <span className={`font-mono text-xs lowercase ${tones[tone]}`}>
          {value}
        </span>
        {note && (
          <span className="ml-2 font-mono text-[10px] lowercase text-signal-low/70">
            {note}
          </span>
        )}
      </span>
    </div>
  );
}
