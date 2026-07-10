"use client";

import { motion, useReducedMotion } from "motion/react";

/*
  Scan-line section divider. A drop-in alternative to MatrixDivider: same
  h-px w-full footprint, but a signal-green horizontal line sweeps left→right
  across the divider when scrolled into view, then fades to the usual dim
  dotted matrix. Used between landing sections to reveal them.

  Static (no sweep) under prefers-reduced-motion.
*/
export function ScanDivider({ className = "" }: { className?: string }) {
  const reduce = useReducedMotion();

  if (reduce) {
    // identical to MatrixDivider's resting state
    return <div className={`matrix-border h-px w-full opacity-70 ${className}`} />;
  }

  return (
    <div className={`relative h-px w-full ${className}`}>
      {/* resting dotted matrix base */}
      <div className="matrix-border absolute inset-0 opacity-70" />
      {/* sweeping signal-green line */}
      <motion.div
        className="absolute inset-y-0 left-0"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(76,245,160,0.9), transparent)",
          boxShadow: "0 0 8px rgba(76,245,160,0.6)",
        }}
        initial={{ width: "0%", opacity: 0 }}
        whileInView={{ width: "100%", opacity: [0, 1, 1, 0] }}
        viewport={{ once: true, margin: "-40px" }}
        transition={{ duration: 0.9, ease: "easeInOut" }}
      />
    </div>
  );
}
