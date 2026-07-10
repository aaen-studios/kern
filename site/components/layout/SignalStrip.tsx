"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { useRafLoop } from "@/hooks/useRafLoop";
import { setupCanvasDPR } from "@/lib/canvas";

/*
  Live signal strip — a thin oscilloscope-style canvas bar pinned under the
  navbar (top: 56px). Renders rhythmic pulses in the three semantic colors:
  mostly signal-green traveling micro-waves, occasional amber "transitional"
  blips, rare crimson "fault" flickers. Same vocabulary as StatusDots.

  Brightens briefly when the hero radar sweep passes overhead, tying the whole
  site to one "heartbeat".

  aria-hidden + pointer-events-none — purely decorative.
  Under prefers-reduced-motion: a single static faint green line.
*/

const GREEN = [76, 245, 160] as const;
const AMBER = [245, 160, 76] as const;
const CRIMSON = [245, 76, 76] as const;

function rgba(c: readonly [number, number, number], a: number) {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function SignalStrip() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();
  // latest radar-sweep pulse strength, decaying each frame
  const sweepPulseRef = useRef(0);

  useRafLoop(
    (t) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height } = setupCanvasDPR(canvas, ctx);
      if (!width) return;

      // decay the sweep-synced pulse
      sweepPulseRef.current *= 0.92;

      ctx.clearRect(0, 0, width, height);

      // baseline: a dim green travelling micro-wave — the resting "carrier"
      for (let x = 0; x < width; x += 2) {
        const w =
          0.5 +
          0.5 * Math.sin(x * 0.05 - t * 2.2) * Math.sin(x * 0.013 - t * 0.7);
        const base = 0.06 + 0.05 * w;
        const boost = sweepPulseRef.current * 0.25;
        ctx.fillStyle = rgba(GREEN, base + boost);
        ctx.fillRect(x, 0, 2, height);
      }

      // periodic amber "transitional" blips (~every 4s, short)
      const amberCycle = (t % 4) / 4;
      if (amberCycle < 0.06) {
        const bx = ((t * 80) % (width + 200)) - 100;
        const a = 0.5 * (1 - amberCycle / 0.06);
        const g = ctx.createRadialGradient(bx, height / 2, 0, bx, height / 2, 90);
        g.addColorStop(0, rgba(AMBER, a));
        g.addColorStop(1, rgba(AMBER, 0));
        ctx.fillStyle = g;
        ctx.fillRect(Math.max(0, bx - 90), 0, 180, height);
      }

      // rare crimson "fault" flicker (~every 11s, one-frame-ish)
      const faultCycle = t % 11;
      if (faultCycle < 0.12) {
        const a = 0.6 * (1 - faultCycle / 0.12);
        ctx.fillStyle = rgba(CRIMSON, a);
        ctx.fillRect(0, 0, width, height);
      }
    },
    { enabled: !reduce },
  );

  // listen for the hero radar sweep to brighten the strip in sync
  useEffect(() => {
    if (reduce) return;
    const onSweep = () => {
      sweepPulseRef.current = 1;
    };
    window.addEventListener("radarsweep", onSweep);
    return () => window.removeEventListener("radarsweep", onSweep);
  }, [reduce]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={
        // 3px tall, pinned just under the 56px (h-14) nav, below nav's z-50
        reduce
          ? "pointer-events-none fixed inset-x-0 top-14 z-40 h-[3px] bg-signal-high/20"
          : "pointer-events-none fixed inset-x-0 top-14 z-40 h-[3px]"
      }
    />
  );
}
