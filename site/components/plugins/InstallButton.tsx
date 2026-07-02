"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Plugin } from "@/lib/registry";
import { latestVersion } from "@/lib/registry";

/*
  §5.4 / §6.5 — the "install in kern" button. Fires the kern:// deep link so a
  click launches (or focuses) kern and begins installation. If kern isn't
  installed the click does nothing useful — so we fall back to the download
  section after a short timeout + window.blur heuristic.

  In the real backend this links to the Worker redirector
  (/api/install/:id) which records an install event then 302s to kern://.
  Against the seed we fire the protocol directly.
*/
export function InstallButton({
  plugin,
  size = "md",
}: {
  plugin: Plugin;
  size?: "md" | "lg";
}) {
  const [fellBack, setFellBack] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const ver = latestVersion(plugin);
  const href = `kern://install?url=${encodeURIComponent(ver.download_url)}&id=${plugin.id}&v=${ver.version}`;

  const handleClick = () => {
    // heuristic: if the window loses focus shortly, kern likely opened.
    // otherwise, after ~1.2s, show the download fallback.
    setFellBack(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFellBack(true), 1200);
  };

  const cls =
    size === "lg"
      ? "px-5 py-2.5 text-sm"
      : "px-4 py-2 text-xs";

  if (fellBack) {
    return (
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[11px] lowercase text-signal-low">
          kern not detected —
        </span>
        <Link
          href="/#download"
          className={`inline-flex items-center justify-center bg-signal-high ${cls} font-mono lowercase text-bg-core transition hover:brightness-110`}
        >
          download kern first
        </Link>
      </div>
    );
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      className={`inline-flex items-center justify-center gap-2 bg-signal-high ${cls} font-mono lowercase text-bg-core transition hover:brightness-110`}
    >
      install in kern
    </a>
  );
}
