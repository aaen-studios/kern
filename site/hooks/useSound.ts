"use client";

import { createContext, useContext } from "react";

export type SoundVoice = "blip" | "fault" | "sweep";

export interface SoundContextValue {
  /** whether sound is enabled (and not force-silenced by reduced motion) */
  enabled: boolean;
  /** raw toggle state from localStorage, ignoring reduced-motion silence */
  enabledRaw: boolean;
  /** true when prefers-reduced-motion forces silence regardless of toggle */
  silenced: boolean;
  /** true once the toggle state has hydrated from localStorage */
  ready: boolean;
  toggle: () => void;
  play: (voice: SoundVoice) => void;
}

export const SoundContext = createContext<SoundContextValue | null>(null);

/**
 * Access the sound system. Returns null-safe helpers. Throws if used outside
 * a <SoundProvider> (matches the useAuth() pattern in this repo).
 */
export function useSound(): SoundContextValue {
  const ctx = useContext(SoundContext);
  if (!ctx) {
    throw new Error("useSound must be used within a <SoundProvider>");
  }
  return ctx;
}
