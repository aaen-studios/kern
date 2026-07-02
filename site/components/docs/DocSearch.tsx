"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { DocMeta } from "@/lib/docs";

/*
  Client-side docs search. Filters titles + descriptions across all docs.
  Replaces the sidebar nav with a results list while there's a query.
*/
export function DocSearch({ docs }: { docs: DocMeta[] }) {
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return null;
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(query) ||
        d.description.toLowerCase().includes(query) ||
        d.slug.toLowerCase().includes(query),
    );
  }, [q, docs]);

  return (
    <div className="relative">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search docs…"
        aria-label="search docs"
        className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
      />

      {results && (
        <div className="mt-2">
          {results.length === 0 ? (
            <p className="px-2 py-3 font-mono text-[11px] lowercase text-signal-low">
              no docs match — try clearing the query
            </p>
          ) : (
            <ul className="space-y-0.5">
              {results.map((d) => (
                <li key={d.slug}>
                  <Link
                    href={`/docs/${d.slug}`}
                    className="block px-2 py-1.5 font-mono text-[11px] lowercase text-zinc-300 transition-colors hover:bg-bg-surface hover:text-signal-high"
                  >
                    <span className="text-signal-high">{d.title}</span>
                    <span className="ml-2 text-signal-low">{d.group}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
