/**
 * Ctrl+K command palette.
 *
 * One keyboard entry point for navigation, server lifecycle actions, and
 * app-level commands. Opened with Ctrl/Cmd+K, filtered as you type, driven
 * with arrow keys + Enter. Lifecycle commands invoke the same backend
 * commands the UI buttons use, so behaviour stays identical.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerInstance } from "../../types/server";
import { useToast } from "../../hooks/useToast";

interface CommandPaletteProps {
  servers: ServerInstance[];
  onSelectServer: (id: string) => void;
  onNavigate: (kind: "list" | "create" | "plugins" | "settings" | "fleet") => void;
  /** Called after lifecycle commands so the registry reloads. */
  onRegistryChanged: () => void;
}

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({
  servers,
  onSelectServer,
  onNavigate,
  onRegistryChanged,
}: CommandPaletteProps) {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  // Global hotkey: Ctrl/Cmd+K toggles the palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActiveIndex(0);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const runLifecycle = useCallback(
    async (id: string, name: string, action: "start" | "stop" | "restart") => {
      close();
      try {
        const command =
          action === "start"
            ? "launch_server_instance"
            : action === "stop"
              ? "stop_server_instance"
              : "restart_server_instance";
        await invoke(command, { id });
        notify({ kind: "success", title: `${name}: ${action} requested` });
      } catch (e) {
        notify({
          kind: "error",
          title: `${name}: ${action} failed`,
          message: String(e),
        });
      }
      onRegistryChanged();
    },
    [close, notify, onRegistryChanged],
  );

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: "nav-list",
        label: "Go to servers",
        group: "navigate",
        run: () => {
          close();
          onNavigate("list");
        },
      },
      {
        id: "nav-create",
        label: "Add a server",
        group: "navigate",
        keywords: "new create instance",
        run: () => {
          close();
          onNavigate("create");
        },
      },
      {
        id: "nav-plugins",
        label: "Go to plugins",
        group: "navigate",
        keywords: "marketplace install",
        run: () => {
          close();
          onNavigate("plugins");
        },
      },
      {
        id: "nav-fleet",
        label: "Go to fleet dashboard",
        group: "navigate",
        keywords: "all status metrics overview",
        run: () => {
          close();
          onNavigate("fleet");
        },
      },
      {
        id: "nav-settings",
        label: "Go to settings",
        group: "navigate",
        run: () => {
          close();
          onNavigate("settings");
        },
      },
    ];

    for (const server of servers) {
      const running = server.status === "running" || server.status === "stopping";
      items.push({
        id: `open:${server.id}`,
        label: `Open ${server.name}`,
        hint: server.serverType,
        group: "servers",
        keywords: `jump show ${server.path}`,
        run: () => {
          close();
          onSelectServer(server.id);
        },
      });
      if (running) {
        items.push(
          {
            id: `restart:${server.id}`,
            label: `Restart ${server.name}`,
            group: "lifecycle",
            run: () => void runLifecycle(server.id, server.name, "restart"),
          },
          {
            id: `stop:${server.id}`,
            label: `Stop ${server.name}`,
            group: "lifecycle",
            run: () => void runLifecycle(server.id, server.name, "stop"),
          },
        );
      } else if (!server.isOrphaned) {
        items.push({
          id: `start:${server.id}`,
          label: `Start ${server.name}`,
          group: "lifecycle",
          run: () => void runLifecycle(server.id, server.name, "start"),
        });
      }
    }

    return items;
  }, [servers, close, onNavigate, onSelectServer, runLifecycle]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Keep the active index in range as the result set shrinks.
  useEffect(() => {
    setActiveIndex((i) => (i >= filtered.length ? 0 : i));
  }, [filtered.length]);

  const runActive = useCallback(() => {
    const item = filtered[activeIndex];
    if (item) void item.run();
  }, [filtered, activeIndex]);

  if (!open) return null;

  // Group headers interleaved in render order.
  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]"
      onClick={close}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative z-10 w-full max-w-lg border border-grid-bounds bg-bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              runActive();
            }
          }}
          placeholder="type a command… (start, stop, open, settings)"
          className="w-full bg-transparent border-b border-grid-bounds px-3 py-3 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 outline-none"
          spellCheck={false}
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-3 py-3 text-[11px] text-zinc-600">no matching commands</p>
          )}
          {filtered.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && (
                  <p className="px-3 pt-2 pb-1 text-[9px] tracking-[0.2em] uppercase text-zinc-600">
                    {header}
                  </p>
                )}
                <button
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void item.run()}
                  className={`w-full text-left px-3 py-1.5 text-[11px] flex items-center justify-between gap-3 transition-colors ${
                    index === activeIndex
                      ? "bg-bg-core text-signal-high"
                      : "text-zinc-300 hover:bg-bg-core"
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                  {item.hint && (
                    <span className="text-[10px] text-zinc-600 shrink-0">{item.hint}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="px-3 py-1.5 border-t border-grid-bounds text-[9px] text-zinc-600 flex gap-3">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
