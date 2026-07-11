"use client";

import { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useRafLoop } from "@/hooks/useRafLoop";
import { setupCanvasDPR } from "@/lib/canvas";
import type { Plugin } from "@/lib/registry";

/*
  Registry Radar — §7.1 alternate view.
  A live radar sweep that maps every plugin in the registry to a blip on
  concentric rings. Inner ring = recently updated, outer rings = older.
  Blip brightness pulses as the sweep passes. Click a blip to navigate.
  Hover for a tooltip with name + installs.

  Shares the same rendering DNA as RadarShader (hero) but is driven by
  *real plugin data* instead of being purely decorative.
*/

// ── Visual constants ──────────────────────────────────────────────
const SIGNAL = "#4cf5a0";
const SIGNAL_DIM = "rgba(76,245,160,0.4)";
const BLOOM = "rgba(76,245,160,0.08)";
const RING_COUNT = 4;
const SWEEP_SPEED = 0.4; // radians per second
const BLIP_MIN_R = 4;
const BLIP_MAX_R = 12;

// ── Helpers ───────────────────────────────────────────────────────

function hashAngle(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 1000) / 1000) * Math.PI * 2;
}

function scaleSize(value: number, min: number, max: number): number {
  if (max === min) return BLIP_MIN_R;
  const normalized =
    (Math.log(value + 1) - Math.log(min + 1)) /
    (Math.log(max + 1) - Math.log(min + 1));
  return BLIP_MIN_R + normalized * (BLIP_MAX_R - BLIP_MIN_R);
}

// ── Component ─────────────────────────────────────────────────────

