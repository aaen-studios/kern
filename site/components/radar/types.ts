/*
  Radar backend contract. `Radar` owns the canvas lifecycle (DPR, resize,
  rAF, visibility, reduced motion); a backend only draws one frame.

  Backends: Canvas 2D today, vgpu/WebGPU in the next phase, static for
  reduced motion.
*/

export interface RadarFrame {
  /** CSS pixels (the ctx transform is already DPR-scaled) */
  width: number;
  height: number;
  cx: number;
  cy: number;
  maxR: number;
  /** seconds since the loop started */
  t: number;
}

export interface RadarBackend {
  /** draw one animated frame; returns metadata for event consumers */
  render(ctx: CanvasRenderingContext2D, frame: RadarFrame): { sweepAngle: number };
  /** draw the static (prefers-reduced-motion) frame */
  renderStatic(ctx: CanvasRenderingContext2D, frame: RadarFrame): void;
}

export interface RadarProps {
  /** receives the current sweep angle (radians) each frame */
  onSweep?: (angle: number) => void;
  className?: string;
}
