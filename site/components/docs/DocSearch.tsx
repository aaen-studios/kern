"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { DocMeta, SearchSection } from "@/lib/docs";

/*
  Docs search. Full-text over per-section chunks built at compile time in
  lib/docs.ts (intro + one chunk per heading), with a tiny scorer and snippet
  extraction — no search index download, no dependency beyond what the page
  already ships. Titles still match well because they're part of every chunk.

  Keyboard: Cmd/Ctrl+K focuses, ↑/↓ move through results, Enter opens,
  Escape clears.
*/

interface Result {
  section: SearchSection;
  score: number;
  snippet: { before: string; match: string; after: string };
}

function scoreSection(section: SearchSection, term: string): number {
  const haystack = `${section.heading ?? ""} ${section.title} ${section.text}`.toLowerCase();
  let index = haystack.indexOf(term);
  if (index === -1) return 0;
  let count = 0;
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  const headingBoost = section.heading?.toLowerCase().includes(term) ? 3 : 0;
  const titleBoost = section.title.toLowerCase().includes(term) ? 2 : 0;
  return count + headingBoost + titleBoost;
}

function makeSnippet(section: SearchSection, term: string) {
  const source = section.text;
  const lower = source.toLowerCase();
  const at = lower.indexOf(term);
  const radius = 70;
  const start = Math.max(0, at - radius);
  const end = Math.min(source.length, at + term.length + radius);
  return {
    before: (start > 0 ? "…" : "") + source.slice(start, at),
    match: at >= 0 ? source.slice(at, at + term.length) : "",
    after: source.slice(at + term.length, end) + (end < source.length ? "…" : ""),
  };
}

export function DocSearch({
  docs,
  sections,
}: {
  docs: DocMeta[];
  sections: SearchSection[];
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results: Result[] | null = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (query.length < 2) return null;

    const scored: Result[] = [];
    const seen = new Set<string>();
    for (const section of sections) {
      const score = scoreSection(section, query);
      if (score <= 0) continue;
      const key = `${section.slug}#${section.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scored.push({ section, score, snippet: makeSnippet(section, query) });
    }
    // Title-only fallback for very short docs where the body chunk missed.
    if (scored.length === 0) {
      for (const doc of docs) {
        if (`${doc.title} ${doc.description}`.toLowerCase().includes(query)) {
          scored.push({
            section: {
              slug: doc.slug,
              title: doc.title,
              group: doc.group,
              heading: null,
              id: null,
              text: doc.description,
            },
            score: 1,
            snippet: { before: "", match: "", after: doc.description },
          });
        }
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 8);
  }, [q, sections, docs]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onInputKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!results || results.length === 0) {
      if (event.key === "Escape") setQ("");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (event.key === "Enter") {
      const result = results[selected];
      if (result) {
        window.location.href = `/docs/${result.section.slug}#${result.section.id ?? ""}`;
      }
    } else if (event.key === "Escape") {
      setQ("");
    }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSelected(0);
        }}
        onKeyDown={onInputKey}
        placeholder="search docs… (⌘K)"
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
              {results.map((result, index) => (
                <li key={`${result.section.slug}-${result.section.id ?? "intro"}`}>
                  <Link
                    href={`/docs/${result.section.slug}#${result.section.id ?? ""}`}
                    onMouseEnter={() => setSelected(index)}
                    className={`block px-2 py-1.5 font-mono text-[11px] lowercase transition-colors ${
                      index === selected
                        ? "bg-bg-surface text-signal-high"
                        : "text-zinc-300 hover:bg-bg-surface hover:text-signal-high"
                    }`}
                  >
                    <span className="text-signal-high">{result.section.title}</span>
                    {result.section.heading && (
                      <span className="ml-2 text-zinc-500">/ {result.section.heading}</span>
                    )}
                    <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">
                      {result.snippet.before}
                      <mark className="bg-signal-high/20 text-signal-high">
                        {result.snippet.match}
                      </mark>
                      {result.snippet.after}
                    </span>
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
