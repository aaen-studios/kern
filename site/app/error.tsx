"use client";

// Next.js 16.2 error boundary — canonical recovery prop is unstable_retry.
// kern voice: "signal lost".
import { useEffect } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { RadarMark } from "@/components/brand/RadarMark";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <RadarMark size="lg" className="opacity-60" />
      <div className="mt-4">
        <Badge tone="signal">open source</Badge>
      </div>
      <h1 className="mt-6 font-mono text-2xl lowercase text-zinc-100">
        signal lost
      </h1>
      <p className="mt-2 max-w-md font-mono text-xs text-signal-low">
        the instance threw an error. try re-establishing the connection.
      </p>
      <div className="mt-6">
        <Button onClick={() => unstable_retry()} variant="primary">
          retry
        </Button>
      </div>
    </main>
  );
}
