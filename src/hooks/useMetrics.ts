import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ShaderTelemetry } from "../types/matrix";

/**
 * Live telemetry polling for the matrix shader engine.
 *
 * Pull-based: the host samples CPU/RAM on an interval via `get_instance_metrics`
 * / `get_host_metrics` rather than subscribing to a push event. The renderer
 * (`MatrixViewport`) reads telemetry via a ref on its own rAF cadence, so a 1 Hz
 * feed is plenty — the radar interpolates smoothly between samples.
 *
 * Mirrors the command/interval hygiene of useServerControl: a `disposed` flag
 * drops any in-flight result that resolves after unmount, and the interval is
 * always cleared on teardown.
 */

/** Mirrors InstanceMetrics in src-tauri/src/metrics.rs (camelCase on the wire). */
type InstanceMetrics = { cpu: number; ram: number; status: string };

/** Idle telemetry shown before the first sample resolves. */
const IDLE: ShaderTelemetry = { cpu: 0, ram: 0, status: "idle" };

/** Poll cadence. 1000ms is calm (the radar sweeps at its own rate) and keeps
 *  the sysinfo refresh off the main path. */
const POLL_MS = 1000;

/**
 * Polls live CPU/RAM telemetry for a single server instance. Sampling only runs
 * while `serverId` is set; pass `null` to idle (e.g. before a server is picked).
 */
export function useMetrics(serverId: string | null): ShaderTelemetry {
  const [telemetry, setTelemetry] = useState<ShaderTelemetry>(IDLE);

  useEffect(() => {
    if (!serverId) {
      setTelemetry(IDLE);
      return;
    }
    let disposed = false;

    const sample = async () => {
      // Skip work while the window is hidden (tray/minimized): nobody is
      // looking at the radar, and the backend sampling has a cost.
      if (document.hidden) return;
      try {
        const m = await invoke<InstanceMetrics>("get_instance_metrics", { id: serverId });
        if (!disposed) setTelemetry({ cpu: m.cpu, ram: m.ram, status: m.status });
      } catch {
        // A failed read (instance just deleted, etc.) is non-fatal — leave the
        // last reading in place rather than flickering the radar.
      }
    };

    // Seed immediately so the radar doesn't sit at idle for a full tick, then
    // keep polling on the interval.
    void sample();
    const timer = setInterval(sample, POLL_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [serverId]);

  return telemetry;
}

/**
 * Polls host-wide CPU/RAM telemetry, used by the empty-state radar so the
 * dashboard pulses with the real machine load even when no instances exist.
 * Always active while the host view is mounted.
 */
export function useHostMetrics(): ShaderTelemetry {
  const [telemetry, setTelemetry] = useState<ShaderTelemetry>(IDLE);

  useEffect(() => {
    let disposed = false;
    const sample = async () => {
      if (document.hidden) return;
      try {
        const m = await invoke<InstanceMetrics>("get_host_metrics");
        if (!disposed) setTelemetry({ cpu: m.cpu, ram: m.ram, status: m.status });
      } catch {
        // Non-fatal — leave the last reading in place.
      }
    };
    void sample();
    const timer = setInterval(sample, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return telemetry;
}
