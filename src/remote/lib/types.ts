/** Shapes returned by the automation API / remote endpoints. */

export type Role = "admin" | "operator" | "viewer";

export interface AuthUser {
  userId: string;
  name: string;
  role: Role;
  /** null = every server; otherwise ids (or "*"). */
  servers: string[] | null;
  via: string;
  device?: string | null;
}

export interface ServerSummary {
  id: string;
  name: string;
  type: string;
  group?: string | null;
  tags: string[];
  status: string;
  running: boolean;
  adopted: boolean;
  orphaned: boolean;
  autoStart: boolean;
  pid?: number | null;
  uptimeSecs?: number | null;
  metrics?: { cpu: number; ram: number } | null;
  ports?: unknown;
}

export interface HostStatus {
  status: string;
  version: string;
  apiVersion: number;
  pid: number;
  host: { cpu: number; ram: number };
}

export interface AuditEntry {
  at: number;
  action: string;
  detail: string;
  server_id?: string;
}

export interface MetricSample {
  at: number;
  cpu: number;
  ram: number;
}

export interface Task {
  id: string;
  name?: string;
  enabled?: boolean;
  action?: string;
  command?: string;
  intervalSecs?: number;
  dailyAt?: string;
  cron?: string;
  announceMinutes?: number[];
}

export interface Backup {
  name: string;
  size: number;
  created?: number;
}

export interface BackupSchedule {
  intervalSecs: number;
  keep: number;
  onStop: boolean;
  lastBackupSecs: number;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface SnapshotInfo {
  id: string;
  at: number;
  size: number;
}

export interface SearchMatch {
  relPath: string;
  lineNumber?: number | null;
  linePreview?: string | null;
}

export interface CrashInfo {
  at: number;
  exitCode?: number | null;
  forced?: boolean;
  tail?: string[];
}

export interface TunnelInfo {
  enabled: boolean;
  running: boolean;
  url: string | null;
  error: string | null;
  binaryFound: boolean;
  binary?: string | null;
  managed?: boolean;
  mode: string;
  hostname?: string | null;
  namedTokenSet?: boolean;
}

export interface RemoteStatus {
  version: string;
  tunnel: TunnelInfo;
  registryUrl?: string;
  bind: string;
  port: number;
  bindError: string | null;
  urls: string[];
}

export interface Invite {
  code: string;
  name: string;
  role: Role;
  servers: string[] | null;
  createdAt: number;
  expiresAt: number;
  usedAt?: number | null;
}

export interface InviteView extends Invite {
  expired: boolean;
}

export interface DeviceView {
  id: string;
  userId: string;
  userName: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt?: number | null;
}

export interface UserView {
  id: string;
  name: string;
  role: Role;
  servers: string[] | null;
  createdAt: number;
  deviceCount: number;
}

export interface People {
  users: UserView[];
  devices: DeviceView[];
  invites: InviteView[];
}

export interface PluginManifest {
  id: string;
  displayName?: string;
  version?: string;
  author?: string;
  description?: string;
  configSchema?: ConfigField[];
  [key: string]: unknown;
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "select" | string;
  default?: string;
  options?: string[];
}

export interface RegistryPlugin {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  category?: string;
  tags?: string[];
  upvotes?: number;
  installCount?: number;
  versions?: { version: string; kernCompat?: string; sha256?: string; sizeBytes?: number; changelog?: string }[];
}
