import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { RadarMark } from "@/components/brand/RadarMark";

// kern voice: "no instance found". not-found takes no props.
export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <RadarMark size="lg" className="opacity-60" />
      <div className="mt-4">
        <Badge tone="signal">open source</Badge>
      </div>
      <h1 className="mt-6 font-mono text-2xl lowercase text-zinc-100">
        no instance found
      </h1>
      <p className="mt-2 max-w-md font-mono text-xs text-signal-low">
        the path you requested is not registered. it may have been moved,
        deleted, or orphaned.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center bg-signal-high px-4 py-2 font-mono text-xs lowercase text-bg-core transition hover:brightness-110"
      >
        back to registry
      </Link>
    </main>
  );
}
