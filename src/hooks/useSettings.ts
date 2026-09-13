/**
 * Global app-settings persistence — load + save the `AppSettings` block of
 * config.json, and keep the OS-login autostart registration in sync.
 *
 * Mirrors the established Rust-owned-JSON pattern (see `useServers` /
 * `useUiState`): reads via `get_config().settings`, writes via the
 * `update_app_settings` command. The "launch on login" toggle additionally
 * calls `enable_autostart` / `disable_autostart` so the OS entry and the
 * persisted flag never drift apart.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types/server";

interface UseSettingsResult {
  settings: AppSettings | null;
  loading: boolean;
  error: string | null;
  /** Persist a partial settings update (merges with current values). */
  update: (partial: Partial<AppSettings>) => Promise<void>;
  /** Toggle OS-login autostart; keeps the OS entry + flag in sync. */
  setLaunchOnLogin: (enabled: boolean) => Promise<void>;
  reload: () => Promise<void>;
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultSandboxPath: "",
  launchOnLogin: false,
  closeToTray: true,
  startHiddenInTray: false,
  trayRadar: true,
  powerPricePerKwh: 0,
  machineWatts: 120,
  registryUrl: "https://kern.aaenz.no",
  webRemoteEnabled: false,
  webRemotePort: 7440,
  cfTunnelEnabled: false,
  cfTunnelUrl: "",
  webRemotePassphrase: "",
  syncRepoUrl: "",
  nativeNotifications: true,
  webhookUrl: "",
  webhookEnabled: false,
  logAlerts: [],
  automationEnabled: true,
  automationPort: 7442,
};

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await invoke<{ settings: AppSettings }>("get_config");
      setSettings({ ...DEFAULT_SETTINGS, ...cfg.settings });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(
    async (partial: Partial<AppSettings>) => {
      if (!settings) return;
      const previous = settings;
      const next: AppSettings = { ...settings, ...partial };
      // Optimistically update so the toggle feels instant.
      setSettings(next);
      try {
        await invoke("update_app_settings", { settings: next });
        setError(null);
      } catch (e) {
        // Roll back so the UI never displays a value that didn't persist.
        setSettings(previous);
        setError(String(e));
      }
    },
    [settings],
  );

  const setLaunchOnLogin = useCallback(
    async (enabled: boolean) => {
      // Register/deregister with the OS first so a failure there doesn't
      // leave a stale persisted flag.
      if (enabled) {
        await invoke("enable_autostart");
      } else {
        await invoke("disable_autostart");
      }
      await update({ launchOnLogin: enabled });
    },
    [update],
  );

  return {
    settings,
    loading,
    error,
    update,
    setLaunchOnLogin,
    reload,
  };
}
