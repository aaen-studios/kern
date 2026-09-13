/** Browser notifications for instance faults (opt-in, per device). */

const KEY = "kern.notify";

export function notificationsEnabled(): boolean {
  return (
    localStorage.getItem(KEY) === "on" &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  );
}

/** Requests permission and remembers the choice. Returns true when enabled. */
export async function enableNotifications(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  const permission = await Notification.requestPermission();
  const granted = permission === "granted";
  localStorage.setItem(KEY, granted ? "on" : "off");
  return granted;
}

export function disableNotifications(): void {
  localStorage.setItem(KEY, "off");
}

/** Fires a fault notification (no-op when not enabled/granted). */
export function notifyFault(serverName: string, status: string): void {
  if (!notificationsEnabled()) return;
  try {
    new Notification(`${serverName} — ${status}`, {
      tag: `kern-${serverName}`,
      body: "open kern remote to take a look.",
    });
  } catch {
    /* notification construction is best-effort */
  }
}
