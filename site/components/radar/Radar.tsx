"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useRafLoop } from "@/hooks/useRafLoop";
import { setupCanvasDPR } from "@/lib/canvas";
import { createCanvas2DBackend } from "@/components/radar/Canvas2DBackend";
import {
  createWebGPURadar,
  type WebGPURadarHandle,
} from "@/components/radar/WebGPUBackend";
import { RadarHUD } from "@/components/radar/RadarHUD";
import type {
  RadarBackend,
  RadarFrame,
  RadarProps,
  RadarQuality,
} from "@/components/radar/types";

/*
  Radar — the site's signature visual, with a renderer ladder:

    WebGPU (vgpu) → Canvas 2D → static (prefers-reduced-motion)

  Radar owns the policy: backend selection, quality tiers (device class,
  battery, presented-fps watchdog), pointer parallax input, out-of-view
  gain, and the `radarsweep` event bridge consumed by the headline glow,
  the nav signal strip, and the sound system.
*/

type BackendMode = "detecting" | "webgpu" | "canvas2d";
type Mode = BackendMode | "static";

const QUALITY_FLOOR_FPS = 45;

type BatteryLike = {
  level: number;
  charging: boolean;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
};

function deviceQuality(): RadarQuality {
  if (typeof window === "undefined") return "high";
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const memory = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  if (coarse || (memory !== undefined && memory <= 4)) return "low";
  return "high";
}

function hasWebGPU(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function Radar({ onSweep, className = "", quality: forced }: RadarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();

  const [inViewport, setInViewport] = useState(true);
  const [backendMode, setBackendMode] = useState<BackendMode>(() =>
    hasWebGPU() ? "detecting" : "canvas2d",
  );
  const [quality, setQuality] = useState<RadarQuality>(
    () => forced ?? deviceQuality(),
  );
  // bump to remount the canvas after a WebGPU context dies (a canvas can
  // only ever hold one context type)
  const [epoch, setEpoch] = useState(0);

  const mode: Mode = reduce ? "static" : backendMode;

  // shared refs — the draw callbacks stay stable across renders
  const geomRef = useRef<RadarFrame | null>(null);
  const angleRef = useRef(0);
  const webgpuRef = useRef<WebGPURadarHandle | null>(null);
  const qualityRef = useRef(quality);
  const onSweepRef = useRef(onSweep);

  useEffect(() => {
    qualityRef.current = quality;
  }, [quality]);

  useEffect(() => {
    onSweepRef.current = onSweep;
  });

  const backendRef = useRef<RadarBackend | null>(null);
  if (backendRef.current === null) {
    backendRef.current = createCanvas2DBackend();
  }

  const emitSweep = useCallback((angle: number) => {
    angleRef.current = angle;
    window.dispatchEvent(
      new CustomEvent("radarsweep", {
        detail: { sweepAngle: angle, timestamp: performance.now() },
      }),
    );
    onSweepRef.current?.(angle);
  }, []);

  // try WebGPU once per mount; any failure falls back to Canvas 2D
  useEffect(() => {
    if (reduce || backendMode !== "detecting") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let handle: WebGPURadarHandle | null = null;

    const fallback2d = () => {
      if (cancelled) return;
      setEpoch((e) => e + 1);
      setBackendMode("canvas2d");
    };

    createWebGPURadar(canvas, {
      quality: qualityRef.current,
      onSweep: emitSweep,
      onStats: ({ fps }) => {
        if (fps < QUALITY_FLOOR_FPS && qualityRef.current === "high") {
          setQuality("low");
        }
      },
      onLost: () => {
        if (cancelled) return;
        handle?.dispose();
        webgpuRef.current = null;
        fallback2d();
      },
    })
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        handle = created;
        webgpuRef.current = created;
        setBackendMode("webgpu");
      })
      .catch(fallback2d);

    return () => {
      cancelled = true;
      handle?.dispose();
      webgpuRef.current = null;
    };
  }, [reduce, backendMode, emitSweep]);

  // push quality changes to the live WebGPU handle
  useEffect(() => {
    webgpuRef.current?.setQuality(quality);
  }, [quality, mode]);

  // drop to low quality on a drained battery (Chromium-only API)
  useEffect(() => {
    if (forced) return;
    const getBattery = (
      navigator as unknown as {
        getBattery?: () => Promise<BatteryLike>;
      }
    ).getBattery;
    if (!getBattery) return;

    let mounted = true;
    let battery: BatteryLike | null = null;
    const check = () => {
      if (!mounted || !battery) return;
      if (battery.level < 0.3 && !battery.charging) setQuality("low");
    };

    getBattery
      .call(navigator)
      .then((b) => {
        if (!mounted) return;
        battery = b;
        b.addEventListener?.("levelchange", check);
        b.addEventListener?.("chargingchange", check);
        check();
      })
      .catch(() => {});

    return () => {
      mounted = false;
      battery?.removeEventListener?.("levelchange", check);
      battery?.removeEventListener?.("chargingchange", check);
    };
  }, [forced]);

  // pause while scrolled out of view
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInViewport(entry.isIntersecting),
      { rootMargin: "0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mode]);

  // WebGPU stays mounted; visibility is a gain fade, not a teardown
  useEffect(() => {
    webgpuRef.current?.setGain(inViewport ? 1 : 0);
  }, [inViewport, mode]);

  // pointer parallax (WebGPU backend only; 2D has no pointer uniform)
  useEffect(() => {
    if (mode !== "webgpu") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let x = 0.5;
    let y = 0.5;
    let tx = 0.5;
    let ty = 0.5;
    let raf = 0;

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      tx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      ty = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    };

    const tick = () => {
      x += (tx - x) * 0.06;
      y += (ty - y) * 0.06;
      webgpuRef.current?.setPointer(x, y);
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [mode]);

  // Canvas 2D geometry: (re)size on mount and on viewport resize
  useEffect(() => {
    if (mode !== "canvas2d" && mode !== "static") return;
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

      if (mode === "static") {
        ctx.clearRect(0, 0, width, height);
        backendRef.current?.renderStatic(ctx, frame);
      }
    };

    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, [mode, epoch]);

  // Canvas 2D loop (~30fps, shared hook)
  useRafLoop(
    (t) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const base = geomRef.current;
      if (!base || !base.width || !base.height || !backendRef.current) return;

      const { sweepAngle } = backendRef.current.render(ctx, {
        ...base,
        t,
      });
      emitSweep(sweepAngle);
    },
    { enabled: mode === "canvas2d" && !reduce && inViewport },
  );

  return (
    <div className={`relative h-full w-full ${className}`}>
      <canvas
        key={epoch}
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none h-full w-full"
      />
      {mode !== "static" && <RadarHUD angleRef={angleRef} />}
    </div>
  );
}
