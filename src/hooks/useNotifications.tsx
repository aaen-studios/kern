/**
 * Persistent notification center.
 *
 * The toast channel (`useToast`) is ephemeral by design; this hook keeps a
 * bounded, localStorage-backed history of everything the app surfaced
 * (crashes, watchdog restarts, health alerts, backups, schedules, plugin
 * events) so a user who was away can catch up, jump to the affected server,
 * and clear the list.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  maybeSendNative,
  setNativeNotificationsEnabled,
} from "../lib/nativeNotifications";

export type NotificationKind = "error" | "warn" | "success" | "info";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message?: string;
  /** Instance this notification relates to, when known. */
  serverId?: string;
  /** Epoch milliseconds. */
  at: number;
  read: boolean;
}

const STORAGE_KEY = "kern.notifications.v1";
const MAX_ENTRIES = 200;

interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  push: (n: {
    kind: NotificationKind;
    title: string;
    message?: string;
    serverId?: string;
    /** Epoch seconds (backend events) — converted to ms. */
    atSeconds?: number;
  }) => void;
  markAllRead: () => void;
  clear: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

function loadPersisted(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is AppNotification =>
        n && typeof n.id === "string" && typeof n.title === "string",
    );
  } catch {
    return [];
  }
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>(loadPersisted);

  // Keep native-toast mirroring in sync with the persisted setting.
  useEffect(() => {
    void invoke<{ settings?: { nativeNotifications?: boolean } }>("get_config")
      .then((cfg) =>
        setNativeNotificationsEnabled(cfg.settings?.nativeNotifications !== false),
      )
      .catch(() => {
        // Default (on) is fine when config isn't readable.
      });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(notifications.slice(0, MAX_ENTRIES)),
      );
    } catch {
      // Storage full/unavailable — history is a convenience, not critical.
    }
  }, [notifications]);

  const push = useCallback<NotificationContextValue["push"]>((n) => {
    const at = n.atSeconds ? n.atSeconds * 1000 : Date.now();
    const id = `${at}-${Math.random().toString(36).slice(2, 8)}`;
    // Mirror to a native OS toast when the window is hidden (best-effort).
    void maybeSendNative(n.title, n.message);
    setNotifications((prev) =>
      [
        {
          id,
          at,
          read: false,
          kind: n.kind,
          title: n.title,
          message: n.message,
          serverId: n.serverId,
        },
        ...prev,
      ].slice(0, MAX_ENTRIES),
    );
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
  }, []);

  const clear = useCallback(() => setNotifications([]), []);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const value = useMemo(
    () => ({ notifications, unreadCount, push, markAllRead, clear }),
    [notifications, unreadCount, push, markAllRead, clear],
  );

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return ctx;
}
