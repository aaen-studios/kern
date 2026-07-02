import type { CSSProperties } from "react";

/*
  A row of light-emitting micro-nodes (§3.5). Color is semantic:
    wave    = signal-high, traveling wave      (running / active)
    breathe = warn-vector, slow breathe         (starting / installing)
    blink   = fault-vector, rapid blink         (error / terminated)
    idle    = signal-low, static                (standby / offline)
  Stagger animation-delay per dot to create the wave.
  Each dot carries an sr-only text label for screen readers.
*/
type Status = "wave" | "breathe" | "blink" | "idle";

const statusColor: Record<Status, string> = {
  wave: "bg-signal-high",
  breathe: "bg-warn-vector",
  blink: "bg-fault-vector",
  idle: "bg-signal-low",
};

const statusAnim: Record<Status, string> = {
  wave: "dot-wave",
  breathe: "dot-breathe",
  blink: "dot-blink",
  idle: "none",
};

export function StatusDots({
  count = 5,
  status = "wave",
  label,
  className = "",
}: {
  count?: number;
  status?: Status;
  label: string; // required sr-only text label
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`}
      role="img"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }).map((_, i) => {
        const style: CSSProperties =
          status === "idle"
            ? {}
            : { animation: `${statusAnim[status]} 1.4s ease-in-out infinite`,
                animationDelay: `${(i / count) * 1.4}s` };
        return (
          <span
            key={i}
            aria-hidden="true"
            style={style}
            className={`inline-block h-1.5 w-1.5 rounded-full ${statusColor[status]}`}
          />
        );
      })}
    </span>
  );
}
