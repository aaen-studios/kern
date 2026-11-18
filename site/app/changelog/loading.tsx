import { StatusDots } from "@/components/ui/StatusDots";

/*
  Skeleton for the changelog page — shows while GitHub release data streams in.
*/
export default function ChangelogLoading() {
  return (
    <div className="mx-auto max-w-[960px] px-4 py-12 sm:px-6">
      {/* header */}
      <div className="mb-6 flex items-center gap-3">
        <StatusDots status="breathe" label="loading" count={4} />
        <span className="font-mono text-[11px] lowercase text-signal-low">
          loading changelog…
        </span>
      </div>
      <div className="h-8 w-56 animate-pulse rounded bg-bg-surface" />
      <div className="mt-2 h-4 w-72 animate-pulse rounded bg-bg-surface/60" />

      {/* release items */}
      <div className="mt-10 space-y-8">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="animate-pulse rounded bg-bg-surface/40 p-6"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <div className="flex items-center gap-3">
              <div className="h-5 w-28 rounded bg-bg-surface" />
              <div className="h-3 w-20 rounded bg-bg-surface/50" />
            </div>
            <div className="mt-4 space-y-2">
              <div className="h-3 w-full rounded bg-bg-surface/50" />
              <div className="h-3 w-5/6 rounded bg-bg-surface/50" />
              <div className="h-3 w-4/6 rounded bg-bg-surface/50" />
            </div>
            <div className="mt-4 h-8 w-32 rounded bg-bg-surface" />
          </div>
        ))}
      </div>
    </div>
  );
}
