/**
 * Import wizard — adopt an existing server folder as a kern instance.
 *
 * The backend inspects the folder (jars, launch scripts, world, eula.txt) and
 * suggests a plugin runtime + overrides; the user confirms a name and plugin,
 * then a normal instance is created pointing at that folder.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { usePlugins } from "../../hooks/usePlugins";
import { useToast } from "../../hooks/useToast";
import type { ServerInstance } from "../../types/server";

export interface FolderInspection {
  path: string;
  jars: string[];
  startScripts: string[];
  hasServerProperties: boolean;
  eulaDeclined: boolean;
  hasWorld: boolean;
  suggestedRuntime?: string | null;
  suggestedOverrides: Record<string, string>;
  suggestedName: string;
}

interface ImportServerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (server: ServerInstance) => void;
}

export function ImportServerDialog({ open, onClose, onCreated }: ImportServerDialogProps) {
  const { plugins } = usePlugins();
  const { notify } = useToast();
  const [inspection, setInspection] = useState<FolderInspection | null>(null);
  const [name, setName] = useState("");
  const [pluginId, setPluginId] = useState("");
  const [busy, setBusy] = useState(false);

  // Default the plugin once the list arrives (or when it changes).
  useEffect(() => {
    if (pluginId || plugins.length === 0) return;
    const preferred = plugins.find((p) => p.id === "minecraft_java") ?? plugins[0];
    setPluginId(preferred.id);
  }, [plugins, pluginId]);

  const pickFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (!picked || Array.isArray(picked)) return;
    try {
      const result = await invoke<FolderInspection>("inspect_server_folder", {
        path: picked,
      });
      setInspection(result);
      setName(result.suggestedName);
      // Prefer the plugin whose runtime matches the detection.
      if (result.suggestedRuntime) {
        const mc = plugins.find((p) => p.id === "minecraft_java");
        if (mc) setPluginId(mc.id);
      }
    } catch (e) {
      notify({ kind: "error", title: "Could not inspect folder", message: String(e) });
    }
  }, [notify, plugins]);

  const create = useCallback(async () => {
    if (!inspection) return;
    if (!name.trim()) {
      notify({ kind: "warn", title: "Enter a name" });
      return;
    }
    setBusy(true);
    try {
      const server = await invoke<ServerInstance>("create_server", {
        input: {
          name: name.trim(),
          serverType: pluginId,
          path: inspection.path,
          // Runtime/jar hints only make sense for the Minecraft plugin.
          userOverrides: pluginId === "minecraft_java" ? inspection.suggestedOverrides : {},
          autoStart: false,
          group: null,
          tags: [],
          // Adopt in place: no scaffolding, no generated files.
          imported: true,
        },
      });
      notify({
        kind: "success",
        title: "Instance imported",
        message: `${server.name} now points at the existing folder.`,
      });
      onCreated(server);
      setInspection(null);
      onClose();
    } catch (e) {
      notify({ kind: "error", title: "Import failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }, [inspection, name, pluginId, notify, onCreated, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative z-10 w-full max-w-md border border-grid-bounds bg-bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-xs text-zinc-200 mb-1 tracking-[0.15em] uppercase">
          import existing server
        </h2>
        <p className="text-[11px] text-zinc-500 leading-relaxed mb-4">
          Point kern at a folder that already contains a server (jar or launch
          scripts, world, configs). Nothing is moved or modified — the instance
          simply manages the folder in place.
        </p>

        {!inspection ? (
          <button
            onClick={() => void pickFolder()}
            className="w-full px-3 py-2 text-xs border border-grid-bounds text-zinc-300 hover:border-signal-low hover:bg-bg-core transition-colors"
          >
            choose server folder…
          </button>
        ) : (
          <div className="space-y-3">
            <div className="text-[11px] text-zinc-500 font-mono break-all">
              {inspection.path}
            </div>
            <div className="text-[11px] text-zinc-400 space-y-0.5">
              {inspection.suggestedRuntime && (
                <div>
                  detected runtime:{" "}
                  <span className="text-signal-low">{inspection.suggestedRuntime}</span>
                </div>
              )}
              {inspection.jars.length > 0 && (
                <div>jars: {inspection.jars.join(", ")}</div>
              )}
              {inspection.startScripts.length > 0 && (
                <div>launch scripts: {inspection.startScripts.join(", ")}</div>
              )}
              {inspection.hasWorld && <div>world folder present</div>}
              {inspection.hasServerProperties && <div>server.properties present</div>}
              {inspection.eulaDeclined && (
                <div className="text-signal-low">
                  Minecraft EULA still needs accepting — you'll be prompted on
                  first start.
                </div>
              )}
            </div>

            <label className="block">
              <span className="text-[11px] text-zinc-500">name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 focus:border-signal-low outline-none"
              />
            </label>

            <label className="block">
              <span className="text-[11px] text-zinc-500">plugin</span>
              <select
                value={pluginId}
                onChange={(e) => setPluginId(e.target.value)}
                className="mt-1 w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 focus:border-signal-low outline-none"
              >
                {plugins.map((plugin) => (
                  <option key={plugin.id} value={plugin.id}>
                    {plugin.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-zinc-400 border border-grid-bounds hover:border-signal-low hover:text-zinc-200 transition-colors"
          >
            cancel
          </button>
          <button
            onClick={() => void create()}
            disabled={!inspection || busy || !pluginId}
            className="px-3 py-1.5 text-xs text-bg-core bg-signal-high hover:opacity-80 font-semibold transition-opacity disabled:opacity-40"
          >
            {busy ? "importing…" : "import"}
          </button>
        </div>
      </div>
    </div>
  );
}
