"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

/*
  Scan-line section divider. A drop-in alternative to MatrixDivider: same
  h-px w-full footprint, but a signal-green horizontal line sweeps left→right
  across the divider when scrolled into view, then fades to the usual dim
  dotted matrix. Used between landing sections to reveal them.

  Uses CSS animations triggered by view() timeline (Chromium) with an
  IntersectionObserver polyfill for Firefox/Safari. The `useReducedMotion`
  check skips the sweep entirely — identical to MatrixDivider's resting
  state. No motion library dependency.

  Under prefers-reduced-motion: a single static faint dim dotted line.
*/

export function ScanDivider({ className = "" }: { className?: string }) {
  const reduce = useReducedMotion();
  const sweepRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver fallback for browsers without view() timeline support
  useEffect(() => {
    const el = sweepRef.current;
    if (!el || reduce) return;

    // If CSS animation-timeline is supported, let CSS handle it
    if (CSS.supports("animation-timeline: view()")) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("scan-sweep-animate");
          io.disconnect(); // fire once
        }
      },
      { rootMargin: "-40px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduce]);

  if (reduce) {
    return <div className={`matrix-border h-px w-full opacity-70 ${className}`} />;
  }

  return (
    <div className={`relative h-px w-full ${className}`}>
      {/* resting dotted matrix base — always visible */}
      <div className="matrix-border absolute inset-0 opacity-70" />
      {/* sweeping signal-green line — CSS animated (or IO-triggered) */}
      <div
        ref={sweepRef}
        className="scan-divider__sweep"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(76,245,160,0.9), transparent)",
          boxShadow: "0 0 8px rgba(76,245,160,0.6)",
        }}
      />
    </div>
  );
}
