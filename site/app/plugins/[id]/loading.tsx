import { StatusDots } from "@/components/ui/StatusDots";

/*
  Skeleton for the plugin detail page — appears instantly on client-side
  navigation while the ISR content streams in.
*/
export default function PluginDetailLoading() {
  return (
    <div className="mx-auto max-w-[1080px] px-4 py-12 sm:px-6">
      {/* breadcrumb skeleton */}
      <div className="mb-6 flex items-center gap-2">
        <StatusDots status="breathe" label="loading" count={3} />
        <div className="h-3 w-24 animate-pulse rounded bg-bg-surface" />
      </div>

      {/* header area */}
      <div className="flex items-start gap-4">
        <div className="h-16 w-16 animate-pulse rounded bg-bg-surface" />
        <div className="flex-1">
          <div className="h-7 w-64 animate-pulse rounded bg-bg-surface" />
          <div className="mt-2 h-4 w-48 animate-pulse rounded bg-bg-surface/60" />
          <div className="mt-3 flex gap-2">
            <div className="h-5 w-20 rounded-sm bg-bg-surface" />
            <div className="h-5 w-24 rounded-sm bg-bg-surface" />
          </div>
        </div>
        <div className="h-10 w-32 animate-pulse rounded bg-bg-surface" />
      </div>

      {/* content area */}
      <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <div className="h-4 w-full animate-pulse rounded bg-bg-surface/60" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-bg-surface/60" />
          <div className="h-4 w-4/6 animate-pulse rounded bg-bg-surface/60" />
          <div className="h-4 w-full animate-pulse rounded bg-bg-surface/60" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-bg-surface/60" />
        </div>
        <div className="space-y-4">
          <div className="h-32 animate-pulse rounded bg-bg-surface/60 p-4">
            <div className="h-3 w-20 rounded bg-bg-surface" />
            <div className="mt-3 h-3 w-full rounded bg-bg-surface/50" />
            <div className="mt-2 h-3 w-3/4 rounded bg-bg-surface/50" />
          </div>
          <div className="h-24 animate-pulse rounded bg-bg-surface/60 p-4">
            <div className="h-3 w-16 rounded bg-bg-surface" />
            <div className="mt-3 flex gap-2">
              <div className="h-5 w-16 rounded-sm bg-bg-surface" />
              <div className="h-5 w-12 rounded-sm bg-bg-surface" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