export function RegistryRadar({ plugins }: { plugins: Plugin[] }) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Tooltip state (doesn't affect canvas)
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    plugin: Plugin;
  } | null>(null);

  // "now" captured once on mount (client-only) so the blip memo stays pure.
  // ring assignment is day-granularity, so a stale-ish timestamp is fine.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Compute blip data (memoized) ─────────────────────────────────
  const blips = useMemo(() => {
    if (!now) return [];
    const DAY_MS = 86400000;
    const maxInstalls = Math.max(...plugins.map((p) => p.install_count), 1);
    const minInstalls = Math.min(...plugins.map((p) => p.install_count), 0);

    return plugins.map((p) => {
      const age = now - p.updated_at;
      const ringIndex =
        age < 7 * DAY_MS
          ? 0
          : age < 30 * DAY_MS
            ? 1
            : age < 180 * DAY_MS
              ? 2
              : 3;
      return {
        id: p.id,
        displayName: p.display_name,
        category: p.category,
        installCount: p.install_count,
        ringIndex,
        angle: hashAngle(p.id),
        size: scaleSize(p.install_count, minInstalls, maxInstalls),
      };
    });
  }, [plugins, now]);

  // keep the latest blips available to the draw loop without restarting it.
  // mirrored in an effect (not during render) per the React refs rule.
  const blipsRef = useRef(blips);
  const reduceRef = useRef(reduce);
  useEffect(() => {
    blipsRef.current = blips;
    reduceRef.current = reduce;
  });

  // ── Canvas render loop (stable, reads from refs) ──────────────────
  useRafLoop((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = setupCanvasDPR(canvas, ctx);
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.min(width, height) * 0.38;

    const isReduced = reduceRef.current;
    const blipsCurrent = blipsRef.current;

    ctx.clearRect(0, 0, width, height);

    // Background bloom
    const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.2);
    bloom.addColorStop(0, BLOOM);
    bloom.addColorStop(1, "rgba(76,245,160,0)");
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);

    // Concentric rings (faint guide)
    for (let i = 0; i < RING_COUNT; i++) {
      const rr = ((i + 1) / (RING_COUNT + 1)) * maxR;
      ctx.strokeStyle = "rgba(22,25,32,0.6)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();

      const labels = ["this week", "this month", "6 months", "older"];
      ctx.fillStyle = "#4c525e";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(labels[i], cx + rr + 4, cy + 5);
    }

    // Sweep angle
    const sweepAngle = t * SWEEP_SPEED;

    // Draw blips
    for (const blip of blipsCurrent) {
      const r = (blip.ringIndex + 1) / (RING_COUNT + 1) * maxR;
      const x = cx + Math.cos(blip.angle) * r;
      const y = cy + Math.sin(blip.angle) * r;

      let delta = blip.angle - sweepAngle;
      while (delta < -Math.PI) delta += Math.PI * 2;
      while (delta > Math.PI) delta -= Math.PI * 2;
      const proximity = isReduced ? 0.6 : Math.max(0, 1 - Math.abs(delta) / 0.5);

      const baseOpacity = 0.4 + 0.6 * proximity;
      const size = blip.size * (0.8 + 0.2 * proximity);

      // Glow for active blip
      if (proximity > 0.5) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
        g.addColorStop(0, `rgba(76,245,160,${0.2 * proximity})`);
        g.addColorStop(1, "rgba(76,245,160,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, size * 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Blip body
      ctx.globalAlpha = baseOpacity;
      ctx.fillStyle = blip.installCount > 0 ? SIGNAL : SIGNAL_DIM;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(76,245,160,0.3)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Sweep line
    if (!isReduced) {
      const grad = ctx.createLinearGradient(
        cx,
        cy,
        cx + Math.cos(sweepAngle) * maxR,
        cy + Math.sin(sweepAngle) * maxR,
      );
      grad.addColorStop(0, "rgba(76,245,160,0.4)");
      grad.addColorStop(1, "rgba(76,245,160,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(sweepAngle) * maxR,
        cy + Math.sin(sweepAngle) * maxR,
      );
      ctx.stroke();
    }

    // Core
    ctx.fillStyle = SIGNAL;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(4, maxR * 0.05), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  // ── Interaction: click to navigate, hover for tooltip ────────────
  const getPluginAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return null;

      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const maxR = Math.min(rect.width, rect.height) * 0.38;

      for (const blip of blips) {
        const r = (blip.ringIndex + 1) / (RING_COUNT + 1) * maxR;
        const x = rect.left + cx + Math.cos(blip.angle) * r;
        const y = rect.top + cy + Math.sin(blip.angle) * r;
        const dx = clientX - x;
        const dy = clientY - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < blip.size + 8) {
          const plugin = plugins.find((p) => p.id === blip.id);
          if (plugin) return { plugin, x: clientX, y: clientY };
        }
      }
      return null;
    },
    [blips, plugins],
  );

  const handleInteraction = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const hit = getPluginAt(e.clientX, e.clientY);
      if (hit) {
        setTooltip(hit);
        canvasRef.current!.style.cursor = "pointer";
      } else {
        setTooltip(null);
        canvasRef.current!.style.cursor = "default";
      }
    },
    [getPluginAt],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const hit = getPluginAt(e.clientX, e.clientY);
      if (hit) router.push(`/plugins/${hit.plugin.id}`);
    },
    [getPluginAt, router],
  );

  return (
    <div ref={containerRef} className="relative">
      <p className="mb-4 font-mono text-xs lowercase text-signal-low">
        registry ({plugins.length}) · radar view
      </p>

      <div className="relative bg-bg-core/40" style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}>
        <canvas
          ref={canvasRef}
          className="h-[600px] w-full cursor-default"
          onClick={handleClick}
          onMouseMove={handleInteraction}
          onMouseLeave={() => setTooltip(null)}
          role="img"
          aria-label={`Plugin registry radar with ${plugins.length} plugins`}
        />

        {tooltip && (
          <div
            className="pointer-events-none fixed z-50 flex flex-col gap-1 rounded-sm bg-bg-surface px-3 py-2 ring-1 ring-grid-bounds"
            style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
          >
            <span className="font-mono text-xs text-signal-high lowercase">
              {tooltip.plugin.display_name}
            </span>
            <div className="flex items-center gap-2 font-mono text-[10px] text-signal-low">
              <span>{tooltip.plugin.category}</span>
              <span>↓ {tooltip.plugin.install_count.toLocaleString()}</span>
            </div>
          </div>
        )}

        <div className="mt-2 px-4 pb-4 text-center font-mono text-[11px] text-signal-low">
          hover to identify · click to open
        </div>
      </div>
    </div>
  );
}