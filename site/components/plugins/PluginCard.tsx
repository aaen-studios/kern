import Link from "next/link";
import type { Plugin } from "@/lib/registry";
import { formatRelativeTime, isOfficial, latestVersion } from "@/lib/registry";
import { Badge, VerifiedBadge } from "@/components/ui/Badge";
import { Odometer } from "@/components/ui/Odometer";

/*
  §7.1 — a single plugin card. icon (radar glyph by category), displayName,
  description, author (+ verified badge), version, category, install count,
  rating, a mini dot-status accent (signal-green if featured/recently updated).
*/
const CATEGORY_GLYPH: Record<string, string> = {
  "game-server": "◈",
  bot: "◆",
  web: "◊",
  database: "▣",
  "dev-tool": "◇",
  other: "○",
};

export function PluginCard({ plugin }: { plugin: Plugin }) {
  const v = latestVersion(plugin);
  const official = isOfficial(plugin.author);

  return (
    <Link
      href={`/plugins/${plugin.id}`}
      className="group flex h-full flex-col gap-3 bg-bg-core p-5 transition-colors hover:bg-bg-surface"
      style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 items-center justify-center bg-bg-surface text-lg text-signal-high ring-1 ring-grid-bounds"
            aria-hidden="true"
          >
            {CATEGORY_GLYPH[plugin.category] ?? "○"}
          </span>
          <div>
            <h3 className="font-mono text-sm lowercase text-zinc-100 group-hover:text-signal-high">
              {plugin.display_name}
            </h3>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] text-signal-low">
                {plugin.author}
              </span>
              {official && <VerifiedBadge />}
            </div>
          </div>
        </div>
        {(plugin.featured || official) && (
          <span className="h-1.5 w-1.5 rounded-full bg-signal-high" aria-hidden="true" />
        )}
      </div>

      <p className="line-clamp-2 font-mono text-[11px] leading-relaxed text-signal-low">
        {plugin.description}
      </p>

      <div className="mt-auto flex items-center justify-between border-t border-grid-bounds/40 pt-3">
        <div className="flex items-center gap-2">
          <Badge tone={official ? "signal" : "muted"}>{plugin.category}</Badge>
          <span className="font-mono text-[10px] text-signal-low">v{v.version}</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] text-signal-low">
          <span>↓ <Odometer value={plugin.install_count} /></span>
          <span>↑ <Odometer value={plugin.rating_sum} /></span>
          <span className="hidden sm:inline">{formatRelativeTime(plugin.updated_at)}</span>
        </div>
      </div>
    </Link>
  );
}