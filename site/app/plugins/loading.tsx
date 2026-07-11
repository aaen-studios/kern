import { StatusDots } from "@/components/ui/StatusDots";

/*
  Instant-feedback skeleton for the plugin browser route.
  Renders while the page content streams in.
*/
export default function PluginsLoading() {
  return (
    <div className="mx-auto max-w-[1080px] px-4 py-12 sm:px-6">
      {/* header skeleton */}
      <div className="mb-8 flex items-center gap-3">
        <StatusDots status="breathe" label="loading" count={4} />
        <span className="font-mono text-[11px] lowercase text-signal-low">
          scanning registry…
        </span>
      </div>
      <div className="h-8 w-48 animate-pulse rounded bg-bg-surface" />
      <div className="mt-2 h-4 w-80 animate-pulse rounded bg-bg-surface/60" />

      {/* filter bar skeleton */}
      <div className="mt-8 flex gap-3">
        <div className="h-9 w-64 animate-pulse rounded bg-bg-surface" />
        <div className="h-9 w-28 animate-pulse rounded bg-bg-surface" />
      </div>

      {/* grid skeleton */}
      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="animate-pulse rounded bg-bg-surface/60 p-5"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="h-4 w-3/4 rounded bg-bg-surface" />
            <div className="mt-3 h-3 w-full rounded bg-bg-surface/50" />
            <div className="mt-2 h-3 w-2/3 rounded bg-bg-surface/50" />
            <div className="mt-4 flex gap-2">
              <div className="h-5 w-16 rounded-sm bg-bg-surface" />
              <div className="h-5 w-12 rounded-sm bg-bg-surface" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
