"use client";

// Next.js 16.2 error boundary — canonical recovery prop is unstable_retry.
// kern voice: "signal lost". rendered as an in-world fault: crimson badge,
// blinking status dots, a one-frame glitch on the headline, and the fault
// sound voice (silenced under reduced-motion / when ambience is off).
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { RadarMark } from "@/components/brand/RadarMark";
import { StatusDots } from "@/components/ui/StatusDots";
import { useSound } from "@/hooks/useSound";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const { play } = useSound();
  // fire the fault voice once per error occurrence, not on every `play`
  // identity change (e.g. when the user toggles ambience while on this page)
  const playRef = useRef(play);
  useEffect(() => {
    playRef.current = play;
  });
  useEffect(() => {
    console.error(error);
    playRef.current("fault");
  }, [error]);

  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <RadarMark size="lg" className="opacity-60" />
      <div className="mt-4 flex items-center gap-3">
        <Badge tone="fault">fault</Badge>
        <StatusDots status="blink" label="fault" count={4} />
      </div>
      <h1 className="glitch-fault mt-6 font-mono text-2xl lowercase text-fault-vector">
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
