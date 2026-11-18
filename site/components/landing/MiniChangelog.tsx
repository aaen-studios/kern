import Link from "next/link";
import type { Release } from "@/lib/github";
import { formatVersion } from "@/lib/github";
import { RadarMark } from "@/components/brand/RadarMark";

/*
  Mini-changelog excerpt for the landing download section (§10.10).
  Shows the first 3 releases; links to /changelog for the full feed.
*/
export function MiniChangelog({ releases }: { releases: Release[] }) {
  if (releases.length === 0) return null;

  return (
    <div className="mt-10">
      <div className="mb-4 flex items-center justify-between">
        <p className="font-mono text-xs lowercase text-signal-low">
          {"// "}latest.log · releases
        </p>
        <Link
          href="/changelog"
          className="font-mono text-[11px] lowercase text-signal-high transition hover:brightness-125"
        >
          full changelog →
        </Link>
      </div>
      <ul className="space-y-3">
        {releases.slice(0, 3).map((r) => (
          <li
            key={r.tag_name}
            className="flex items-start gap-3 border-l border-grid-bounds pl-3"
          >
            <RadarMark size="sm" className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-signal-high">
                  {formatVersion(r.tag_name)}
                </span>
                <span className="font-mono text-[11px] text-signal-low">
                  {new Date(r.published_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-1 font-mono text-[11px] text-signal-low">
                {(r.name || r.body || "release").replace(/[#*`]/g, "").slice(0, 90)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
