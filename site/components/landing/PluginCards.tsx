import Link from "next/link";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { Badge, VerifiedBadge } from "@/components/ui/Badge";

/*
  §10.8 — Plugins. The two flagship first-party plugins as cards:
    Minecraft Java — 7 server softwares (vanilla · paper · purpur · fabric · forge · neoforge · quilt)
    Discord Bot   — 4 runtimes (node · bun · deno · rust)
  Plus a "browse all plugins →" link to /plugins.
*/

const MC_RUNTIMES = [
  "vanilla",
  "paper",
  "purpur",
  "fabric",
  "forge",
  "neoforge",
  "quilt",
];
const BOT_RUNTIMES = ["node", "bun", "deno", "rust"];

export function PluginCards() {
  return (
    <section id="plugins-preview" className="border-y border-grid-bounds/40 bg-bg-surface/30">
      <div className="mx-auto max-w-[1080px] px-4 py-24 sm:px-6">
        <Reveal>
          <SectionHeading kicker="plugins" title="teach it new server types.">
            the app is intentionally generic. plugins teach it how to run each
            type of server — a <code className="text-signal-high">.kern</code>{" "}
            file with a manifest, a config schema, lifecycle commands, and an
            isolated ui bundle.
          </SectionHeading>
        </Reveal>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Minecraft Java */}
          <Reveal delay={0.05}>
            <Link
              href="/plugins/minecraft_java"
              className="group flex h-full flex-col gap-4 bg-bg-core p-6 transition-colors hover:bg-bg-surface"
              style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-mono text-lg lowercase text-zinc-100">
                      minecraft java
                    </h3>
                    <VerifiedBadge />
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-signal-low">
                    kern/sample · v1.2.0
                  </p>
                </div>
                <Badge tone="signal">game-server</Badge>
              </div>
              <p className="font-mono text-xs text-signal-low">
                run and manage minecraft java edition servers. auto-downloads
                the jar, accepts eula, edits server.properties, backs up worlds.
              </p>
              <div className="mt-auto">
                <p className="mb-2 font-mono text-[11px] lowercase text-signal-low">
                  7 server softwares
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {MC_RUNTIMES.map((r) => (
                    <span
                      key={r}
                      className="rounded-sm bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-signal-high ring-1 ring-grid-bounds"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          </Reveal>

          {/* Discord Bot */}
          <Reveal delay={0.1}>
            <Link
              href="/plugins/discord_bot"
              className="group flex h-full flex-col gap-4 bg-bg-core p-6 transition-colors hover:bg-bg-surface"
              style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-mono text-lg lowercase text-zinc-100">
                      discord bot
                    </h3>
                    <VerifiedBadge />
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-signal-low">
                    kern/sample · v1.2.0
                  </p>
                </div>
                <Badge tone="signal">bot</Badge>
              </div>
              <p className="font-mono text-xs text-signal-low">
                scaffold and run discord bots across runtimes. runtime-conditional
                scaffolding generates the right starter files.
              </p>
              <div className="mt-auto">
                <p className="mb-2 font-mono text-[11px] lowercase text-signal-low">
                  4 runtimes
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {BOT_RUNTIMES.map((r) => (
                    <span
                      key={r}
                      className="rounded-sm bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-signal-high ring-1 ring-grid-bounds"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          </Reveal>
        </div>

        <div className="mt-8">
          <Link
            href="/plugins"
            className="font-mono text-xs lowercase text-signal-high transition hover:brightness-125"
          >
            browse all plugins →
          </Link>
        </div>
      </div>
    </section>
  );
}
