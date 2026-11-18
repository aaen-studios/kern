"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

const DEFAULT_THRESHOLD = 0.15; // radians — matches Hero's original constant

/**
 * Returns true when the rotating radar sweep line is angularly near the
 * referenced element. Generalised from Hero.tsx's local useSweepIllumination:
 *
 *  - accepts an explicit `radarCenter` instead of assuming viewport center
 *    (the hero radar fills the viewport so the default is correct there,
 *    but other radars may be offset)
 *  - uses the reactive `useReducedMotion()` from motion/react rather than a
 *    one-shot matchMedia read, so toggling the OS setting mid-session works
 *
 * Consumes the "radarsweep" window event dispatched by RadarShader.
 * Silenced entirely under prefers-reduced-motion.
 *
 * @param elementRef  the element whose angular position to track
 * @param options.radarCenter  screen-space radar centre; defaults to viewport centre
 * @param options.threshold    angular proximity (radians) that triggers illumination
 */
export function useSweepProximity(
  elementRef: React.RefObject<HTMLElement | null>,
  options?: {
    radarCenter?: () => { x: number; y: number };
    threshold?: number;
  },
): boolean {
  const [illuminated, setIlluminated] = useState(false);
  const reduce = useReducedMotion();
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const radarCenter = options?.radarCenter;

  useEffect(() => {
    if (reduce) return;

    const handleSweep = (e: Event) => {
      const customEvent = e as CustomEvent<{ sweepAngle: number }>;
      if (!customEvent.detail) return;

      const el = elementRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const center = radarCenter
        ? radarCenter()
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

      // element centre in screen space
      const elCenterX = rect.left + rect.width / 2;
      const elCenterY = rect.top + rect.height / 2;

      // angular position of the element relative to the radar centre
      const elementAngle = Math.atan2(
        elCenterY - center.y,
        elCenterX - center.x,
      );

      // normalise the delta to [-π, π]
      let delta = elementAngle - customEvent.detail.sweepAngle;
      while (delta < -Math.PI) delta += Math.PI * 2;
      while (delta > Math.PI) delta -= Math.PI * 2;

      setIlluminated(Math.abs(delta) < threshold);
    };

    window.addEventListener("radarsweep", handleSweep);
    return () => window.removeEventListener("radarsweep", handleSweep);
  }, [elementRef, reduce, threshold, radarCenter]);

  return illuminated;
}
