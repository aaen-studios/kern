/*
  The kern mark — "glowing green signal-radar / emission-core".
  A bright signal-green core with concentric rings of green dots on a
  near-black rounded square, with a soft green radial bloom.
  The simplified single-ring variant is used at small sizes.
  Reproduced as inline SVG. The hero animates rings separately (RadarShader).
*/
type Size = "sm" | "md" | "lg";

const dims: Record<Size, number> = { sm: 20, md: 28, lg: 48 };

const SIGNAL = "#4cf5a0";
const DIM = "#1f3a2c"; // dim green dots

// Generate the dots on a ring of given radius.
function ringDots(cx: number, cy: number, r: number, n: number, fill: string) {
  const dots = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    dots.push(
      <circle
        key={`${r}-${i}`}
        cx={cx + Math.cos(a) * r}
        cy={cy + Math.sin(a) * r}
        r={r > 16 ? 1.6 : 1.2}
        fill={fill}
      />,
    );
  }
  return dots;
}

export function RadarMark({
  size = "md",
  className = "",
}: {
  size?: Size;
  className?: string;
}) {
  const s = dims[size];
  const c = s / 2;
  const isSmall = size === "sm";

  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      className={className}
      role="img"
      aria-label="kern"
    >
      <defs>
        <radialGradient id={`bloom-${size}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={SIGNAL} stopOpacity="0.35" />
          <stop offset="60%" stopColor={SIGNAL} stopOpacity="0.06" />
          <stop offset="100%" stopColor={SIGNAL} stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* rounded near-black square base */}
      <rect
        x="0"
        y="0"
        width={s}
        height={s}
        rx={s * 0.22}
        fill="#0b0c10"
      />
      {/* soft bloom */}
      <rect
        x="0"
        y="0"
        width={s}
        height={s}
        rx={s * 0.22}
        fill={`url(#bloom-${size})`}
      />
      {/* outer ring(s) of dim dots */}
      {!isSmall && ringDots(c, c, s * 0.4, 12, DIM)}
      {ringDots(c, c, s * (isSmall ? 0.34 : 0.27), isSmall ? 8 : 10, DIM)}
      {/* bright core */}
      <circle cx={c} cy={c} r={s * 0.1} fill={SIGNAL} />
      <circle
        cx={c}
        cy={c}
        r={s * 0.1}
        fill="none"
        stroke={SIGNAL}
        strokeOpacity="0.4"
        strokeWidth="1"
      />
    </svg>
  );
}

/* Wordmark — kern lowercase + glyph. Used in the nav and footer. */
export function KernWordmark({
  className = "",
}: {
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <RadarMark size="sm" />
      <span className="font-mono lowercase text-zinc-100 tracking-tight">
        kern
      </span>
    </span>
  );
}
