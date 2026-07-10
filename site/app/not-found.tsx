import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { RadarMark } from "@/components/brand/RadarMark";
import { StatusDots } from "@/components/ui/StatusDots";
import { FaultSound } from "@/components/layout/FaultSound";

// kern voice: "no instance found". rendered as an in-world fault: crimson
// badge, blinking status dots, a one-frame glitch on the headline. The fault
// sound fires from a tiny client island (FaultSound) so this page stays SSR.
export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <FaultSound />
      <RadarMark size="lg" className="opacity-60" />
      <div className="mt-4 flex items-center gap-3">
        <Badge tone="fault">fault</Badge>
        <StatusDots status="blink" label="fault" count={4} />
      </div>
      <h1 className="glitch-fault mt-6 font-mono text-2xl lowercase text-fault-vector">
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
