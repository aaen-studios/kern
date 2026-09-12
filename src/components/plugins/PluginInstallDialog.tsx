import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Manifest } from "../../types/manifest";
import { PERMISSION_LABELS } from "./permissions";
import { clearPluginManifestCache } from "./PluginBoot";

interface PluginInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful install so the parent can refresh the plugin list. */
  onInstalled: () => void;
  /** Pre-loaded .kern file path to auto-preview. */
  initialPath?: string | null;
}

/**
 * Modal dialog for installing a community plugin from disk.
 *
 * Supports both directory selection (for development) and .kern file selection
 * (for distribution). Uses the Tauri native file dialog to let the user select
 * a plugin directory, manifest.json file, or .kern package.
 *
 * Styling follows the ConfirmDialog pattern — dark scrim, centered card,
 * Escape / backdrop-click to close.
 */
export function PluginInstallDialog({
  isOpen,
  onClose,
  onInstalled,
  initialPath,
}: PluginInstallDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [previewManifest, setPreviewManifest] = useState<Manifest | null>(null);
  const [isKernFile, setIsKernFile] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the dialog opens.
  useEffect(() => {
    if (isOpen) {
      setSelectedPath(null);
      setSelectedName(null);
      setPreviewManifest(null);
      setIsKernFile(false);
      setInstalling(false);
      setError(null);
    }
  }, [isOpen]);

  // Auto-load .kern file if initialPath was passed (deep link)
  useEffect(() => {
    if (initialPath && !selectedPath) {
      setSelectedPath(initialPath);
      setSelectedName(initialPath.split(/[/\\]/).pop() ?? initialPath);
      setIsKernFile(true);
      void previewKernFile(initialPath);
    }
  }, [initialPath]);

  // Focus the cancel button when opened; close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    cancelRef.current?.focus();
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  /** Open the native file dialog to pick a plugin directory or manifest.json. */
  async function handleBrowse() {
    try {
      // Try picking a .kern file first (the new distribution format)
      const kernFile = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "kern package",
            extensions: ["kern"],
          },
        ],
        title: "Select .kern plugin package",
      });
      if (kernFile) {
        setSelectedPath(kernFile as string);
        setSelectedName((kernFile as string).split(/[/\\]/).pop() ?? (kernFile as string));
        setIsKernFile(true);
        setError(null);
        // Preview the manifest
        void previewKernFile(kernFile as string);
        return;
      }
    } catch {
      // Fall through to directory picker
    }

    try {
      // Try picking a directory (the common case for development)
      const dir = await open({
        multiple: false,
        directory: true,
        title: "Select plugin directory",
      });
      if (dir) {
        setSelectedPath(dir as string);
        // Show just the last segment as the label.
        const label = (dir as string).replace(/[/\\]$/, "").split(/[/\\]/).pop() ?? (dir as string);
        setSelectedName(label);
        setIsKernFile(false);
        setPreviewManifest(null);
        setError(null);
        return;
      }
    } catch {
      // directory picker might not be supported on all platforms; fall through
      // to the file picker below.
    }

    // Fallback: pick a manifest.json file.
    try {
      const file = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "manifest",
            extensions: ["json"],
          },
        ],
        title: "Select manifest.json",
      });
      if (file) {
        setSelectedPath(file as string);
        setSelectedName((file as string).split(/[/\\]/).pop() ?? (file as string));
        setIsKernFile(false);
        setPreviewManifest(null);
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  /** Preview a .kern file's manifest without installing */
  async function previewKernFile(path: string) {
    try {
      const manifest = await invoke<Manifest>("validate_kern_file", { path });
      setPreviewManifest(manifest);
    } catch (e) {
      setPreviewManifest(null);
      setError(`could not read plugin package: ${String(e)}`);
    }
  }

  async function handleInstall() {
    if (!selectedPath) return;
    setInstalling(true);
    setError(null);
    try {
      if (isKernFile) {
        // Install from .kern package - upgrade if already exists
        await invoke("install_plugin_from_kern", {
          sourcePath: selectedPath,
          force: true,
        });
      } else {
        // Install from directory
        await invoke("install_plugin", { sourcePath: selectedPath });
      }
      clearPluginManifestCache();
      onInstalled();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Scrim */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Dialog */}
      <div
        className="relative z-10 w-full max-w-sm border border-grid-bounds bg-bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-dialog-title"
      >
        <h2
          id="install-dialog-title"
          className="text-xs text-zinc-200 mb-1 tracking-[0.15em] uppercase"
        >
          install plugin
        </h2>
        <p className="text-[11px] text-zinc-500 mb-4 leading-relaxed">
          Select a <code className="text-zinc-400">.kern</code> package or plugin directory.
        </p>

        {/* Selected path display */}
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={handleBrowse}
            disabled={installing}
            className="px-3 py-1.5 text-xs text-zinc-200 border border-signal-low hover:border-signal-high hover:text-signal-high font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            browse…
          </button>
          <span className="text-[11px] text-zinc-500 truncate flex-1 min-w-0">
            {selectedName ?? "no selection"}
          </span>
        </div>

        {/* Plugin preview (shown for .kern files) */}
        {previewManifest && (
          <div className="mb-4 p-3 border border-signal-low/20 bg-bg-core/50">
            <h3 className="text-xs text-zinc-200 font-medium mb-1">
              {previewManifest.displayName}
            </h3>
            {previewManifest.description && (
              <p className="text-[11px] text-zinc-400 mb-2">
                {previewManifest.description}
              </p>
            )}
            <p className="text-[11px] text-zinc-500 font-mono mb-1">
              v{previewManifest.version}
            </p>
            <p className="text-[11px] text-zinc-400 mb-2">
              by {previewManifest.author}
            </p>
            {previewManifest.permissions && previewManifest.permissions.length > 0 ? (
              <div className="mb-1">
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  permissions
                </p>
                <ul className="space-y-0.5">
                  {previewManifest.permissions.map((p) => (
                    <li key={p} className="text-[11px] text-zinc-400">
                      • {PERMISSION_LABELS[p] ?? p}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[11px] text-zinc-500 mb-1">
                No capability permissions declared.
              </p>
            )}
            {previewManifest.tabs && previewManifest.tabs.length > 0 && (
              <p className="text-[10px] text-zinc-500">
                {previewManifest.tabs.length} tab(s):{" "}
                {previewManifest.tabs.map((t) => t.label).join(", ")}
              </p>
            )}
          </div>
        )}

        {/* Trust notice — plugins are executable code, not data. */}
        <p className="mb-4 text-[10px] text-amber-500/80 leading-relaxed">
          Plugins run with the access listed above. Only install packages you
          trust.
        </p>

        {/* Error feedback */}
        {error && (
          <p className="mb-4 text-[11px] text-fault-vector border border-fault-vector/40 bg-fault-vector/5 px-2 py-1">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            disabled={installing}
            className="px-3 py-1.5 text-xs text-zinc-400 border border-grid-bounds hover:border-signal-low hover:text-zinc-200 transition-colors disabled:opacity-40"
          >
            cancel
          </button>
          <button
            onClick={handleInstall}
            disabled={!selectedPath || installing}
            className="px-3 py-1.5 text-xs font-semibold text-bg-core bg-signal-high hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {installing ? "installing…" : "install"}
          </button>
        </div>
      </div>
    </div>
  );
}
