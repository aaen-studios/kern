/**
 * Server instance + global config types.
 * Spec: documentation/ArchitecturePlan.md §2 (Core Registry Schema).
 * Mirrors the Rust structs in src-tauri/src/config.rs (camelCase on the wire).
 */

/** Lifecycle of a tracked server instance. */
export type ServerStatus =
  | "stopped"
  | "stopped-forced"
  | "starting"
  | "running"
  | "stopping"
  | "installing"
  | "error";

/**
 * Fields an instance can be sorted by. Mirrors `ServerInstance`:
 *   name → human-readable label
 *   serverType → plugin id backing the instance (e.g. "web_server")
 *   status → lifecycle state (running, stopped, error…)
 *   path → absolute filesystem path to the working directory
 */
export type SortKey = "name" | "serverType" | "status" | "path";

/** A complete sort preference: which field, and which direction. */
export interface SortPref {
  key: SortKey;
  direction: "asc" | "desc";
}

/** A tracked server instance in config.json. */
export interface ServerInstance {
  /** Stable identifier, e.g. "srv_9f82b1a0". */
  id: string;
  /** Human-readable label. */
  name: string;
  /** Plugin id backing this instance, e.g. "web_server". */
  serverType: string;
  /** Absolute filesystem path to the instance working directory. */
  path: string;
  /** Last known runtime status. */
  status: ServerStatus;
  /** True when the instance path is no longer accessible on disk. */
  isOrphaned: boolean;
  /** User-selected configuration values surfaced by the plugin's configSchema. */
  userOverrides: Record<string, string>;
  /** When true, the instance launches automatically as kern starts. */
  autoStart: boolean;
  /** Last-known OS pid of a running process (for re-adoption after restart). */
  pid?: number | null;
  /** OS start time of `pid` (epoch seconds), used to verify identity on re-adopt. */
  pidStarted?: number | null;
  /** Optional stdin command for graceful shutdown (empty = skip stdin). */
  stopCommand?: string | null;
  /** Seconds to wait for graceful shutdown before a forced tree-kill (default 30). */
  stopTimeoutSecs?: number;
  /** Per-instance optional-feature visibility (see instanceFeatures.ts). */
  features?: Record<string, boolean>;
  /** Crash watchdog policy. */
  watchdog?: { enabled: boolean; maxAttempts: number };
  /** User-defined scheduled tasks. */
  tasks?: ScheduledTask[];
  /** Optional sidebar group (folder). */
  group?: string | null;
  /** Filter labels. */
  tags?: string[];
  /** RCON connection settings (host/port; the password lives in the OS keyring). */
  rcon?: { host: string; port: number };
  /** Scheduled world backups. */
  backupSchedule?: BackupSchedule;
  /** Health-alert thresholds. */
  alertRules?: AlertRules;
  /** Shared terminal command history (newest last). */
  commandHistory?: string[];
  /** Pinned one-click command snippets. */
  commandSnippets?: string[];
  /** Ports last observed listening (drives the pre-start conflict check). */
  lastPorts?: number[];
}

/** A port the instance uses that another process currently holds. */
export interface PortConflict {
  port: number;
  pid: number;
  process: string;
}

/** Read-only findings from `preflight_launch`, shown before a start. */
export interface PreflightReport {
  conflicts: PortConflict[];
  /** `eula.txt` exists and still says `eula=false`. */
  eulaPending: boolean;
  /** Free space below the warning floor. */
  lowDisk: boolean;
  freeMb?: number | null;
}

/** A user-defined scheduled task (mirrors config::ScheduledTask). */
export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  /** "restart" | "start" | "stop" | "command" | "backup" | "health" */
  action: string;
  /** Command text for `command`, or the policy for `health`. */
  command: string;
  /** Every N seconds (0 = unused). */
  intervalSecs: number;
  /** Local "HH:MM" daily run (empty = unused). */
  dailyAt: string;
  /** 5-field cron expression (empty = unused). */
  cron: string;
  /** For restart tasks: minutes-before announcements via stdin (e.g. [5, 1]). */
  announceMinutes?: number[];
  /** Host-managed dedupe keys for announcements. */
  announceSent?: string[];
  /** Host-managed last-run timestamp (epoch seconds). */
  lastRunSecs: number;
}

/** Per-instance backup schedule (mirrors config::BackupSchedule). */
export interface BackupSchedule {  intervalSecs: number;
  keep: number;
  onStop: boolean;
  lastBackupSecs: number;
}

/** Per-instance health-alert thresholds (mirrors config::AlertRules). */
export interface AlertRules {
  cpuThreshold?: number | null;
  ramThreshold?: number | null;
  sustainedSecs: number;
  crossedSinceSecs?: number;
}

/** Global application settings. */
export interface AppSettings {
  /** Default sandbox path used when no custom location is chosen. */
  defaultSandboxPath: string;
  /** Launch kern automatically when the user signs in to the OS. */
  launchOnLogin: boolean;
  /** When true, closing the window hides to tray instead of quitting. */
  closeToTray: boolean;
  /** When launched by the OS at login, start hidden in the tray. */
  startHiddenInTray: boolean;
  /** Local electricity price per kWh. Drives the cost meter. 0 = disabled. */
  powerPricePerKwh?: number;
  /** Average machine power draw in watts (user-tuned to their hardware). */
  machineWatts?: number;
  /** Base URL of the plugin registry. */
  registryUrl?: string;
  /** Enable the optional web remote (HTTPS + token, LAN control panel). */
  webRemoteEnabled?: boolean;
  /** HTTPS port for the web remote (default 7440). */
  webRemotePort?: number;
  /** Passphrase required to access the web remote (empty = open on LAN). */
  webRemotePassphrase?: string;
  /** Git repo URL for optional multi-machine registry sync. Empty = disabled. */
  syncRepoUrl?: string;
  /** Mirror notifications to native OS toasts when the window isn't focused. */
  nativeNotifications?: boolean;
  /** Outbound webhook URL (Discord/Slack/generic JSON). Empty = disabled. */
  webhookUrl?: string;
  /** Master switch for webhook delivery. */
  webhookEnabled?: boolean;
  /** User-defined log-pattern alert rules (regex over streamed log lines). */
  logAlerts?: LogAlertRule[];
  /** Loopback automation API for scripts and kern-cli. */
  automationEnabled?: boolean;
  /** Port for the loopback automation API (default 7442). */
  automationPort?: number;
}

/** One user-defined log-pattern alert rule (mirrors config::LogAlertRule). */
export interface LogAlertRule {
  id: string;
  name: string;
  /** Rust regex syntax, matched per log line. */
  pattern: string;
  enabled: boolean;
}

/** Root config.json document. */
export interface AppConfig {
  version: string;
  settings: AppSettings;
  servers: Record<string, ServerInstance>;
}

/** Payload accepted by the create_server command. */
export type NewServerInput = Omit<ServerInstance, "id" | "status" | "isOrphaned"> & {
  /** Optional explicit id; generated server-side when omitted. */
  id?: string;
  /** True when adopting an existing folder: skips plugin scaffolding. */
  imported?: boolean;
};
