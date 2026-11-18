/**
 * DPR-aware canvas sizing.
 *
 * Caps devicePixelRatio at 2 to bound pixel workload, matches the backing
 * store to the element's CSS size, and applies the transform so all
 * subsequent draw coordinates use CSS pixels. Only resizes when dimensions
 * actually change — avoids redundant clears on every frame.
 *
 * Extracted from RadarShader / RegistryRadar.
 */
export function setupCanvasDPR(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { width: number; height: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);

  if (
    canvas.width !== Math.floor(width * dpr) ||
    canvas.height !== Math.floor(height * dpr)
  ) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  return { width, height, dpr };
}
