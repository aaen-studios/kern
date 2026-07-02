import type { Release } from "@/lib/github";
import { formatVersion } from "@/lib/github";
import { Markdown } from "@/lib/markdown";
import { RadarMark } from "@/components/brand/RadarMark";

/*
  §9.1 — a single release entry. Version badge (radar glyph + v{tag}),
  formatted published_at, a view-on-github link, and the rendered body.
*/
export function ReleaseCard({ release }: { release: Release }) {
  const date = new Date(release.published_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const title = release.name && release.name.trim().length > 0
    ? release.name
    : formatVersion(release.tag_name);

  return (
    <article className="border-l border-grid-bounds pl-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <RadarMark size="sm" />
        <span className="font-mono text-sm text-signal-high">
          {formatVersion(release.tag_name)}
        </span>
        <span className="font-mono text-[11px] text-signal-low">{date}</span>
        <a
          href={release.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto font-mono text-[11px] lowercase text-signal-low transition-colors hover:text-signal-high"
        >
          view on github ↗
        </a>
      </div>

      {release.name && release.name.trim() && (
        <h3 className="mb-3 font-mono text-lg lowercase text-zinc-100">
          {title}
        </h3>
      )}

      {release.body ? (
        <Markdown content={release.body} />
      ) : (
        <p className="font-mono text-xs text-signal-low">no release notes.</p>
      )}
    </article>
  );
}
