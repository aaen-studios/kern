"use client";

import { useState } from "react";

/*
  Copy-to-clipboard control rendered over each docs code block. The code text
  is passed as a prop (it never touches the DOM) so the markdown renderer can
  stay a server component.
*/
export function CodeCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard may be unavailable (http, permissions); fall back to a
      // selection the user can copy manually.
      const range = document.createRange();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const pre = document.activeElement?.closest("div")?.querySelector("code");
      if (pre) {
        range.selectNodeContents(pre);
        selection?.addRange(range);
      }
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="copy code"
      className="absolute right-2 top-2 border border-grid-bounds bg-bg-surface px-2 py-0.5 font-mono text-[10px] lowercase text-signal-low transition-colors hover:border-signal-high/50 hover:text-signal-high focus:outline-none focus-visible:ring-1 focus-visible:ring-signal-high"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
