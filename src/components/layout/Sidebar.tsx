import { useMemo, useState } from "react";
import type { ServerInstance } from "../../types/server";
import { statusColor, statusHex } from "../servers/status";
import { useSidebarItems } from "../../hooks/useSidebarItems";

interface SidebarProps {
  servers: ServerInstance[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRefresh: () => void;
  /** True when the plugins management view is active. */
  showPlugins: boolean;
  /** Navigate to the plugin management view. */
  onNavigatePlugins: () => void;
  /** True when the settings view is active. */
  showSettings: boolean;
  /** Navigate to the settings view. */
  onNavigateSettings: () => void;
  /** True when the fleet dashboard is active. */
  showFleet: boolean;
  /** Navigate to the fleet dashboard. */
  onNavigateFleet: () => void;
}

/**
 * Left navigation rail listing every tracked instance. Items use a status dot
 * on the emission-matrix color axis (green/amber/crimson/gray). The right edge
 * is a dotted matrix track rather than a solid divider (DesignGuide §6.1).
 */
export function Sidebar({
  servers,
  selectedId,
  loading,
  onSelect,
  onAdd,
  onRefresh,
  showPlugins,
  onNavigatePlugins,
  showSettings,
  onNavigateSettings,
  showFleet,
  onNavigateFleet,
}: SidebarProps) {
  const { items: pluginItems } = useSidebarItems();

  // Group folders: only rendered when at least one server declares a group, so
  // existing registries keep the flat list.
  const groups = useMemo(() => {
    const map = new Map<string, ServerInstance[]>();
    for (const server of servers) {
      const key = server.group?.trim() || "";
      const list = map.get(key);
      if (list) list.push(server);
      else map.set(key, [server]);
    }
    // Named groups alphabetically, ungrouped last.
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    });
  }, [servers]);

  const hasGroups = useMemo(
    () => servers.some((s) => (s.group ?? "").trim().length > 0),
    [servers],
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("kern.sidebar.collapsed.v1");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem("kern.sidebar.collapsed.v1", JSON.stringify([...next]));
      } catch {
        // Non-fatal.
      }
      return next;
    });
  }

  function renderServer(server: ServerInstance) {
    const isSelected = server.id === selectedId;
    const dot = statusHex(statusColor(server));
    return (
      <li key={server.id}>
        <button
          onClick={() => onSelect(server.id)}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left border-l-2 transition-colors ${
            isSelected
              ? "border-signal-high bg-bg-core"
              : "border-transparent hover:bg-bg-core"
          }`}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              backgroundColor: dot,
              boxShadow: `0 0 4px ${dot}`,
            }}
          />
          <span className="flex-1 min-w-0">
            <span className="block text-xs text-zinc-200 truncate">
              {server.name}
            </span>
            <span className="block text-[10px] text-zinc-600 truncate font-mono">
              {server.serverType}
            </span>
          </span>
          {server.isOrphaned && (
            <span className="text-[9px] text-fault-vector uppercase tracking-wider">
              orphan
            </span>
          )}
        </button>
      </li>
    );
  }

  return (
    <aside className="flex flex-col w-60 border-r border-grid-bounds matrix-border bg-bg-surface">
      <div className="flex items-center justify-between px-3 py-2 border-b border-grid-bounds">
        <span className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
          registry{" "}
          <span className="text-zinc-600 tabular-nums">({servers.length})</span>
        </span>
        <div className="flex gap-1">
          <button
            onClick={onRefresh}
            title="Re-check orphaned status"
            className="px-1.5 py-0.5 text-[11px] text-zinc-400 border border-grid-bounds hover:border-signal-low hover:text-zinc-200 transition-colors"
          >
            ↻
          </button>
          <button
            onClick={onAdd}
            className="px-2 py-0.5 text-[11px] text-bg-core bg-signal-high hover:opacity-80 transition-opacity font-semibold"
          >
            + new
          </button>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto">
        {loading && (
          <p className="px-3 py-2 text-[11px] text-zinc-600">loading registry…</p>
        )}
        {!loading && servers.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-zinc-600">
            no instances registered
          </p>
        )}
        <ul>
          {!hasGroups
            ? servers.map(renderServer)
            : groups.map(([name, list]) => {
                const label = name || "ungrouped";
                const isCollapsed = collapsed.has(name);
                return (
                  <li key={`group:${name}`}>
                    <button
                      onClick={() => toggleGroup(name)}
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors"
                      title={isCollapsed ? "expand group" : "collapse group"}
                    >
                      <span className="text-zinc-600">{isCollapsed ? "▸" : "▾"}</span>
                      <span className="flex-1 truncate">{label}</span>
                      <span className="text-zinc-600 tabular-nums">{list.length}</span>
                    </button>
                    {!isCollapsed && <ul>{list.map(renderServer)}</ul>}
                  </li>
                );
              })}
        </ul>
      </nav>

      {/* Plugin sidebar items */}
      {pluginItems.length > 0 && (
        <nav className="border-t border-grid-bounds">
          {pluginItems.map((item) => (
            <button
              key={item.id}
              onClick={() => item.onClick()}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left border-l-2 border-transparent hover:bg-bg-core hover:border-signal-low transition-colors"
            >
              {item.icon && (
                <span className="text-[11px] text-zinc-500">{item.icon}</span>
              )}
              <span className="flex-1 text-xs text-zinc-400">{item.label}</span>
            </button>
          ))}
        </nav>
      )}

      {/* Bottom navigation */}
      <nav className="border-t border-grid-bounds">
        <button
          onClick={onNavigateFleet}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left border-l-2 transition-colors ${
            showFleet
              ? "border-signal-high bg-bg-core"
              : "border-transparent hover:bg-bg-core"
          }`}
        >
          <span className="text-[11px] text-zinc-500">⊞</span>
          <span className="flex-1 text-xs text-zinc-400">fleet</span>
          <span className="text-[9px] text-zinc-600 uppercase tracking-wider">
            dashboard
          </span>
        </button>
        <button
          onClick={onNavigatePlugins}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left border-l-2 transition-colors ${
            showPlugins
              ? "border-signal-high bg-bg-core"
              : "border-transparent hover:bg-bg-core"
          }`}
        >
          <span className="text-[11px] text-zinc-500">◆</span>
          <span className="flex-1 text-xs text-zinc-400">plugins</span>
          <span className="text-[9px] text-zinc-600 uppercase tracking-wider">
            manage
          </span>
        </button>
        <button
          onClick={onNavigateSettings}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left border-l-2 transition-colors ${
            showSettings
              ? "border-signal-high bg-bg-core"
              : "border-transparent hover:bg-bg-core"
          }`}
        >
          <span className="text-[11px] text-zinc-500">⚙</span>
          <span className="flex-1 text-xs text-zinc-400">settings</span>
        </button>
      </nav>
    </aside>
  );
}
