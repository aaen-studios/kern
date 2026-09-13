import type { RadarBackend, RadarFrame } from "@/components/radar/types";

/*
  Canvas 2D radar backend — the universal fallback (no WebGPU, or a lost
  device). Same language as the WGSL radar: concentric rings of dots, a true
  trailing sector (modular angular falloff behind the beam), engraved tick
  marks, a pulsing core, grain, and a vignette. ~30fps, capped DPR.
*/

type Ring = { radius: number; count: number; opacity: number };

const TAU = Math.PI * 2;
const SIGNAL = "#4cf5a0";
const SIGNAL_RGB = "76,245,160";

function buildRings(maxR: number): Ring[] {
  const radii = [0.18, 0.3, 0.42, 0.55, 0.68, 0.82];
  return radii
    .map((f, i) => ({
      radius: f * maxR,
      count: 6 + i * 4,
      opacity: 0.5 - i * 0.06,
    }))
    .filter((r) => r.radius < maxR);
}

// angular distance of `a` behind `sweep`, in [0, TAU)
function behind(a: number, sweep: number) {
  const d = (sweep - a) % TAU;
  return d < 0 ? d + TAU : d;
}

function sweepEnergy(a: number, sweep: number) {
  const d = behind(a, sweep);
  const trail = TAU * 0.35;
  const sector = d < trail ? (1 - d / trail) ** 2 : 0;
  const beam = Math.exp(-d * d * 260);
  return sector * 0.35 + beam * 0.9;
}

export function createCanvas2DBackend(): RadarBackend {
  return {
    render(ctx, frame) {
      const { width, height, cx, cy, maxR, t } = frame;
      const rings = buildRings(maxR);
      const sweepAngle = t * 0.5;

      ctx.clearRect(0, 0, width, height);

      // soft radial bloom behind core
      const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.7);
      bloom.addColorStop(0, `rgba(${SIGNAL_RGB},0.10)`);
      bloom.addColorStop(0.5, `rgba(${SIGNAL_RGB},0.03)`);
      bloom.addColorStop(1, `rgba(${SIGNAL_RGB},0)`);
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, width, height);

      // concentric rings of dots: traveling wave + sweep trail energy
      rings.forEach((ring, ri) => {
        for (let i = 0; i < ring.count; i++) {
          const a = (i / ring.count) * TAU - Math.PI / 2;
          const x = cx + Math.cos(a) * ring.radius;
          const y = cy + Math.sin(a) * ring.radius;
          const w = 0.5 + 0.5 * Math.sin(i / ring.count * TAU + t * 0.6);
          const energy = sweepEnergy(a, sweepAngle);
          ctx.globalAlpha = ring.opacity * (0.15 + 0.45 * w + 0.7 * energy);
          ctx.fillStyle = energy > 0.55 ? SIGNAL : "#1f3a2c";
          ctx.beginPath();
          ctx.arc(x, y, ri === 0 ? 1.8 : 1.3, 0, TAU);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;

      // engraved tick marks on the outer ring (every 6 degrees)
      const tickInner = maxR * 0.855;
      const tickOuter = maxR * 0.9;
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * TAU - Math.PI / 2;
        const major = i % 5 === 0;
        ctx.strokeStyle = `rgba(${SIGNAL_RGB},${major ? 0.30 : 0.14})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * tickInner, cy + Math.sin(a) * tickInner);
        ctx.lineTo(
          cx + Math.cos(a) * (major ? tickOuter : tickOuter - 4),
          cy + Math.sin(a) * (major ? tickOuter : tickOuter - 4),
        );
        ctx.stroke();
      }

      // rotating sweep beam (thin bright spoke; the trail lives in the dots)
      const grad = ctx.createLinearGradient(
        cx,
        cy,
        cx + Math.cos(sweepAngle) * maxR,
        cy + Math.sin(sweepAngle) * maxR,
      );
      grad.addColorStop(0, `rgba(${SIGNAL_RGB},0.35)`);
      grad.addColorStop(1, `rgba(${SIGNAL_RGB},0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(sweepAngle) * maxR,
        cy + Math.sin(sweepAngle) * maxR,
      );
      ctx.stroke();

      // grain (sparse, cheap)
      for (let i = 0; i < 220; i++) {
        const gx = Math.random() * width;
        const gy = Math.random() * height;
        ctx.fillStyle = `rgba(${SIGNAL_RGB},${Math.random() * 0.035})`;
        ctx.fillRect(gx, gy, 1, 1);
      }

      // core
      ctx.fillStyle = SIGNAL;
      ctx.globalAlpha = 0.85 + 0.15 * Math.sin(t * 2);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2.5, maxR * 0.05), 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = `rgba(${SIGNAL_RGB},0.25)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(5, maxR * 0.1), 0, TAU);
      ctx.stroke();

      // vignette
      const vignette = ctx.createRadialGradient(
        cx,
        cy,
        maxR * 0.5,
        cx,
        cy,
        maxR * 1.25,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.35)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);

      return { sweepAngle };
    },

    renderStatic(ctx, { width, height, cx, cy, maxR }: RadarFrame) {
      ctx.fillStyle = "rgba(22,25,32,0.5)";
      const step = 14;
      for (let x = step / 2; x < width; x += step) {
        for (let y = step / 2; y < height; y += step) {
          ctx.beginPath();
          ctx.arc(x, y, 0.8, 0, TAU);
          ctx.fill();
        }
      }
      // static rings + ticks, so the reduced-motion frame still reads as an
      // instrument rather than a blank state
      const rings = buildRings(maxR);
      rings.forEach((ring, ri) => {
        for (let i = 0; i < ring.count; i++) {
          const a = (i / ring.count) * TAU - Math.PI / 2;
          ctx.fillStyle = "#1f3a2c";
          ctx.beginPath();
          ctx.arc(
            cx + Math.cos(a) * ring.radius,
            cy + Math.sin(a) * ring.radius,
            ri === 0 ? 1.6 : 1.2,
            0,
            TAU,
          );
          ctx.fill();
        }
      });
      ctx.fillStyle = SIGNAL;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, maxR * 0.08), 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    },
  };
}
