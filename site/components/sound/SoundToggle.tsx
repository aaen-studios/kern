"use client";

import { useSound } from "@/hooks/useSound";

/*
  Console-ambience toggle for the navbar. A small speaker glyph that flips
  between muted / unmuted. Disabled (with a `// silenced` tooltip) under
  prefers-reduced-motion, which force-silences sound regardless of the toggle.
*/
export function SoundToggle() {
  const { enabled, silenced, ready, toggle } = useSound();

  // before hydration, render a placeholder so the nav doesn't shift
  if (!ready) {
    return <span className="hidden h-7 w-7 sm:inline-block" aria-hidden="true" />;
  }

  if (silenced) {
    return (
      <span
        title="// silenced (reduced motion)"
        aria-label="console ambience silenced due to reduced motion"
        className="hidden h-7 w-7 items-center justify-center font-mono text-xs text-signal-low/50 sm:flex"
      >
        ◌
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={enabled ? "mute console ambience" : "enable console ambience"}
      title={enabled ? "console ambience on" : "console ambience off"}
      className="flex h-7 w-7 items-center justify-center font-mono text-xs text-signal-low transition-colors hover:text-signal-high"
    >
      {enabled ? "♪" : "♪̸"}
    </button>
  );
}
