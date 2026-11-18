"use client";

import { useEffect, useRef } from "react";

/**
 * Shared requestAnimationFrame loop.
 *
 * Extracts the 30fps-gate + delta-time pattern that was duplicated verbatim
 * in RadarShader (hero) and RegistryRadar (plugin browser). One source of
 * truth for: rAF schedule/cancel, frame throttling with sub-frame remainder
 * carry, and tab-visibility pause/resume.
 *
 * The callback is stored in a ref so it can change every render without
 * restarting the loop — the consumer's draw function can close over refs
 * (canvas geometry, blips, etc.) and the loop simply never tears down.
 *
 * @param callback receives accumulated time `t` (seconds) and per-frame delta
 *                 `dt` (seconds). `t` starts at 0 on mount and accumulates.
 * @param options.fps     target framerate cap (default 30)
 * @param options.enabled when false the loop does not start — use this to gate
 *                        on prefers-reduced-motion
 */
export function useRafLoop(
  callback: (t: number, dt: number) => void,
  options?: { fps?: number; enabled?: boolean },
): void {
  // always-latest refs — the loop reads from these, never restarts for them.
  // mirrored in an effect (not during render) per the React refs rule.
  const cbRef = useRef(callback);
  const fpsRef = useRef(options?.fps ?? 30);

  useEffect(() => {
    cbRef.current = callback;
    fpsRef.current = options?.fps ?? 30;
  });

  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    let rafId: number | null = null;
    let t = 0;
    let last = performance.now();

    const loop = (now: number) => {
      rafId = requestAnimationFrame(loop); // re-arm first so it always reschedules
      const interval = 1000 / fpsRef.current;
      const elapsed = now - last;
      if (elapsed < interval) return; // throttle
      last = now - (elapsed % interval); // carry sub-frame remainder
      const dt = elapsed * 0.001;
      t += dt;
      cbRef.current(t, dt);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      } else if (rafId === null) {
        last = performance.now(); // reset so first frame back isn't a huge delta
        rafId = requestAnimationFrame(loop);
      }
    };

    rafId = requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
}
