"use client";

import { useEffect, useState } from "react";

/*
  Appears after scrolling down; smooth-scrolls to top.
  Hidden under prefers-reduced-motion (CSS handles the transition).
*/
export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (!visible) return null;

  return (
    <button
      onClick={toTop}
      aria-label="back to top"
      className="fixed bottom-6 right-6 z-40 inline-flex h-9 w-9 items-center justify-center bg-bg-surface text-signal-low ring-1 ring-grid-bounds transition-colors hover:text-signal-high"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M7 3L2.5 7.5l.9.9L7 4.8l3.6 3.6.9-.9z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
