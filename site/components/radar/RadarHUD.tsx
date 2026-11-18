"use client";

import { useEffect, useRef } from "react";

/*
  Instrument readout over the radar canvas. Pure DOM (no React state per
  frame): the sweep angle is written straight to textContent at ~5Hz.
  Decorative — the canvas is aria-hidden, and the hero copy carries meaning.
*/
export function RadarHUD({ angleRef }: { angleRef: React.RefObject<number> }) {
  const sweepRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const el = sweepRef.current;
      if (!el) return;
      const deg =
        ((((angleRef.current ?? 0) * 180) / Math.PI) % 360 + 360) % 360;
      el.textContent = `sweep ${deg.toFixed(0).padStart(3, "0")}°`;
    }, 200);
    return () => window.clearInterval(id);
  }, [angleRef]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 select-none font-mono text-[10px] lowercase leading-relaxed text-signal-low/80"
    >
      <span ref={sweepRef} className="absolute bottom-6 left-6">
        sweep 000°
      </span>
      <span className="absolute bottom-6 right-6 hidden sm:inline">
        sector a7 · gain 1.0 · phosphor 400ms
      </span>
      <span className="absolute right-6 top-20 text-right">
        registry (0)
        <br />
        <span className="text-signal-low/60">no instances registered</span>
      </span>
    </div>
  );
}
