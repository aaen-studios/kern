/**
 * Title-bar notification bell — opens the persistent notification history
 * (crashes, watchdog restarts, health alerts, backups, schedules, plugin
 * events) with jump-to-server links.
 */

import { useEffect, useRef, useState } from "react";
import { useNotifications, type NotificationKind } from "../../hooks/useNotifications";

const KIND_COLOR: Record<NotificationKind, string> = {
  error: "var(--color-fault-vector, #f54c4c)",
  warn: "var(--color-warn-vector, #f5a04c)",
  success: "var(--color-signal-high, #4cf5a0)",
  info: "var(--color-signal-low, #4c525e)",
};

function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NotificationBell({
  onOpenServer,
}: {
  onOpenServer?: (id: string) => void;
}) {
  const { notifications, unreadCount, markAllRead, clear } = useNotifications();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        aria-label="notifications"
        title="Notifications"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) markAllRead();
        }}
        className="relative flex items-center justify-center w-8 h-7 text-zinc-500 hover:text-zinc-100 transition-colors hover:bg-grid-bounds"
      >
        <svg
          viewBox="0 0 14 14"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7 1.5a3.5 3.5 0 0 0-3.5 3.5v2.2L2.5 9.5h9L10.5 7.2V5A3.5 3.5 0 0 0 7 1.5Z" />
          <path d="M5.7 11.2a1.4 1.4 0 0 0 2.6 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[13px] h-[13px] px-0.5 flex items-center justify-center rounded-full bg-fault-vector text-bg-core text-[9px] leading-none font-semibold">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 max-h-[420px] flex flex-col bg-bg-core border border-grid-bounds shadow-xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-grid-bounds">
            <span className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
              notifications
            </span>
            {notifications.length > 0 && (
              <button
                onClick={clear}
                className="text-[10px] text-zinc-500 hover:text-zinc-200"
              >
                clear all
              </button>
            )}
          </div>
          <div className="overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-3 py-4 text-[11px] text-zinc-600">
                nothing yet — crashes, alerts, and backups show up here.
              </p>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className="px-3 py-2 border-b border-grid-bounds last:border-0"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: KIND_COLOR[n.kind] }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[11px] text-zinc-200 truncate">
                          {n.title}
                        </span>
                        <span className="text-[9px] text-zinc-600 shrink-0">
                          {relativeTime(n.at)}
                        </span>
                      </div>
                      {n.message && (
                        <p className="text-[10px] text-zinc-500 mt-0.5 break-words">
                          {n.message}
                        </p>
                      )}
                      {n.serverId && onOpenServer && (
                        <button
                          onClick={() => {
                            onOpenServer(n.serverId!);
                            setOpen(false);
                          }}
                          className="mt-1 text-[10px] text-signal-high hover:underline"
                        >
                          open server →
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
