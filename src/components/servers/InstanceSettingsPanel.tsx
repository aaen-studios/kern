/**
 * Per-instance settings panel.
 *
 * The single place where instance-level behaviour lives: graceful-stop
 * behavior, and the visibility of optional feature surfaces. Everything here
 * persists to the server record via `update_server`, so it survives restarts
 * and syncs with the rest of the registry.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerInstance } from "../../types/server";
import { INSTANCE_FEATURES, isFeatureEnabled } from "./instanceFeatures";
import { useToast } from "../../hooks/useToast";

interface InstanceSettingsPanelProps {
  server: ServerInstance;
  /** Called after a successful save so the parent can reload the registry. */
  onSaved: () => void;
}

type StopMode = "default" | "custom" | "none";

function stopModeOf(server: ServerInstance): StopMode {
  if (server.stopCommand === undefined || server.stopCommand === null) return "default";
  if (server.stopCommand.trim() === "") return "none";
  return "custom";
}

export function InstanceSettingsPanel({ server, onSaved }: InstanceSettingsPanelProps) {
  const { notify } = useToast();

  const [stopMode, setStopMode] = useState<StopMode>(stopModeOf(server));
  const [stopCommand, setStopCommand] = useState(
    stopModeOf(server) === "custom" ? (server.stopCommand ?? "") : "stop",
  );
  const [stopTimeout, setStopTimeout] = useState(server.stopTimeoutSecs ?? 30);
  const [watchdogEnabled, setWatchdogEnabled] = useState(server.watchdog?.enabled ?? false);
  const [watchdogAttempts, setWatchdogAttempts] = useState(server.watchdog?.maxAttempts ?? 5);
  const [features, setFeatures] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(INSTANCE_FEATURES.map((f) => [f.key, isFeatureEnabled(server, f.key)])),
  );
  const [busy, setBusy] = useState(false);

  // Re-sync the form when the selected instance changes (or a reload lands).
  useEffect(() => {
    setStopMode(stopModeOf(server));
    setStopCommand(stopModeOf(server) === "custom" ? (server.stopCommand ?? "") : "stop");
    setStopTimeout(server.stopTimeoutSecs ?? 30);
    setWatchdogEnabled(server.watchdog?.enabled ?? false);
    setWatchdogAttempts(server.watchdog?.maxAttempts ?? 5);
    setFeatures(
      Object.fromEntries(INSTANCE_FEATURES.map((f) => [f.key, isFeatureEnabled(server, f.key)])),
    );
  }, [server.id, server.stopCommand, server.stopTimeoutSecs, server.features, server.watchdog]);

  async function save() {
    setBusy(true);
    try {
      const resolvedStopCommand =
        stopMode === "none" ? "" : stopMode === "default" ? null : stopCommand.trim() || "stop";
      const updated: ServerInstance = {
        ...server,
        stopCommand: resolvedStopCommand,
        stopTimeoutSecs: Math.max(1, Math.floor(stopTimeout) || 30),
        features,
        watchdog: {
          enabled: watchdogEnabled,
          maxAttempts: Math.max(1, Math.floor(watchdogAttempts) || 5),
        },
      };
      await invoke("update_server", { server: updated });
      notify({ kind: "success", title: "Instance settings saved" });
      onSaved();
    } catch (e) {
      notify({ kind: "error", title: "Save failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl p-4 space-y-6">
        {/* Lifecycle / stop behaviour */}
        <section className="border border-grid-bounds">
          <div className="px-3 py-2 border-b border-grid-bounds">
            <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
              lifecycle
            </h3>
          </div>
          <div className="p-3 space-y-3">
            <label className="block text-[11px]">
              <span className="text-zinc-500 block mb-1">graceful stop behaviour</span>
              <select
                value={stopMode}
                onChange={(e) => setStopMode(e.target.value as StopMode)}
                className="w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-zinc-200"
              >
                <option value="default">default — send "stop" to the server console</option>
                <option value="custom">custom console command</option>
                <option value="none">none — skip the console, signal/kill directly</option>
              </select>
            </label>
            {stopMode === "custom" && (
              <label className="block text-[11px]">
                <span className="text-zinc-500 block mb-1">stop command</span>
                <input
                  value={stopCommand}
                  onChange={(e) => setStopCommand(e.target.value)}
                  placeholder="e.g. shutdown"
                  className="w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-zinc-200 font-mono"
                />
              </label>
            )}
            <label className="flex items-center justify-between text-[11px]">
              <span className="text-zinc-500">wait before force-kill (seconds)</span>
              <input
                type="number"
                min={1}
                value={stopTimeout}
                onChange={(e) => setStopTimeout(parseInt(e.target.value) || 30)}
                className="w-24 bg-bg-core border border-grid-bounds px-2 py-1 text-zinc-200"
              />
            </label>
            <p className="text-[10px] text-zinc-600">
              If the server doesn't exit within this window, the whole process tree
              is force-killed and the status becomes "stopped (forced)".
            </p>
          </div>
        </section>

        {/* Crash watchdog policy — only meaningful when the feature is shown. */}
        {features.watchdog && (
          <section className="border border-grid-bounds">
            <div className="px-3 py-2 border-b border-grid-bounds">
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
                crash watchdog
              </h3>
            </div>
            <div className="p-3 space-y-3">
              <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                <input
                  type="checkbox"
                  checked={watchdogEnabled}
                  onChange={(e) => setWatchdogEnabled(e.target.checked)}
                  className="accent-signal-high"
                />
                <span>restart automatically after an unexpected exit</span>
              </label>
              <label className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-500">max restart attempts</span>
                <input
                  type="number"
                  min={1}
                  value={watchdogAttempts}
                  onChange={(e) => setWatchdogAttempts(parseInt(e.target.value) || 5)}
                  className="w-24 bg-bg-core border border-grid-bounds px-2 py-1 text-zinc-200"
                />
              </label>
              <p className="text-[10px] text-zinc-600">
                Restarts back off exponentially (2s → 60s). A run longer than
                60s resets the counter, and a manual stop cancels it.
              </p>
            </div>
          </section>
        )}

        {/* Feature visibility */}
        <section className="border border-grid-bounds">
          <div className="px-3 py-2 border-b border-grid-bounds">
            <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
              features
            </h3>
          </div>
          <div className="p-3 divide-y divide-grid-bounds">
            {INSTANCE_FEATURES.map((feature) => (
              <label
                key={feature.key}
                className="flex items-start justify-between gap-4 py-2 cursor-pointer"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] text-zinc-200">{feature.label}</span>
                  <span className="block text-[10px] text-zinc-600">
                    {feature.description}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={features[feature.key] ?? feature.defaultVisible}
                  onChange={(e) =>
                    setFeatures((prev) => ({ ...prev, [feature.key]: e.target.checked }))
                  }
                  className="mt-0.5 accent-signal-high shrink-0"
                />
              </label>
            ))}
          </div>
        </section>

        {/* Read-only identity */}
        <section className="border border-grid-bounds">
          <div className="px-3 py-2 border-b border-grid-bounds">
            <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
              instance
            </h3>
          </div>
          <div className="p-3 space-y-1 text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">id</span>
              <span className="text-zinc-300 font-mono">{server.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">plugin</span>
              <span className="text-zinc-300 font-mono">{server.serverType}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-zinc-500 shrink-0">path</span>
              <span className="text-zinc-300 font-mono truncate" title={server.path}>
                {server.path}
              </span>
            </div>
          </div>
        </section>

        <button onClick={save} disabled={busy} className="btn-mono-primary">
          {busy ? "saving…" : "save settings"}
        </button>
      </div>
    </div>
  );
}
