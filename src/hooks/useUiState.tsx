/**
 * Global UI state persistence — restores the full window UI state across
 * app launches: which view was active, which server was being viewed, which
 * tab was selected, what files were open, what tree directories were
 * expanded, command history, cursor position, etc.
 *
 * Architecture:
 *   - UiStateProvider wraps the app, loads persisted state on mount, and
 *     exposes a debounced save + a synchronous flush (for beforeunload).
 *   - Per-server state is scoped under `servers[serverId]` so each instance
 *     remembers its own editor/tree/tab configuration.
 *   - Only structural state is persisted (paths, flags, history). File
 *     content itself is NOT saved — on restore, open files are reloaded
 *     from disk via the existing `useFileEditor` machinery.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
  ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SortPref } from "../types/server";

/* ─── Types ────────────────────────────────────────────────────────────── */

export type ViewKind =
  | "list"
  | "detail"
  | "create"
  | "edit"
  | "plugins"
  | "settings"
  | "fleet";

export interface EditorState {
  /** Ordered relative paths of open files. */
  openFiles: string[];
  /** Currently active file path, or null. */
  activeFile: string | null;
  /** Expanded directory paths in the file tree. */
  expandedPaths: string[];
  /** Cursor position in the active editor. */
  cursorLine: number;
  cursorCol: number;
}

export interface ServerUiState {
  /** Which detail tab is active. Built-in ids: "logs" (displayed as "terminal"), "files". */
  activeTab: string;
  /** Command history for the terminal input (most-recent last). */
  commandHistory: string[];
  /** File editor state (open files, tree expansion, cursor). */
  editor: EditorState;
}

export interface UiState {
  /** The active top-level view. */
  activeViewKind: ViewKind;
  /** The selected server id (for detail/edit views). */
  selectedServerId: string | null;
  /** Per-server UI state, keyed by server id. */
  servers: Record<string, ServerUiState>;
  /** The current instance sort preference. Defaults to name ascending. */
  sortPreference: SortPref;
}

/* ─── Defaults ─────────────────────────────────────────────────────────── */

function defaultEditorState(): EditorState {
  return {
    openFiles: [],
    activeFile: null,
    expandedPaths: [],
    cursorLine: 1,
    cursorCol: 1,
  };
}

function defaultServerUiState(): ServerUiState {
  return {
    activeTab: "logs",
    commandHistory: [],
    editor: defaultEditorState(),
  };
}

function defaultUiState(): UiState {
  return {
    activeViewKind: "list",
    selectedServerId: null,
    servers: {},
    sortPreference: { key: "name", direction: "asc" },
  };
}

/* ─── Context ──────────────────────────────────────────────────────────── */

interface UiStateContextValue {
  /** The current persisted UI state. */
  uiState: UiState;
  /**
   * Update the top-level view/selection. Persists immediately (debounced).
   */
  setView: (kind: ViewKind, selectedServerId?: string | null) => void;
  /**
   * Update per-server UI state. Merges with existing state for that server.
   * Pass undefined for serverId to use the currently-selected server.
   */
  updateServer: (
    serverId: string | null | undefined,
    partial: Partial<ServerUiState>,
  ) => void;
  /**
   * Update the instance sort preference. Persists immediately (debounced).
   */
  setSortPreference: (pref: SortPref) => void;
  /**
   * Synchronously flush any pending save. Called on beforeunload.
   */
  flush: () => void;
}

const UiStateContext = createContext<UiStateContextValue | null>(null);

/* ─── Provider ─────────────────────────────────────────────────────────── */

interface UiStateProviderProps {
  children: ReactNode;
  /**
   * The currently-selected server id at the app level. Used as the default
   * scope for `updateServer` when no explicit serverId is given.
   */
  selectedServerId: string | null;
}

const SAVE_DEBOUNCE_MS = 500;

export function UiStateProvider({
  children,
  selectedServerId,
}: UiStateProviderProps) {
  const [uiState, setUiState] = useState<UiState>(defaultUiState);

  // Ref to track the latest state for the debounced save + flush.
  const stateRef = useRef<UiState>(uiState);
  stateRef.current = uiState;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);

  // Persist the current state to disk.
  const persist = useCallback((state: UiState) => {
    void invoke("set_ui_state", { state }).catch(() => {
      // Best-effort: a failed save shouldn't crash the UI.
    });
  }, []);

  // Debounced save — coalesces rapid changes into a single write.
  const scheduleSave = useCallback(
    (state: UiState) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        persist(state);
        debounceRef.current = null;
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  // Synchronous flush — called on beforeunload to ensure nothing is lost.
  const flush = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    persist(stateRef.current);
  }, [persist]);

  // Load persisted state on mount.
  useEffect(() => {
    let cancelled = false;
    invoke<UiState | null>("get_ui_state")
      .then((saved) => {
        if (cancelled) return;
        if (saved && typeof saved === "object") {
          // Merge with defaults so new fields are always present.
          const merged: UiState = {
            ...defaultUiState(),
            ...saved,
            servers: { ...(saved.servers ?? {}) },
          };
          stateRef.current = merged;
          setUiState(merged);
        }
        loadedRef.current = true;
      })
      .catch(() => {
        // No saved state or parse failure — use defaults.
        loadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Flush on beforeunload so the final state is always captured.
  useEffect(() => {
    const handler = () => flush();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [flush]);

  const setView = useCallback(
    (kind: ViewKind, serverId?: string | null) => {
      setUiState((prev) => {
        const next: UiState = {
          ...prev,
          activeViewKind: kind,
          selectedServerId:
            serverId !== undefined ? serverId : prev.selectedServerId,
        };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const setSortPreference = useCallback(
    (pref: SortPref) => {
      setUiState((prev) => {
        // No-op if unchanged — avoids a wasted save cycle.
        if (
          prev.sortPreference.key === pref.key &&
          prev.sortPreference.direction === pref.direction
        ) {
          return prev;
        }
        const next: UiState = {
          ...prev,
          sortPreference: { key: pref.key, direction: pref.direction },
        };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const updateServer = useCallback(
    (
      serverId: string | null | undefined,
      partial: Partial<ServerUiState>,
    ) => {
      const id = serverId === undefined ? selectedServerId : serverId;
      if (!id) return; // No server context — nothing to persist.
      setUiState((prev) => {
        const existing = prev.servers[id] ?? defaultServerUiState();
        const updated: ServerUiState = {
          ...existing,
          ...partial,
          // Deep-merge the editor sub-state so callers can update just one field.
          editor: {
            ...existing.editor,
            ...(partial.editor ?? {}),
          },
        };
        const next: UiState = {
          ...prev,
          servers: { ...prev.servers, [id]: updated },
        };
        scheduleSave(next);
        return next;
      });
    },
    [selectedServerId, scheduleSave],
  );

  const value: UiStateContextValue = {
    uiState,
    setView,
    updateServer,
    setSortPreference,
    flush,
  };

  return (
    <UiStateContext.Provider value={value}>{children}</UiStateContext.Provider>
  );
}

/* ─── Hook ─────────────────────────────────────────────────────────────── */

/**
 * Access the global UI state context. Returns the current state and
 * update functions. Must be used within a UiStateProvider.
 */
export function useUiState(): UiStateContextValue {
  const ctx = useContext(UiStateContext);
  if (!ctx) {
    throw new Error("useUiState must be used within a UiStateProvider");
  }
  return ctx;
}

