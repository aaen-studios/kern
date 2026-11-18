"use client";

import { useSound } from "@/hooks/useSound";

/*
  Console-ambience toggle for the navbar. A small speaker glyph that flips
  between unmuted / muted. Disabled (with a `// silenced` tooltip) under
  prefers-reduced-motion, which force-silences sound regardless of the toggle.

  Uses inline SVG (not a combining-character glyph) so the muted state renders
  consistently across platforms/fonts.
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
        className="hidden h-7 w-7 items-center justify-center text-signal-low/50 sm:flex"
      >
        <SpeakerIcon muted />
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
      className="flex h-7 w-7 items-center justify-center text-signal-low transition-colors hover:text-signal-high"
    >
      <SpeakerIcon muted={!enabled} />
    </button>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="inline-block"
    >
      {/* speaker body */}
      <path d="M3 6v4h2.5L9 13V3L5.5 6H3z" fill="currentColor" stroke="none" />
      {muted ? (
        <>
          <line x1="11" y1="6" x2="14" y2="10" />
          <line x1="14" y1="6" x2="11" y2="10" />
        </>
      ) : (
        <>
          <path d="M11 5.5a3 3 0 010 5" />
          <path d="M12.8 3.8a5.5 5.5 0 010 8.4" />
        </>
      )}
    </svg>
  );
}
