/** Small shared formatting helpers (mirrors the desktop's conventions). */

export function fmtBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** i;
  return `${i === 0 || scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[i]}`;
}

export function fmtUptime(secs?: number | null): string {
  if (secs == null) return "—";
  const day = 86400;
  const hour = 3600;
  const minute = 60;
  const d = Math.floor(secs / day);
  const h = Math.floor((secs % day) / hour);
  const m = Math.floor((secs % hour) / minute);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${secs}s`;
}

export function fmtAgo(unixSecs?: number | null): string {
  if (!unixSecs) return "—";
  const diff = Math.max(0, Date.now() / 1000 - unixSecs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function fmtTime(unixSecs?: number | null): string {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleString();
}

export function fmtIn(unixSecs?: number | null): string {
  if (!unixSecs) return "—";
  const diff = Math.max(0, unixSecs - Date.now() / 1000);
  if (diff < 60) return `${Math.ceil(diff)}s`;
  if (diff < 3600) return `${Math.ceil(diff / 60)}m`;
  return `${Math.ceil(diff / 3600)}h`;
}

export function statusTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (status === "running") return "ok";
  if (["error", "stopped-forced", "crashed"].includes(status)) return "bad";
  if (["starting", "stopping", "installing"].includes(status)) return "warn";
  return "idle";
}

export function statusDotClass(status: string): string {
  const tone = statusTone(status);
  if (tone === "ok") return "bg-signal-high shadow-[0_0_6px] shadow-signal-high";
  if (tone === "warn") return "bg-warn-vector";
  if (tone === "bad") return "bg-fault-vector";
  return "bg-signal-low";
}
