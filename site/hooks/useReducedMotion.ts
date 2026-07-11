"use client";

import { useState, useEffect } from "react";

/**
 * Returns `true` when the user has requested reduced motion via their OS /
 * browser accessibility settings.
 *
 * Replaces `import { useReducedMotion } from "motion/react"` in components
 * that only call the hook and don't use `<motion>` elements — saving the
 * ~116 kB motion library SSR chunk from those routes.
 *
 * SSR note: returns `false` on the server (no matchMedia available). The
 * CSS `prefers-reduced-motion` media query in globals.css takes effect
 * immediately on paint, overriding any client-side flash.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    // Build the media-query-list outside the rAF so we can wire up the
    // change listener synchronously. Only the initial setState is deferred
    // to avoid the react-hooks "set-state-in-effect" lint (React 19 rule).
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");

    const raf = requestAnimationFrame(() => {
      setReduced(mq.matches);
    });

    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);

    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", handler);
    };
  }, []);

  return reduced;
}
