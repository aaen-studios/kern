/**
 * Native OS notifications.
 *
 * Every push to the in-app notification center is mirrored to a native toast
 * when the window isn't focused (and the user hasn't muted them in Settings).
 * The plugin is imported lazily so it costs nothing on startup, and every call
 * is best-effort — a denied permission must never surface as an app error.
 */

let enabled = true;

/** Wired from Settings; defaults to on until the config loads. */
export function setNativeNotificationsEnabled(value: boolean) {
  enabled = value;
}

/**
 * Sends a native notification if (a) the user allows them and (b) the window
 * is hidden/backgrounded — the in-app toast covers the focused case.
 */
export async function maybeSendNative(title: string, body?: string): Promise<void> {
  if (!enabled) return;
  if (typeof document === "undefined") return;
  // `document.hidden` is true when the window is minimized or on another
  // monitor's hidden state; visible windows already show the toast.
  if (!document.hidden) return;
  try {
    const plugin = await import("@tauri-apps/plugin-notification");
    let granted = await plugin.isPermissionGranted();
    if (!granted) {
      granted = (await plugin.requestPermission()) === "granted";
    }
    if (granted) {
      plugin.sendNotification({ title, body: body ?? "" });
    }
  } catch {
    // Best-effort: unsupported platform or denied permission.
  }
}
