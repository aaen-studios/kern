/**
 * Settings controls for multi-machine registry sync (export / import).
 *
 * Export pushes this machine's instance metadata to the configured git repo;
 * import pulls and shows what other machines have registered. Local instances
 * are never overwritten — the import is read-only by design.
 */

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ExportedInstance {
  id: string;
  name: string;
  serverType: string;
  autoStart: boolean;
  status: string;
}

interface ExportedRegistry {
  machine: string;
  exportedAt: number;
  instances: ExportedInstance[];
}

export function SyncControls() {
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<ExportedRegistry[]>([]);

  async function run(kind: "export" | "import") {
    setBusy(kind);
    setMessage(null);
    setError(null);
    try {
      if (kind === "export") {
        await invoke("sync_export");
        setMessage("Exported this machine's registry to the sync repo.");
      } else {
        const registries = await invoke<ExportedRegistry[]>("sync_import");
        setImported(registries);
        setMessage(
          registries.length
            ? `Pulled ${registries.length} machine registry${registries.length === 1 ? "" : "ies"}.`
            : "No incoming registries found.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-3 py-3 bg-bg-surface space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => void run("export")}
          disabled={busy !== null}
          className="btn-mono disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "export" ? "exporting…" : "export now"}
        </button>
        <button
          onClick={() => void run("import")}
          disabled={busy !== null}
          className="btn-mono disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === "import" ? "importing…" : "import / refresh"}
        </button>
      </div>

      {message && <p className="text-[11px] text-zinc-400">{message}</p>}
      {error && <p className="text-[11px] text-fault-vector break-words">{error}</p>}

      {imported.length > 0 && (
        <ul className="space-y-1">
          {imported.map((reg) => (
            <li key={`${reg.machine}:${reg.exportedAt}`} className="text-[11px]">
              <span className="text-zinc-300 font-mono">{reg.machine}</span>
              <span className="text-zinc-600">
                {" "}
                — {reg.instances.length} instance{reg.instances.length === 1 ? "" : "s"}
              </span>
              {reg.instances.length > 0 && (
                <span className="block text-[10px] text-zinc-600 truncate">
                  {reg.instances.map((i) => i.name).join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
