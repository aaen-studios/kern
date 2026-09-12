import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { NotificationBell } from "./NotificationBell";

interface TitleBarProps {
  /** Navigate to the home / server-list view. */
  onHome?: () => void;
  /** Open a server from a notification. */
  onOpenServer?: (id: string) => void;
}

/**
 * Custom frameless title bar.
 *
 * Pattern adapted from the galdr app: `decorations: false` on the window +
 * `data-tauri-drag-region` for native dragging, with three window-control
 * buttons driving `getCurrentWindow()`. The whole bar is `user-select:none`
 * so dragging never selects text.
 */
export function TitleBar({ onHome, onOpenServer }: TitleBarProps) {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  // Keep the maximize glyph in sync with the actual window state.
  useEffect(() => {
    let active = true;
    win.isMaximized().then((m) => active && setMaximized(m)).catch(() => {});
    const unlistenP = listen<{ width: number; height: number }>(
      "tauri://resize",
      () => win.isMaximized().then((m) => active && setMaximized(m)).catch(() => {}),
    );
    return () => {
      active = false;
      void unlistenP.then((fn) => fn());
    };
  }, [win]);

  return (
    <header
      data-tauri-drag-region
      className="relative flex items-center justify-center h-9 bg-bg-surface border-b border-grid-bounds select-none shrink-0"
    >
      {/* Home button — top-left */}
      <button
        aria-label="home"
        title="Home"
        onClick={onHome}
        className="absolute left-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 text-zinc-500 hover:text-zinc-100 transition-colors rounded hover:bg-grid-bounds"
      >
        <svg
          viewBox="0 0 14 14"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1.5 6L7 1.5 12.5 6" />
          <path d="M3 7v4.5h2.5V9h3v2.5H11V7" />
        </svg>
      </button>

      <div className="flex items-center gap-2 pointer-events-none">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-signal-high shadow-[0_0_4px_#4cf5a0]" />
        <span className="text-[11px] tracking-[0.25em] uppercase text-zinc-300">
          kern
        </span>
      </div>

      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center">
        <NotificationBell onOpenServer={onOpenServer} />
        <ControlButton
          label="minimize"
          onClick={() => void win.minimize()}
          glyph={<span className="block w-2.5 border-t border-current" />}
        />
        <ControlButton
          label={maximized ? "restore" : "maximize"}
          onClick={() => void win.toggleMaximize()}
          glyph={
            maximized ? (
              // restore: overlapping squares
              <span className="relative block w-2.5 h-2.5">
                <span className="absolute inset-0 border border-current" />
                <span className="absolute -top-px -left-px w-2 h-2 border-t border-l border-current" />
              </span>
            ) : (
              <span className="block w-2.5 h-2.5 border border-current" />
            )
          }
        />
        <ControlButton
          label="close"
          variant="close"
          onClick={() => void win.close()}
          glyph={
            <span className="block text-[13px] leading-none -mt-px">×</span>
          }
        />
      </div>
    </header>
  );
}

interface ControlButtonProps {
  label: string;
  glyph: React.ReactNode;
  onClick: () => void;
  variant?: "default" | "close";
}

function ControlButton({ label, glyph, onClick, variant = "default" }: ControlButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex items-center justify-center w-11 h-7 text-zinc-500 hover:text-zinc-100 transition-colors ${
        variant === "close"
          ? "hover:bg-fault-vector"
          : "hover:bg-grid-bounds"
      }`}
    >
      {glyph}
    </button>
  );
}
