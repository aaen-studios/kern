"use client";

import { useEffect, useState } from "react";
import type { Heading } from "@/lib/docs";

/*
  Right-rail "on this page" nav. Tracks the section currently under the sticky
  header with an IntersectionObserver and highlights it. Hidden below xl by the
  parent so it never competes with the article on narrow screens.
*/
export function DocToc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState<string | null>(headings[0]?.id ?? null);

  useEffect(() => {
    if (headings.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: "-90px 0px -70% 0px", threshold: [0, 1] },
    );
    for (const heading of headings) {
      const el = document.getElementById(heading.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length < 2) return null;

  return (
    <nav aria-label="on this page" className="text-[11px]">
      <p className="mb-2 font-mono text-[10px] lowercase text-signal-low">
        on this page
      </p>
      <ul className="space-y-1 border-l border-grid-bounds">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              className={`block border-l py-0.5 pl-3 font-mono lowercase leading-snug transition-colors ${
                active === heading.id
                  ? "border-signal-high text-signal-high"
                  : "border-transparent text-zinc-500 hover:text-zinc-200"
              } ${heading.level === 3 ? "pl-6" : ""}`}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
