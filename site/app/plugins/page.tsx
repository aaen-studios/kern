import type { Metadata } from "next";
import { Suspense } from "react";
import { getPlugins } from "@/lib/registry";
import { PluginBrowser } from "@/components/plugins/PluginBrowser";
import { RegistryRadar } from "@/components/plugins/RegistryRadar";
import { StatusDots } from "@/components/ui/StatusDots";

export const metadata: Metadata = {
  title: "plugins",
  description:
    "browse the kern plugin registry — game servers, bots, web, database, and dev tools. install in kern with one click.",
};

// §7.1 — listing. Server reads the full catalog; the client PluginBrowser
// manages filter/sort/search state and URL-syncs. A radar/grid toggle is
// driven by the ?view=radar|grid search param for shareable views.
export default async function PluginsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const all = await getPlugins();
  const { view } = await searchParams;
  const isRadar = view === "radar";

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

      {/* toolbar */}
      <div className="mb-8 flex items-center justify-between border-y border-grid-bounds/40 py-3">
        <div className="flex items-center gap-2">
          <StatusDots status="wave" label="registry live" count={3} />
          <span className="font-mono text-[11px] lowercase text-signal-low">
            community registry
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Radar / Grid toggle */}
          <a
            href={isRadar ? "/plugins" : "/plugins?view=radar"}
            className="font-mono text-[11px] lowercase text-signal-low transition hover:text-signal-high"
          >
            {isRadar ? "◉ grid view" : "⊞ radar view"}
          </a>
          <a
            href="/plugins/submit"
            className="font-mono text-[11px] lowercase text-signal-high transition hover:brightness-125"
          >
            submit a plugin ↗
          </a>
        </div>
      </div>

      {isRadar ? (
        <Suspense
          fallback={
            <div className="flex items-center gap-2 py-20">
              <StatusDots status="breathe" label="scanning registry" count={4} />
              <span className="font-mono text-[11px] lowercase text-signal-low">
                scanning…
              </span>
            </div>
          }
        >
          <RegistryRadar plugins={all} />
        </Suspense>
      ) : (
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
      )}
    </main>
  );
}
