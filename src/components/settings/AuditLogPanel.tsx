/**
 * Audit log panel — the newest recorded actions with a JSON export.
 *
 * Entries are appended by the backend for lifecycle actions, config changes,
 * plugin installs, backups/restores, task runs, and announcements.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useToast } from "../../hooks/useToast";

interface AuditEntry {
  at: number;
  action: string;
  detail: string;
  serverId?: string;
}

export function AuditLogPanel() {
  const { notify } = useToast();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await invoke<AuditEntry[]>("get_audit_log", { limit: 100 }));
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportLog = async () => {
    try {
      const dest = await save({
        defaultPath: "kern-audit.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!dest) return;
      await invoke("export_audit_log", { dest });
      notify({ kind: "success", title: "Audit log exported", message: dest });
    } catch (e) {
      notify({ kind: "error", title: "Export failed", message: String(e) });
    }
  };

  return (
    <div className="px-3 py-3 bg-bg-surface space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-500">
          {loading ? "loading…" : `${entries.length} recent entries`}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => void load()}
            className="px-2 py-1 text-[11px] border border-grid-bounds text-zinc-400 hover:text-zinc-200"
          >
            refresh
          </button>
          <button
            onClick={() => void exportLog()}
            className="px-2 py-1 text-[11px] border border-grid-bounds text-zinc-400 hover:text-zinc-200"
          >
            export
          </button>
        </div>
      </div>

      {!loading && entries.length === 0 && (
        <p className="text-[11px] text-zinc-600">No recorded actions yet.</p>
      )}

      <div className="max-h-56 overflow-y-auto border border-grid-bounds divide-y divide-grid-bounds">
        {entries.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className="px-2 py-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] text-zinc-600 font-mono shrink-0">
                {new Date(entry.at * 1000).toLocaleString()}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-signal-low shrink-0">
                {entry.action}
              </span>
            </div>
            <div className="text-[11px] text-zinc-300 break-words">
              {entry.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
