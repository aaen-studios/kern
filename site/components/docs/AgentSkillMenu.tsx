"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CodeCopy } from "@/components/docs/CodeCopy";

/*
  Docs header control: install the kern agent skill without leaving the
  reference. Collapsed to a single button (top right of the prose column),
  expands to the paste-into-agent prompt plus manual commands.
*/

const AGENT_PROMPT =
  "install the kern agent skill by running: npx skills add ellipog/kern-web — then use that skill to help me build a .kern plugin.";

const COMMANDS = [
  { label: "skills cli", command: "npx skills add ellipog/kern-web" },
  { label: "npm", command: "npm i -D @aaen-studios/kern" },
  {
    label: "no install",
    command: "curl -fsSL https://kern.aaenz.no/llms.txt",
  },
];

export function AgentSkillMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="border border-grid-bounds bg-bg-surface px-2.5 py-1 font-mono text-[10px] lowercase text-signal-low transition-colors hover:border-signal-high/50 hover:text-signal-high"
      >
        {open ? "-" : "+"} use with your agent
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="install the kern agent skill"
          className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2.5rem)] bg-bg-core p-4"
          style={{
            boxShadow:
              "inset 0 0 0 1px rgba(22,25,32,0.9), 0 12px 32px rgba(0,0,0,0.5)",
          }}
        >
          <p className="font-mono text-[10px] lowercase text-signal-low">
            {"// paste this into your agent"}
          </p>
          <div className="relative mt-2 bg-bg-surface pr-12">
            <code className="block px-2.5 py-2 font-mono text-[10px] leading-relaxed text-zinc-200">
              {AGENT_PROMPT}
            </code>
            <CodeCopy text={AGENT_PROMPT} />
          </div>

          <p className="mt-3 font-mono text-[10px] lowercase text-signal-low">
            {"// or wire it up yourself"}
          </p>
          <ul className="mt-2 space-y-2">
            {COMMANDS.map((row) => (
              <li key={row.label}>
                <span className="font-mono text-[9px] lowercase text-signal-high">
                  {row.label}
                </span>
                <div className="relative mt-1 bg-bg-surface pr-12">
                  <code className="block px-2.5 py-1.5 font-mono text-[10px] text-zinc-200">
                    {row.command}
                  </code>
                  <CodeCopy text={row.command} />
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-3 font-mono text-[10px] lowercase text-signal-low">
            more on the{" "}
            <Link
              href="/#agents"
              className="text-signal-high transition-colors hover:underline"
            >
              landing page
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
