import { RadarMark } from "@/components/brand/RadarMark";
import { formatVersion } from "@/lib/github";

/*
  Latest-version chip. Shows the radar glyph + v{tag}.
  Renders `—` when no release is available (null-safe).
*/
export function VersionBadge({ tag }: { tag?: string | null }) {
  return (
    <span className="inline-flex h-10 items-center gap-2 bg-bg-surface px-3 py-1.5 ring-1 ring-grid-bounds">
      <RadarMark size="sm" />
      <span className="font-mono text-xs lowercase text-signal-low">latest</span>
      <span className="font-mono text-xs text-signal-high">
        {tag ? formatVersion(tag) : "—"}
      </span>
    </span>
  );
}
