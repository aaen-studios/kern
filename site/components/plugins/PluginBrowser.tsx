"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Fuse from "fuse.js";
import type { Plugin } from "@/lib/registry";
import { ALL_CATEGORIES, isOfficial } from "@/lib/registry";
import { PluginCard } from "@/components/plugins/PluginCard";
import { StatusDots } from "@/components/ui/StatusDots";
import { Spotlight } from "@/components/ui/Spotlight";

/*
  §7.1 — the interactive browser. Filters/sort/search all drive URL search
  params for shareability. Wrapped in <Suspense> by the page (useSearchParams
  requires it in v16 for statically-prerendered routes).
*/
	type Sort = "popular" | "recent" | "upvotes";
	
	const SORTS: Sort[] = ["popular", "recent", "upvotes"];

export function PluginBrowser({ all }: { all: Plugin[] }) {
  const router = useRouter();
  const params = useSearchParams();

  const q = params.get("q") ?? "";
  const category = params.get("category") ?? "all";
  const sort = (params.get("sort") as Sort) ?? "popular";
  const verified = params.get("verified") === "1";

  const update = (next: Record<string, string | undefined>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "" || v === "all") sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    router.replace(qs ? `/plugins?${qs}` : "/plugins");
  };

  const filtered = useMemo(() => {
    let r = [...all];

    // Fuzzy search via Fuse.js — typo-tolerant, relevance-ranked
    if (q) {
      const fuse = new Fuse(r, {
        keys: [
          { name: "display_name", weight: 3 },
          { name: "description", weight: 1 },
          { name: "tags", weight: 2 },
        ],
        threshold: 0.4,
        minMatchCharLength: 2,
        ignoreLocation: true,
      });
      r = fuse.search(q).map((result) => result.item);
    }

    if (category !== "all") r = r.filter((p) => p.category === category);
    if (verified) r = r.filter((p) => isOfficial(p.author));

    r.sort((a, b) => {
      if (sort === "recent") return b.updated_at - a.updated_at;
      if (sort === "upvotes") return b.rating_sum - a.rating_sum;
      return b.install_count - a.install_count;
    });
    return r;
  }, [all, q, category, sort, verified]);

  return (
    <div>
      {/* controls */}
      <div className="mb-6 flex flex-col gap-3">
        <input
          type="search"
          defaultValue={q}
          onChange={(e) => update({ q: e.target.value })}
          placeholder="search plugins…"
          aria-label="search plugins"
          className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            <CategoryChip
              active={category === "all"}
              onClick={() => update({ category: "all" })}
            >
              all
            </CategoryChip>
            {ALL_CATEGORIES.map((c) => (
              <CategoryChip
                key={c}
                active={category === c}
                onClick={() => update({ category: c })}
              >
                {c}
              </CategoryChip>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] lowercase text-signal-low">
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => update({ verified: e.target.checked ? "1" : undefined })}
                className="accent-signal-high"
              />
              verified only
            </label>
            <select
              value={sort}
              onChange={(e) => update({ sort: e.target.value })}
              aria-label="sort"
              className="bg-bg-core px-2 py-1.5 font-mono text-[11px] lowercase text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* count */}
      <p className="mb-4 font-mono text-xs lowercase text-signal-low">
        registry ({filtered.length})
      </p>

      {/* grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <StatusDots status="idle" label="no plugins match" count={4} />
          <p className="font-mono text-xs lowercase text-signal-low">
            no plugins match — try clearing filters
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <Spotlight key={p.id}>
              <PluginCard plugin={p} />
            </Spotlight>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm px-2.5 py-1 font-mono text-[11px] lowercase ring-1 transition-colors ${
        active
          ? "bg-signal-high/10 text-signal-high ring-signal-high/40"
          : "bg-bg-core text-signal-low ring-grid-bounds hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}
