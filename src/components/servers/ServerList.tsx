import type { ServerInstance, SortPref } from "../../types/server";
import { ServerCard } from "./ServerCard";
import { MatrixViewport } from "../matrix/MatrixViewport";
import { polarRadarShader } from "../matrix/shaders/polarRadar";
import { useHostMetrics } from "../../hooks/useMetrics";
import type { DotColor } from "../../types/matrix";

interface ServerListProps {
  servers: ServerInstance[];
  onDelete: (id: string) => void;
  onEdit: (server: ServerInstance) => void;
  /** Navigate to the detail view for a server. */
  onSelect?: (id: string) => void;
  onAdd: () => void;
  /** Open the "import existing server folder" wizard. */
  onImport?: () => void;
  /** The current sort preference. When provided alongside onSortChange, the
   * selector UI is rendered in the header. Both optional so older callers of
   * this component keep working without changes. */
  sortPreference?: SortPref;
  /** Change the sort preference. Reports back to the parent, which owns state. */
  onSortChange?: (pref: SortPref) => void;
}

/** Color swatches for the status-axis legend, mirroring status.ts. */
const LEGEND: { color: DotColor; label: string }[] = [
  { color: "green", label: "running" },
  { color: "amber", label: "transition / warn" },
  { color: "crimson", label: "orphaned / fault" },
  { color: "gray", label: "stopped" },
];

const DOT_HEX: Record<DotColor, string> = {
  green: "#4cf5a0",
  amber: "#f5a04c",
  crimson: "#f54c4c",
  gray: "#4c525e",
};

/**
 * Overview of the registry. The empty state frames the radar viewport so the
 * host is never visually idle — the sweep pulses even with no instances.
 */
export function ServerList({
  servers,
  onDelete,
  onEdit,
  onAdd,
  onImport,
  onSelect,
  sortPreference,
  onSortChange,
}: ServerListProps) {
  // Live host telemetry drives the empty-state radar so the dashboard pulses
  // with real machine load. Hook runs unconditionally (React rules) even though
  // the radar only renders in the empty state below.
  const hostTelemetry = useHostMetrics();

  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 p-8">
        <MatrixViewport
          cols={11}
          rows={11}
          shader={polarRadarShader}
          telemetry={hostTelemetry}
        />
        <div className="text-center">
          <p className="text-sm text-zinc-300">no server instances registered</p>
          <p className="mt-1 text-[11px] text-zinc-600">
            install a plugin, register a new instance, or adopt an existing
            server folder
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              onClick={onAdd}
              className="px-3 py-1.5 text-xs text-bg-core bg-signal-high hover:opacity-80 font-semibold transition-opacity"
            >
              + register instance
            </button>
            {onImport && (
              <button
                onClick={onImport}
                className="px-3 py-1.5 text-xs border border-grid-bounds text-zinc-300 hover:border-signal-low hover:bg-bg-core transition-colors"
              >
                import existing folder
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Sort selector is only rendered when the parent owns sort state — older
  // callers that don't pass these props keep their current header unchanged.
  const showSortControls = Boolean(sortPreference) && Boolean(onSortChange);

  function setSortKey(key: SortPref["key"]) {
    if (!sortPreference || !onSortChange) return;
    // Changing the field resets to ascending for a predictable start state.
    onSortChange({ key, direction: "asc" });
  }

  function toggleDirection() {
    if (!sortPreference || !onSortChange) return;
    onSortChange({
      key: sortPreference.key,
      direction: sortPreference.direction === "asc" ? "desc" : "asc",
    });
  }

  const sortSelectClass =
    "bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-200 focus:border-signal-low transition-colors";

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500">
          all instances{" "}
          <span className="text-zinc-600 tabular-nums">({servers.length})</span>
        </h2>
        <ul className="flex items-center gap-3">
          {onImport && (
            <li>
              <button
                onClick={onImport}
                className="px-2 py-1.5 text-[11px] border border-grid-bounds text-zinc-400 hover:text-zinc-200 hover:border-signal-low transition-colors"
              >
                import folder
              </button>
            </li>
          )}
          {showSortControls && (
            <li className="flex items-center gap-1.5 mr-1" title="sort instances">
              <span className="text-[10px] text-zinc-600 uppercase tracking-wider">
                sort
              </span>
              <select
                value={sortPreference!.key}
                onChange={(e) => setSortKey(e.target.value as SortPref["key"])}
                className={sortSelectClass}
              >
                <option value="name">name</option>
                <option value="serverType">type</option>
                <option value="status">status</option>
                <option value="path">path</option>
              </select>
              <button
                type="button"
                onClick={toggleDirection}
                title={
                  sortPreference!.direction === "asc"
                    ? "ascending (click to reverse)"
                    : "descending (click to reverse)"
                }
                aria-label={`sort direction: ${
                  sortPreference!.direction === "asc" ? "ascending" : "descending"
                }`}
                className="px-1.5 py-1.5 text-xs border border-grid-bounds text-zinc-300 hover:border-signal-low hover:bg-bg-core transition-colors"
              >
                {sortPreference!.direction === "asc" ? "↑" : "↓"}
              </button>
            </li>
          )}
          {LEGEND.map((entry) => (
            <li key={entry.color} className="flex items-center gap-1">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: DOT_HEX[entry.color] }}
              />
              <span className="text-[10px] text-zinc-600">{entry.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
        {servers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            onDelete={onDelete}
            onEdit={onEdit}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
