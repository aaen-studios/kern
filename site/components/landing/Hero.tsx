"use client";

import Link from "next/link";
import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { Radar } from "@/components/radar/Radar";
import { VersionBadge } from "@/components/download/VersionBadge";
import { Badge } from "@/components/ui/Badge";
import { StatusDots } from "@/components/ui/StatusDots";
import { useSweepProximity } from "@/hooks/useSweepProximity";
import type { Release } from "@/lib/github";

const GITHUB = "https://github.com/aaen-studios/kern";

/*
  §10.2 — Hero. One viewport pinned inside a two-viewport wrapper: the radar
  scales and dims while the copy fades out, then the next section slides
  over the beam. Under prefers-reduced-motion the pin is skipped entirely
  and the hero renders as a single static viewport.

  The headline still illuminates when the sweep passes (radarsweep bridge).
*/
export function Hero({ release }: { release: Release | null }) {
  const line1Ref = useRef<HTMLSpanElement>(null);
  const line2Ref = useRef<HTMLSpanElement>(null);
  // hero radar fills the viewport, so the default viewport-centre radarCentre
  // is correct here.
  const bloom1 = useSweepProximity(line1Ref);
  const bloom2 = useSweepProximity(line2Ref);

  const reduce = useReducedMotion();
  const wrapRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: wrapRef,
    offset: ["start start", "end start"],
  });
  const copyOpacity = useTransform(scrollYProgress, [0.05, 0.55], [1, 0]);
  const copyY = useTransform(scrollYProgress, [0.05, 0.55], [0, -48]);
  const radarScale = useTransform(scrollYProgress, [0, 1], [1, 1.16]);
  const radarOpacity = useTransform(scrollYProgress, [0, 1], [1, 0.2]);

  const radarLayer = (
    <div className="absolute inset-0" aria-hidden="true">
      <Radar />
      {/* faint static dot-grid accent over the shader */}
      <div className="absolute inset-0 matrix-grid-faint opacity-40" />
    </div>
  );

  const copyLayer = (
    <div className="relative mx-auto w-full max-w-[1080px] px-4 py-32 sm:px-6">
      <div className="mb-6 flex items-center gap-3">
        <StatusDots status="wave" label="kern is online" count={4} />
        <span className="font-mono text-[11px] lowercase text-signal-low">
          signal acquired
        </span>
      </div>

      <h1 className="font-mono text-display lowercase text-zinc-100">
        <span
          ref={line1Ref}
          style={{
            textShadow: bloom1
              ? "0 0 6px rgba(76,245,160,0.7), 0 0 12px rgba(76,245,160,0.4)"
              : "none",
            transition: "text-shadow 120ms ease-out",
          }}
        >
          any server.
        </span>
        <br />
        <span
          ref={line2Ref}
          className="text-signal-high"
          style={{
            textShadow: bloom2
              ? "0 0 6px rgba(76,245,160,0.7), 0 0 12px rgba(76,245,160,0.4)"
              : "none",
            transition: "text-shadow 120ms ease-out",
          }}
        >
          one panel.
        </span>
      </h1>

      <p className="mt-6 max-w-xl font-mono text-sm leading-relaxed text-zinc-300">
        kern turns any folder on your computer into a managed server instance
        — with a live terminal, per-process telemetry, and graceful lifecycle.
        web servers, discord bots, local apis. teach it new types with
        plugins.
        <Badge tone="signal" className="ml-1">
          open source
        </Badge>
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          href="/#download"
          className="inline-flex items-center bg-signal-high px-5 py-2.5 font-mono text-sm lowercase text-bg-core transition hover:brightness-110"
        >
          download
        </Link>
        <a
          href={GITHUB}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center bg-bg-surface px-5 py-2.5 font-mono text-sm lowercase text-zinc-300 ring-1 ring-grid-bounds transition hover:text-signal-high"
        >
          view on github
        </a>
        {release && (
          <span className="ml-1">
            <VersionBadge tag={release.tag_name} />
          </span>
        )}
      </div>
    </div>
  );

  if (reduce) {
    return (
      <section className="relative flex min-h-[100svh] items-center overflow-hidden">
        {radarLayer}
        {copyLayer}
      </section>
    );
  }

  return (
    <section ref={wrapRef} className="relative h-[200vh]">
      <div className="sticky top-0 flex h-[100svh] items-center overflow-hidden">
        <motion.div
          className="absolute inset-0"
          style={{ scale: radarScale, opacity: radarOpacity }}
        >
          {radarLayer}
        </motion.div>
        <motion.div
          className="relative w-full"
          style={{ opacity: copyOpacity, y: copyY }}
        >
          {copyLayer}
        </motion.div>
      </div>
    </section>
  );
}
