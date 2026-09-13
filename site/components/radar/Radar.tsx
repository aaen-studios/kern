"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useRafLoop } from "@/hooks/useRafLoop";
import { setupCanvasDPR } from "@/lib/canvas";
import { createCanvas2DBackend } from "@/components/radar/Canvas2DBackend";
import type { RadarBackend, RadarFrame, RadarProps } from "@/components/radar/types";

/*
  Radar — the site's signature visual. Owns the canvas lifecycle:
    - DPR-aware sizing (capped at 2) and resize handling
    - ~30fps rAF loop (shared hook), paused when the tab is hidden
    - paused while scrolled out of view
    - prefers-reduced-motion → static engraved frame, no loop
    - dispatches the `radarsweep` window event and calls onSweep()

  The drawing itself lives behind the RadarBackend contract; Canvas 2D is
  today's backend, vgpu/WebGPU joins it in the next phase.
*/

export function Radar({ onSweep, className = "" }: RadarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();
  const [inViewport, setInViewport] = useState(true);

  // geometry lives in a ref so the draw callback stays stable across frames
  const geomRef = useRef<RadarFrame | null>(null);

  // lazy backend init (single instance per mount)
  const backendRef = useRef<RadarBackend | null>(null);
  if (backendRef.current === null) {
    backendRef.current = createCanvas2DBackend();
  }

  // always-latest callback ref
  const onSweepRef = useRef(onSweep);
  useEffect(() => {
    onSweepRef.current = onSweep;
  });

  // pause the shader when it scrolls out of view
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInViewport(entry.isIntersecting),
      { rootMargin: "0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // (re)size on mount and on viewport resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const setup = () => {
      const { width, height } = setupCanvasDPR(canvas, ctx);
      const frame: RadarFrame = {
        width,
        height,
        cx: width / 2,
        cy: height / 2,
        maxR: Math.min(width, height) * 0.5,
        t: 0,
      };
      geomRef.current = frame;

      if (reduce) {
        ctx.clearRect(0, 0, width, height);
        backendRef.current?.renderStatic(ctx, frame);
      }
    };

    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, [reduce]);

  useRafLoop(
    (t) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const base = geomRef.current;
      if (!base || !base.width || !base.height || !backendRef.current) return;

      const { sweepAngle } = backendRef.current.render(ctx, { ...base, t });

      // bridge for text illumination (useSweepProximity) and the signal strip
      window.dispatchEvent(
        new CustomEvent("radarsweep", {
          detail: { sweepAngle, timestamp: performance.now() },
        }),
      );
      onSweepRef.current?.(sweepAngle);
    },
    { enabled: !reduce && inViewport },
  );

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none h-full w-full ${className}`}
    />
  );
}
