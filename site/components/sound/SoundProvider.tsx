"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { SoundContext, type SoundVoice } from "@/hooks/useSound";

/*
  Synthesised console ambience — zero audio assets, all voices built from
  Web Audio oscillator + gain graphs on demand.

  Voices:
    blip  — short signal-green sine ping (status transition)
    fault — descending crimson sawtooth (error)
    sweep — low tone synced to the hero radar sweep

  Rules:
    - mute by default; toggle persisted in localStorage["kern-sound"]
    - AudioContext is created lazily and resumed on the first user gesture
      (browsers block autoplay audio until then)
    - force-silenced under prefers-reduced-motion, even if the toggle is on
    - the hum drone starts when enabled, stops when disabled
*/

const STORAGE_KEY = "kern-sound";

export function SoundProvider({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  const [enabledRaw, setEnabledRaw] = useState(false);
  const [ready, setReady] = useState(false); // hydrated from localStorage

  const ctxRef = useRef<AudioContext | null>(null);
  const humRef = useRef<{ stop: () => void } | null>(null);
  // sweep throttling — don't fire a tone on every radar frame
  const lastSweepRef = useRef(0);

  // hydrate the toggle from localStorage once on mount. deferred to next frame
  // to avoid a synchronous setState in the effect body.
  useEffect(() => {
    let raf = 0;
    raf = requestAnimationFrame(() => {
      try {
        if (localStorage.getItem(STORAGE_KEY) === "1") setEnabledRaw(true);
      } catch {
        /* storage unavailable — leave default */
      }
      setReady(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const silenced = !!reduce;
  const enabled = enabledRaw && !silenced;

  // lazily build (or resume) the AudioContext
  const getCtx = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (!ctxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctxRef.current = new Ctor();
    }
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  // manage the continuous hum drone
  useEffect(() => {
    if (!enabled) {
      humRef.current?.stop();
      humRef.current = null;
      return;
    }
    const ctx = getCtx();
    if (!ctx) return;

    // low drone: ~58Hz sine + a filtered noise bed, very low gain
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // fade in
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 1.2);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 58;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.6;
    osc.connect(oscGain).connect(master);
    osc.start();

    // filtered noise bed
    const noiseBuf = makeNoiseBuffer(ctx, 2);
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.value = 120;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.08;
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    noise.start();

    humRef.current = {
      stop: () => {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0, t + 0.4);
        setTimeout(() => {
          try {
            osc.stop();
            noise.stop();
            master.disconnect();
          } catch {
            /* already torn down */
          }
        }, 500);
      },
    };

    return () => {
      humRef.current?.stop();
      humRef.current = null;
    };
  }, [enabled, getCtx]);

  // resume the context on the first user gesture (autoplay policy)
  useEffect(() => {
    if (!enabled) return;
    const unlock = () => getCtx();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [enabled, getCtx]);

  const play = useCallback(
    (voice: SoundVoice) => {
      if (!enabled) return;
      const ctx = getCtx();
      if (!ctx) return;
      const now = ctx.currentTime;

      if (voice === "blip") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (voice === "fault") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(70, now + 0.35);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.42);
      } else if (voice === "sweep") {
        // throttle: at most one sweep tone per ~700ms
        if (now - lastSweepRef.current < 0.7) return;
        lastSweepRef.current = now;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(180, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.05, now + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.62);
      }
    },
    [enabled, getCtx],
  );

  const toggle = useCallback(() => {
    setEnabledRaw((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  // hero radar sweep → low sweep tone (throttled inside play())
  useEffect(() => {
    if (!enabled) return;
    const onSweep = () => play("sweep");
    window.addEventListener("radarsweep", onSweep);
    return () => window.removeEventListener("radarsweep", onSweep);
  }, [enabled, play]);

  const value = useMemo(
    () => ({ enabled, enabledRaw, silenced, toggle, play, ready }),
    [enabled, enabledRaw, silenced, toggle, play, ready],
  );

  return (
    <SoundContext.Provider value={value}>{children}</SoundContext.Provider>
  );
}

function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
