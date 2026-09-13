"use client";

import Link from "next/link";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { CodeCopy } from "@/components/docs/CodeCopy";

/*
  §10.x — ai agents. The docs ship as an agent skill (@aaen-studios/kern),
  so coding agents can build plugins and script kern-cli without scraping
  the site. Two paths: paste one prompt into any agent, or wire it manually.
*/

const AGENT_PROMPT =
  "install the kern agent skill by running: npx skills add ellipog/kern-web — then use that skill to help me build a .kern plugin.";

const MANUAL = [
  {
    label: "skills cli",
    note: "claude code, opencode, cursor +70 more",
    command: "npx skills add ellipog/kern-web",
  },
  {
    label: "npm",
    note: "skill at node_modules/@aaen-studios/kern/kern",
    command: "npm i -D @aaen-studios/kern",
  },
  {
    label: "no install",
    note: "feed the docs index straight to your agent",
    command: "curl -fsSL https://kern.aaenz.no/llms.txt",
  },
];

export function AgentSkillSection() {
  return (
    <section id="agents" className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
      <Reveal>
        <SectionHeading kicker="ai agents" title="teach your agent kern.">
          the docs ship as an agent skill — manifests, lifecycle, kern-cli, the
          automation api — so your coding agent can write plugins instead of
          guessing. paste the prompt, or install it yourself.
        </SectionHeading>
      </Reveal>

      <div className="grid gap-4 sm:grid-cols-2">
        <Reveal delay={0.1}>
          <div
            className="h-full bg-bg-core p-6"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <p className="font-mono text-xs lowercase text-signal-low">
              {"// paste this into your agent"}
            </p>
            <div className="relative mt-4 bg-bg-surface pr-14">
              <code className="block px-3 py-3 font-mono text-[11px] leading-relaxed text-zinc-200">
                {AGENT_PROMPT}
              </code>
              <CodeCopy text={AGENT_PROMPT} />
            </div>
            <p className="mt-3 font-mono text-[11px] lowercase text-signal-low">
              any agent with shell access will do the rest.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.2}>
          <div
            className="h-full bg-bg-core p-6"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <p className="font-mono text-xs lowercase text-signal-low">
              {"// or wire it up yourself"}
            </p>
            <ul className="mt-4 space-y-3">
              {MANUAL.map((row) => (
                <li key={row.label}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[10px] lowercase text-signal-high">
                      {row.label}
                    </span>
                    <span className="truncate font-mono text-[10px] lowercase text-signal-low/70">
                      {row.note}
                    </span>
                  </div>
                  <div className="relative mt-1 bg-bg-surface pr-14">
                    <code className="block px-3 py-2 font-mono text-[11px] text-zinc-200">
                      {row.command}
                    </code>
                    <CodeCopy text={row.command} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-4 font-mono text-[11px] lowercase text-signal-low">
              package:{" "}
              <Link
                href="https://www.npmjs.com/package/@aaen-studios/kern"
                className="text-signal-high transition-colors hover:underline"
              >
                @aaen-studios/kern
              </Link>{" "}
              · source:{" "}
              <Link
                href="https://github.com/ellipog/kern-web/tree/main/skills/kern"
                className="text-signal-high transition-colors hover:underline"
              >
                skills/kern
              </Link>
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
