"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { useRafLoop } from "@/hooks/useRafLoop";
import { setupCanvasDPR } from "@/lib/canvas";

/*
  Signal Radar — the brand-defining visual, ported from the kern desktop app
  (`polarRadar` / `sineRipple` shader functions in src/components/matrix/).

  Renders to <canvas>: a bright signal-green core, concentric rings of green
  dots, a slow rotating sweep line, and traveling dot-waves. Dim, low-opacity;
  never competes with text. aria-hidden (decorative).

  Performance & a11y:
    - capped at ~30fps via the shared useRafLoop hook
    - pauses the rAF loop when the tab is hidden (handled by useRafLoop)
    - respects prefers-reduced-motion → renders a static dot-grid instead
    - devicePixelRatio-aware (capped at 2 to bound work)
*/

type Ring = { radius: number; count: number; phase: number; opacity: number };

const SIGNAL = "#4cf5a0";
const DIM = "#1f3a2c";

function buildRings(maxR: number): Ring[] {
  // a handful of concentric rings out to ~maxR
  const radii = [0.18, 0.3, 0.42, 0.55, 0.68, 0.82];
  return radii
    .map((f, i) => ({
      radius: f * maxR,
      count: 6 + i * 4,
      phase: i * 0.7,
      opacity: 0.5 - i * 0.06,
    }))
    .filter((r) => r.radius < maxR);
}

export function RadarShader({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();

  // geometry + ctx live in refs so the draw callback (stable across frames)
  // can read them without restarting the rAF loop.
  const geomRef = useRef({
    width: 0,
    height: 0,
    cx: 0,
    cy: 0,
    maxR: 0,
    rings: [] as Ring[],
  });

  // (re)size once on mount and on viewport resize; recompute rings each time.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const setup = () => {
      const { width, height } = setupCanvasDPR(canvas, ctx);
      const cx = width / 2;
      const cy = height / 2;
      const maxR = Math.min(width, height) * 0.5;
      geomRef.current = { width, height, cx, cy, maxR, rings: buildRings(maxR) };

      if (reduce) {
        // static dot-grid fallback — no rAF loop
        ctx.clearRect(0, 0, width, height);
        drawStatic(ctx, cx, cy, maxR);
      }
    };

    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, [reduce]);

  // traveling wave value for a given ring + time
  const wave = (ringIdx: number, dotIdx: number, t: number, count: number) => {
    const k = dotIdx / count;
    return 0.5 + 0.5 * Math.sin((k * Math.PI * 2 + t * 0.6 + ringIdx) * 1);
  };

  useRafLoop(
    (t) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height, cx, cy, maxR, rings } = geomRef.current;
      if (!width || !height) return;

      ctx.clearRect(0, 0, width, height);

      // soft radial bloom behind core
      const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.7);
      bloom.addColorStop(0, "rgba(76,245,160,0.10)");
      bloom.addColorStop(0.5, "rgba(76,245,160,0.03)");
      bloom.addColorStop(1, "rgba(76,245,160,0)");
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, width, height);

      // concentric rings of dots with traveling-wave brightness
      rings.forEach((ring, ri) => {
        for (let i = 0; i < ring.count; i++) {
          const a = (i / ring.count) * Math.PI * 2 - Math.PI / 2;
          const x = cx + Math.cos(a) * ring.radius;
          const y = cy + Math.sin(a) * ring.radius;
          const w = wave(ri, i, t, ring.count);
          ctx.globalAlpha = ring.opacity * (0.3 + 0.7 * w);
          ctx.fillStyle = ri % 2 === 0 ? SIGNAL : DIM;
          ctx.beginPath();
          ctx.arc(x, y, ri === 0 ? 1.8 : 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;

      // slow rotating sweep line (radar)
      const sweepAngle = t * 0.5;
      const grad = ctx.createLinearGradient(
        cx,
        cy,
        cx + Math.cos(sweepAngle) * maxR,
        cy + Math.sin(sweepAngle) * maxR,
      );
      grad.addColorStop(0, "rgba(76,245,160,0.35)");
      grad.addColorStop(1, "rgba(76,245,160,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(sweepAngle) * maxR,
        cy + Math.sin(sweepAngle) * maxR,
      );
      ctx.stroke();

      // dispatch sweep angle for text illumination effects
      window.dispatchEvent(
        new CustomEvent("radarsweep", {
          detail: { sweepAngle, timestamp: performance.now() },
        }),
      );

      // bright core
      ctx.fillStyle = SIGNAL;
      ctx.globalAlpha = 0.85 + 0.15 * Math.sin(t * 2);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2.5, maxR * 0.05), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // faint core ring
      ctx.strokeStyle = "rgba(76,245,160,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(5, maxR * 0.1), 0, Math.PI * 2);
      ctx.stroke();
    },
    { enabled: !reduce },
  );

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none h-full w-full ${className}`}
    />
  );
}

// faint dot grid + a static core (reduced-motion fallback)
function drawStatic(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  maxR: number,
  width = ctx.canvas.width,
  height = ctx.canvas.height,
) {
  ctx.fillStyle = "rgba(22,25,32,0.5)";
  const step = 14;
  for (let x = step / 2; x < width; x += step) {
    for (let y = step / 2; y < height; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = SIGNAL;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, maxR * 0.08), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
