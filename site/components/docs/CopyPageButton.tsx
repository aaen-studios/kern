"use client";

import { useState } from "react";

/*
  Copy the full page as markdown for an agent or a note-taking tool. Fetches
  the raw doc on demand (same bytes /raw/docs serves), so the page itself
  stays light.
*/
export function CopyPageButton({ slug }: { slug: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      const res = await fetch(`/raw/docs/${slug}`);
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setState("copied");
    } catch {
      setState("error");
    }
    window.setTimeout(() => setState("idle"), 1400);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="font-mono text-[11px] lowercase text-signal-low transition-colors hover:text-signal-high"
    >
      {state === "copied"
        ? "copied ✓"
        : state === "error"
          ? "copy failed"
          : "copy as markdown"}
    </button>
  );
}
