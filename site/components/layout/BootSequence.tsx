"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/*
  One-time power-on overlay. Renders once per browser session (gated by
  sessionStorage) and self-unmounts after the choreography completes.

  ~600ms: core glow blooms, concentric rings illuminate outward, then the
  whole overlay fades to transparent and is removed.

  Skips entirely under prefers-reduced-motion (never makes a reduced-motion
  user wait) — it still marks the session booted so it never appears later.
*/

const STORAGE_KEY = "kern-booted";
const DURATION_MS = 700; // a touch over the animation to ensure the fade lands

export function BootSequence() {
  const reduce = useReducedMotion();
  const [show, setShow] = useState(false);

  useEffect(() => {
    // only run on the client; skip if already booted this session
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem(STORAGE_KEY)) return;

    // mark booted immediately so a fast nav doesn't re-trigger
    sessionStorage.setItem(STORAGE_KEY, "1");

    // reduced-motion users never see it
    if (reduce) return;

    // defer to next frame to avoid a synchronous setState in the effect body
    const raf = requestAnimationFrame(() => {
      setShow(true);
    });
    const timer = window.setTimeout(() => setShow(false), DURATION_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [reduce]);

  if (!show) return null;

  return (
    <div
      aria-hidden="true"
      className="boot-sequence pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-bg-core"
    >
      {/* concentric rings illuminate outward, core blooms */}
      <div className="boot-ring boot-ring-1" />
      <div className="boot-ring boot-ring-2" />
      <div className="boot-ring boot-ring-3" />
      <div className="boot-core" />
    </div>
  );
}
