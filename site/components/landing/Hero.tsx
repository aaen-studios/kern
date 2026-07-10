"use client";

import Link from "next/link";
import { RadarShader } from "@/components/landing/RadarShader";
import { VersionBadge } from "@/components/download/VersionBadge";
import { Badge } from "@/components/ui/Badge";
import { StatusDots } from "@/components/ui/StatusDots";
import { useRef } from "react";
import { useSweepProximity } from "@/hooks/useSweepProximity";
import type { Release } from "@/lib/github";

const GITHUB = "https://github.com/aaen-studios/kern";

/*
  §10.2 — Hero. Full viewport. Animated Signal Radar shader behind the
  headline (aria-hidden). Foreground: lowercase H1, one-line subhead naming
  servers/bots/apis, primary download + view-on-github, live version badge.
*/
export function Hero({ release }: { release: Release | null }) {
  const line1Ref = useRef<HTMLSpanElement>(null);
  const line2Ref = useRef<HTMLSpanElement>(null);
  // hero radar fills the viewport, so the default viewport-centre radarCentre
  // is correct here.
  const bloom1 = useSweepProximity(line1Ref);
  const bloom2 = useSweepProximity(line2Ref);

  return (
    <section className="relative flex min-h-[100svh] items-center overflow-hidden">
      {/* shader background — decorative */}
      <div className="absolute inset-0" aria-hidden="true">
        <RadarShader />
      </div>
      {/* faint static dot-grid accent over the shader */}
      <div
        className="absolute inset-0 matrix-grid-faint opacity-40"
        aria-hidden="true"
      />

      <div className="relative mx-auto w-full max-w-[1080px] px-4 py-32 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <StatusDots status="wave" label="kern is online" count={4} />
          <span className="font-mono text-[11px] lowercase text-signal-low">
            signal acquired
          </span>
        </div>

        <h1 className="font-mono text-4xl lowercase leading-[1.05] text-zinc-100 sm:text-6xl">
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
    </section>
  );
}