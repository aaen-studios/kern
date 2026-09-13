import Link from "next/link";
import seed from "@/content/plugins/seed.json";
import { SectionHeading, Reveal } from "@/components/ui/Reveal";
import { Badge, VerifiedBadge } from "@/components/ui/Badge";
import { Spotlight } from "@/components/ui/Spotlight";

/*
  §10.8 — Plugins. The first-party plugins as cards, sourced from the registry
  seed so author/version/description can never drift from what the site
  actually serves. Runtime chips come from each plugin's config schema.
*/

interface SeedVersion {
  version: string;
}

interface SeedSchemaField {
  key: string;
  options?: string[];
}

interface SeedPlugin {
  id: string;
  display_name: string;
  description: string;
  author: string;
  category?: string;
  tags?: string[];
  config_schema?: SeedSchemaField[];
  versions: SeedVersion[];
}

const OFFICIAL: Array<{ id: string; blurb: string }> = [
  {
    id: "minecraft_java",
    blurb:
      "run and manage minecraft java edition servers. auto-downloads the jar, accepts eula, edits server.properties, backs up worlds.",
  },
  {
    id: "discord_bot",
    blurb:
      "scaffold and run discord bots across runtimes. the token lives in your os credential vault, and the console streams live while the bot runs.",
  },
];

function pluginById(id: string): SeedPlugin | undefined {
  return (seed.plugins as SeedPlugin[]).find((p) => p.id === id);
}

/** Runtime chips from the plugin's `runtime` config field, if it has one. */
function runtimesOf(plugin: SeedPlugin): string[] {
  const field = plugin.config_schema?.find((f) => f.key === "runtime");
  return field?.options ?? [];
}

export function PluginCards() {
  const cards = OFFICIAL.map(({ id, blurb }) => ({ plugin: pluginById(id), blurb }))
    .filter((card): card is { plugin: SeedPlugin; blurb: string } => !!card.plugin);

  return (
    <section id="plugins-preview" className="bg-bg-surface/30">
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
          {cards.map(({ plugin, blurb }, index) => {
            const latest = plugin.versions[0]?.version ?? "0.0.0";
            const runtimes = runtimesOf(plugin);
            return (
              <Reveal key={plugin.id} delay={0.05 + index * 0.05}>
                <Spotlight className="h-full">
                  <Link
                    href={`/plugins/${plugin.id}`}
                    className="group flex h-full flex-col gap-4 bg-bg-core p-6 transition-colors hover:bg-bg-surface"
                    style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-mono text-lg lowercase text-zinc-100">
                            {plugin.display_name.toLowerCase()}
                          </h3>
                          <VerifiedBadge />
                        </div>
                        <p className="mt-1 font-mono text-[11px] text-signal-low">
                          {plugin.author} · v{latest}
                        </p>
                      </div>
                      {plugin.category && <Badge tone="signal">{plugin.category}</Badge>}
                    </div>
                    <p className="font-mono text-xs text-signal-low">{blurb}</p>
                    <p className="font-mono text-[11px] leading-relaxed text-signal-low/80">
                      {plugin.description}
                    </p>
                    {runtimes.length > 0 && (
                      <div className="mt-auto">
                        <p className="mb-2 font-mono text-[11px] lowercase text-signal-low">
                          {runtimes.length} {plugin.id === "minecraft_java" ? "server softwares" : "runtimes"}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {runtimes.map((runtime) => (
                            <span
                              key={runtime}
                              className="rounded-sm bg-bg-surface px-2 py-0.5 font-mono text-[11px] text-signal-high ring-1 ring-grid-bounds"
                            >
                              {runtime}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </Link>
                </Spotlight>
              </Reveal>
            );
          })}
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
