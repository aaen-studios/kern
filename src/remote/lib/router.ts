/** Minimal hash router (`#/s/<id>/files`) — no dependency, no server support
    needed beyond serving `/`. */

import { useEffect, useState } from "react";

export function currentSegments(): string[] {
  const hash = location.hash.replace(/^#\/?/, "");
  return hash
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}

export function navigate(to: string): void {
  const next = to.startsWith("#") ? to : `#${to}`;
  if (location.hash === next) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = next;
  }
}

export function useSegments(): string[] {
  const [segments, setSegments] = useState<string[]>(currentSegments);
  useEffect(() => {
    const onChange = () => setSegments(currentSegments());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return segments;
}
