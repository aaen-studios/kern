/**
 * Typed catalog of host events plugins may subscribe to via
 * `hostAPI.listen(name, handler)`.
 *
 * Event names are string-built from the instance id, so use the helpers rather
 * than hand-writing the template.
 */

export const PLUGIN_EVENTS = {
  /** Lifecycle transitions for the instance. */
  serverStatus: (id: string) => `status:${id}`,
  /** One line of process stdout/stderr (already timestamped). */
  serverLog: (id: string) => `log:${id}:stream`,
  /** Byte progress for `download_url` / `download_java` (`progressId` arg). */
  downloadProgress: (progressId: string) => `download:${progressId}:progress`,
  /** CPU/RAM threshold crossed (every instance). */
  healthAlert: "kern://health-alert",
  /** A scheduled/manual world backup finished. */
  backupCompleted: "kern://backup-completed",
  /** Notification-center events (watchdog, schedules, …). */
  notification: "kern://notification",
  /** A watched instance directory changed. */
  fsChanged: "server://fs-changed",
  /** The set of running instances changed. */
  runningSetChanged: "kern://running-set-changed",
} as const;

export interface ServerStatusEvent {
  state: "running" | "stopping" | "exited";
  code?: number | null;
  forced?: boolean;
}

export interface DownloadProgressEvent {
  bytes: number;
  total: number;
}

export interface HealthAlertEvent {
  id: string;
  name: string;
  metric: "cpu" | "ram";
  value: number;
  threshold: number;
}

export interface BackupCompletedEvent {
  id: string;
  at: number;
}

export interface FsChangedEvent {
  path: string;
}

export interface NotificationEvent {
  kind: "info" | "success" | "warn" | "error";
  title: string;
  message?: string;
  serverId?: string;
  at: number;
}
