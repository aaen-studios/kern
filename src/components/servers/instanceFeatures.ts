/**
 * Per-instance optional-feature catalogue.
 *
 * Everything beyond the core surface (terminal, files, start/stop) is opt-in
 * and hidden by default. The per-instance settings panel toggles entries here;
 * the chosen values persist in `ServerInstance.features` (config.json), so
 * "add as much as you want, hide most by default" stays manageable.
 */

import type { ServerInstance } from "../../types/server";

export interface InstanceFeature {
  /** Stable key stored in `ServerInstance.features`. */
  key: string;
  /** Label shown in the settings panel. */
  label: string;
  /** One-line explanation shown under the label. */
  description: string;
  /** Visible when the user has never toggled it. */
  defaultVisible: boolean;
}

export const INSTANCE_FEATURES: InstanceFeature[] = [
  {
    key: "ports",
    label: "Ports & quick-connect",
    description: "Detect listening TCP ports for the running process tree.",
    defaultVisible: true,
  },
  {
    key: "find-replace",
    label: "Find & replace across files",
    description: "Bulk-edit text files under the instance directory.",
    defaultVisible: false,
  },
  {
    key: "metrics-history",
    label: "Resource history",
    description: "CPU/RAM sparkline over the last 24h / 7d.",
    defaultVisible: false,
  },
  {
    key: "energy",
    label: "Energy & cost",
    description: "Running-time energy estimate using your kWh price.",
    defaultVisible: false,
  },
  {
    key: "backups",
    label: "World backups",
    description: "Scheduled snapshots, restore, and retention.",
    defaultVisible: false,
  },
  {
    key: "alerts",
    label: "Health alerts",
    description: "Toast alerts when CPU/RAM stay above thresholds.",
    defaultVisible: false,
  },
  {
    key: "env",
    label: "Environment editor",
    description: "Edit the instance's .env variables from the UI.",
    defaultVisible: false,
  },
  {
    key: "history",
    label: "Command history panel",
    description: "Browse, search, and clear past terminal commands.",
    defaultVisible: false,
  },
  {
    key: "snapshots",
    label: "File snapshots",
    description: "Version files and roll back changes.",
    defaultVisible: false,
  },
  {
    key: "schedules",
    label: "Scheduled tasks",
    description: "Timed restarts, commands, and health checks.",
    defaultVisible: false,
  },
  {
    key: "watchdog",
    label: "Crash watchdog",
    description: "Auto-restart with backoff after an unexpected exit.",
    defaultVisible: false,
  },
  {
    key: "rcon",
    label: "RCON / query",
    description: "Remote console, player list, and server status.",
    defaultVisible: false,
  },
];

const DEFAULT_BY_KEY = new Map(INSTANCE_FEATURES.map((f) => [f.key, f.defaultVisible]));

/** True when a feature should render for this instance. */
export function isFeatureEnabled(server: ServerInstance, key: string): boolean {
  const explicit = server.features?.[key];
  if (explicit !== undefined) return explicit;
  return DEFAULT_BY_KEY.get(key) ?? false;
}

/** Applies a toggle to the features map, returning a new object. */
export function setFeature(
  server: ServerInstance,
  key: string,
  enabled: boolean,
): Record<string, boolean> {
  return { ...(server.features ?? {}), [key]: enabled };
}
