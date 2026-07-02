import type { ReactNode } from "react";

/*
  Small inline chip. Tone is semantic only.
    signal  = signal-high (active / running / featured)
    warn    = warn-vector (transitional)
    fault   = fault-vector (error)
    muted   = signal-low (standby)
*/
type Tone = "signal" | "warn" | "fault" | "muted";

const tones: Record<Tone, string> = {
  signal: "text-signal-high bg-signal-high/10 ring-signal-high/30",
  warn: "text-warn-vector bg-warn-vector/10 ring-warn-vector/30",
  fault: "text-fault-vector bg-fault-vector/10 ring-fault-vector/30",
  muted: "text-signal-low bg-signal-low/10 ring-signal-low/30",
};

export function Badge({
  children,
  tone = "muted",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] leading-none ring-1 ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* verified publisher glyph + label */
export function VerifiedBadge() {
  return (
    <Badge tone="signal" className="gap-1">
      <svg
        aria-hidden="true"
        width="10"
        height="10"
        viewBox="0 0 10 10"
        className="inline-block"
      >
        <path
          d="M3.5 6.5L1.8 4.8l-.9.9L3.5 8.3l5-5-.9-.9z"
          fill="currentColor"
        />
      </svg>
      verified
    </Badge>
  );
}
