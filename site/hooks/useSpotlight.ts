"use client";

import { useCallback } from "react";

/**
 * Cursor-reactive radar bloom.
 *
 * Returns pointer handlers that track the mouse position on an element via
 * the `--bloom-x` / `--bloom-y` CSS custom properties. Pair with the
 * `spotlight` utility class (globals.css), which paints a signal-green
 * radial `::before` bloom positioned at those coordinates.
 *
 * No global provider — opt in per surface:
 *   const handlers = useSpotlight();
 *   <div className="spotlight" {...handlers}>…</div>
 *
 * Pointer-driven motion (not autonomous), so it is fine under
 * prefers-reduced-motion; the global CSS gate neutralises the fade transition
 * anyway.
 */
export function useSpotlight() {
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--bloom-x", `${e.clientX - rect.left}px`);
      el.style.setProperty("--bloom-y", `${e.clientY - rect.top}px`);
    },
    [],
  );

  return { onPointerMove };
}
