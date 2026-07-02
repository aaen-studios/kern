import type { Metadata } from "next";
import { Suspense } from "react";
import { getPlugins } from "@/lib/registry";
import { PluginBrowser } from "@/components/plugins/PluginBrowser";
import { StatusDots } from "@/components/ui/StatusDots";

export const metadata: Metadata = {
  title: "plugins",
  description:
    "browse the kern plugin registry — game servers, bots, web, database, and dev tools. install in kern with one click.",
};

// §7.1 — listing. Server reads the full catalog; the client PluginBrowser
// manages filter/sort/search state and URL-syncs.
export default async function PluginsPage() {
  const all = await getPlugins();

  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-28 sm:px-6">
      <header className="mb-8">
        <p className="font-mono text-xs lowercase text-signal-low">{"// "}registry</p>
        <h1 className="mt-2 font-mono text-3xl lowercase text-zinc-100">plugins</h1>
        <p className="mt-3 max-w-xl font-mono text-xs text-signal-low">
          teach kern new server types. each plugin is a{" "}
          <code className="text-signal-high">.kern</code> file with a manifest,
          a config schema, lifecycle commands, and an isolated ui bundle.
        </p>
      </header>

      {/* submit affordance */}
      <div className="mb-8 flex items-center justify-between border-y border-grid-bounds/40 py-3">
        <div className="flex items-center gap-2">
          <StatusDots status="wave" label="registry live" count={3} />
          <span className="font-mono text-[11px] lowercase text-signal-low">
            community registry
          </span>
        </div>
        <a
          href="/plugins/submit"
          className="font-mono text-[11px] lowercase text-signal-high transition hover:brightness-125"
        >
          submit a plugin ↗
        </a>
      </div>

      <Suspense
        fallback={
          <div className="flex items-center gap-2 py-20">
            <StatusDots status="breathe" label="loading registry" count={4} />
            <span className="font-mono text-[11px] lowercase text-signal-low">
              loading…
            </span>
          </div>
        }
      >
        <PluginBrowser all={all} />
      </Suspense>
    </main>
  );
}
