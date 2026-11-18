import { clock, effect, frameLoop, init, surface } from "vgpu";
import shader from "@/lib/radar/radar.wgsl";
import type { RadarQuality, RadarStats } from "@/components/radar/types";

/*
  WebGPU radar backend (vgpu). One fullscreen effect: rings, trailing sweep,
  ticks, grain. Owns its frame loop; Radar owns policy (visibility, quality,
  pointer, fallback). Anything that throws here means "use the 2D backend".
*/

export interface WebGPURadarHandle {
  setQuality(quality: RadarQuality): void;
  setPointer(x: number, y: number): void;
  setGain(gain: number): void;
  stop(): void;
  dispose(): void;
}

export interface WebGPURadarOptions {
  quality?: RadarQuality;
  sweepSpeed?: number;
  onSweep?: (angle: number) => void;
  onStats?: (stats: RadarStats) => void;
  /** device lost / driver reset — the caller should fall back to Canvas 2D */
  onLost?: () => void;
}

const TAU = Math.PI * 2;

export async function createWebGPURadar(
  canvas: HTMLCanvasElement,
  options: WebGPURadarOptions = {},
): Promise<WebGPURadarHandle> {
  const sweepSpeed = options.sweepSpeed ?? 0.5;
  let quality: RadarQuality = options.quality ?? "high";

  const gpu = await init();
  const target = surface(gpu, canvas, { dpr: [1, 2] });

  let disposed = false;
  gpu.device.gpu.lost.then(() => {
    if (!disposed) options.onLost?.();
  });

  const cssSize = (): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height))];
  };

  const fx = effect(gpu, shader, {
    set: {
      params: {
        time: 0,
        resolution: cssSize(),
        pointer: [0.5, 0.5],
        quality: quality === "low" ? 0 : 1,
        sweepSpeed,
        gain: 1,
      },
    },
  });

  // size-class uniforms belong to resize, not the render loop
  target.onResize(() => {
    fx.set({ params: { resolution: cssSize() } });
  });

  const time = clock(gpu);

  // presented-fps watchdog (1s window) so Radar can drop quality on weak GPUs
  let frames = 0;
  let elapsed = 0;

  const handle = frameLoop(
    gpu,
    (frame) => {
      fx.set({ params: { time: time.time } });

      if (options.onSweep) {
        options.onSweep((time.time * sweepSpeed) % TAU);
      }

      frames += 1;
      elapsed += time.deltaTime;
      if (elapsed >= 1 && options.onStats) {
        options.onStats({ fps: frames / elapsed, frameCount: time.frameCount });
        frames = 0;
        elapsed = 0;
      }

      frame.pass(target, fx);
    },
    { fps: quality === "low" ? 24 : 30 },
  );

  return {
    setQuality(next) {
      quality = next;
      fx.set({ params: { quality: next === "low" ? 0 : 1 } });
    },
    setPointer(x, y) {
      fx.set({ params: { pointer: [x, y] } });
    },
    setGain(gain) {
      fx.set({ params: { gain } });
    },
    stop() {
      handle.stop();
    },
    dispose() {
      disposed = true;
      handle.stop();
      gpu.dispose();
    },
  };
}
