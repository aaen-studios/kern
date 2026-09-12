/**
 * File explorer tree — a collapsible, lazy-loading directory tree for the
 * server instance's working directory, modelled after VS Code's explorer.
 *
 * Supports:
 *   - Lazy directory expansion with child loading
 *   - Inline rename, new file, and new folder creation
 *   - Delete with confirmation (handled by parent via onDelete)
 *   - Drag-and-drop from OS desktop (copy files into the tree)
 *   - Drag-and-drop within the tree (move files/directories)
 *   - Reveal in system file manager, copy path, file metadata tooltips
 *   - Hidden-file dimming, active-file highlight with green accent
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { FileEntry } from "../../types/editor";
import { InlineInput } from "../ui/InlineInput";

interface FileTreeProps {
  /** Server instance id — used for backend calls in the parent. */
  serverId: string;
  /** Active file's relative path for highlighting. */
  activeFile: string | null;
  /** Callback when a file is clicked to open. */
  onOpenFile: (relPath: string) => void;
  /** Callback to list directory contents (returns FileEntry[]). */
  onListDirectory: (relPath: string) => Promise<FileEntry[]>;
  /** Set of currently expanded directory relative paths. */
  expandedPaths: Set<string>;
  /** Toggle a directory's expansion state. */
  onToggleExpand: (relPath: string) => void;
  /** Called when the tree should refresh (e.g. after create/delete/rename). */
  refreshKey?: number;

  // ── New file / folder ─────────────────────────────────────────────────────
  onCreateFile: (parentRelPath: string, name: string) => Promise<void>;
  onCreateFolder: (parentRelPath: string, name: string) => Promise<void>;

  // ── Rename / move ──────────────────────────────────────────────────────────
  onRename: (oldRelPath: string, newRelPath: string) => Promise<void>;
  onMoveFile: (sourceRelPath: string, targetDirRelPath: string) => Promise<void>;

  // ── Delete ────────────────────────────────────────────────────────────────
  /** Called when the user triggers delete. Parent shows ConfirmDialog. */
  onDelete: (relPath: string, isDir: boolean) => void;

  // ── Context-menu actions ──────────────────────────────────────────────────
  onRevealInExplorer: (relPath: string) => void;
  onCopyPath: (relPath: string) => void;

  // ── Drag-drop visual feedback ─────────────────────────────────────────────
  /** Current hovered directory path (managed by parent for Tauri DnD compat). */
  dragOverRelPath: string | null;
  /** Called when the user drags over or leaves a tree item. */
  onDragOverChange: (path: string | null) => void;
}

interface TreeNode {
  entry: FileEntry;
  relPath: string;
  children?: TreeNode[];
  loaded: boolean;
  loading: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Returns a short display icon/tag for common file types. */
function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "package.json") return "{ }";
  if (lower === "tsconfig.json") return "TS";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "T";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) return "J";
  if (lower.endsWith(".rs")) return "R";
  if (lower.endsWith(".py")) return "P";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "#";
  if (lower.endsWith(".json")) return "{ }";
  if (lower.endsWith(".md")) return "M";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "H";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "Y";
  if (lower.endsWith(".env")) return ".env";
  if (lower === "dockerfile") return "D";
  if (lower.endsWith(".gitignore")) return "!";
  if (lower === "readme.md") return "📄";
  return "";
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** Format byte count to a human-readable string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format unix-epoch milliseconds to a short date string. */
function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  // e.g. "2025-03-15 14:32"
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Build a tooltip for a file tree entry. */
function fileTooltip(entry: FileEntry): string {
  let tip = entry.name;
  if (!entry.isDir) {
    tip += `  —  ${formatSize(entry.size)}`;
  }
  if (entry.modified) {
    tip += `  |  modified ${formatDate(entry.modified)}`;
  }
  return tip;
}

/** Extract the basename from a relative path. */
function basename(relPath: string): string {
  const parts = relPath.split("/");
  return parts[parts.length - 1] ?? relPath;
}

/** Get the parent directory path from a relative path (empty string for root). */
function parentDir(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx > 0 ? relPath.slice(0, idx) : "";
}

// ── Root component ───────────────────────────────────────────────────────

export function FileTree({
  activeFile,
  onOpenFile,
  onListDirectory,
  expandedPaths,
  onToggleExpand,
  refreshKey = 0,
  onCreateFile,
  onCreateFolder,
  onRename,
  onMoveFile,
  onDelete,
  onRevealInExplorer,
  onCopyPath,
  dragOverRelPath,
  onDragOverChange,
}: FileTreeProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    relPath: string;
    isDir: boolean;
  } | null>(null);

  // Inline rename state
  const [renameState, setRenameState] = useState<{
    relPath: string;
    initialName: string;
  } | null>(null);

  // Inline create state
  const [createState, setCreateState] = useState<{
    parentRelPath: string;
    type: "file" | "folder";
  } | null>(null);

  const treeRef = useRef<HTMLDivElement>(null);

  // ── Drag-and-drop refs ──────────────────────────────────────────────
  /** Ref tracking the source item's relPath during an internal drag. */
  const draggedRelPathRef = useRef<string | null>(null);
  /** Counter preventing false container dragLeave when moving between items. */
  const dragCounterRef = useRef(0);
  /** Whether any item in this tree is currently being dragged (for source dimming). */
  const [isDragging, setIsDragging] = useState(false);

  // Load root directory on mount and refreshKey changes.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setRootError(null);
      try {
        const entries = await onListDirectory("");
        if (!cancelled) {
          setRootEntries(entries);
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) {
          setRootEntries([]);
          setRootError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [onListDirectory, refreshKey]);

  // Close context menu on any click outside.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // Keyboard: close context menu on Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, relPath: string, isDir: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, relPath, isDir });
    },
    [],
  );

  // ── Context-menu action handlers ──────────────────────────────────────────

  const startRename = useCallback(
    (relPath: string) => {
      setRenameState({ relPath, initialName: basename(relPath) });
      setContextMenu(null);
    },
    [],
  );

  const startCreate = useCallback(
    (parentRelPath: string, type: "file" | "folder") => {
      setCreateState({ parentRelPath, type });
      setContextMenu(null);
    },
    [],
  );

  const handleDelete = useCallback(
    (relPath: string, isDir: boolean) => {
      setContextMenu(null);
      onDelete(relPath, isDir);
    },
    [onDelete],
  );

  const handleReveal = useCallback(
    (relPath: string) => {
      setContextMenu(null);
      onRevealInExplorer(relPath);
    },
    [onRevealInExplorer],
  );

  const handleCopyPath = useCallback(
    (relPath: string) => {
      setContextMenu(null);
      onCopyPath(relPath);
    },
    [onCopyPath],
  );

  // ── Rename handlers ───────────────────────────────────────────────────────

  const submitRename = useCallback(
    async (newName: string) => {
      if (!renameState) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === renameState.initialName) {
        setRenameState(null);
        return;
      }
      const parent = parentDir(renameState.relPath);
      const newRelPath = parent ? `${parent}/${trimmed}` : trimmed;
      if (newRelPath === renameState.relPath) {
        setRenameState(null);
        return;
      }
      await onRename(renameState.relPath, newRelPath);
      setRenameState(null);
    },
    [renameState, onRename],
  );

  const cancelRename = useCallback(() => {
    setRenameState(null);
  }, []);

  // ── Create handlers ───────────────────────────────────────────────────────

  const submitCreate = useCallback(
    async (name: string) => {
      if (!createState) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setCreateState(null);
        return;
      }
      if (createState.type === "file") {
        await onCreateFile(createState.parentRelPath, trimmed);
      } else {
        await onCreateFolder(createState.parentRelPath, trimmed);
      }
      setCreateState(null);
    },
    [createState, onCreateFile, onCreateFolder],
  );

  const cancelCreate = useCallback(() => {
    setCreateState(null);
  }, []);

  // ── Drag-and-drop handlers (container-level) ─────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Allow drops on the tree container.
    e.preventDefault();
    // Show root highlight when hovering the container's empty space.
    if (e.target === e.currentTarget) {
      onDragOverChange("");
    }
  }, [onDragOverChange]);

  const handleDragEnterContainer = useCallback((_e: React.DragEvent) => {
    dragCounterRef.current += 1;
    // Default to root highlight when entering the tree.
    onDragOverChange("");
  }, [onDragOverChange]);

  const handleDragLeaveContainer = useCallback(() => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      onDragOverChange(null);
    }
  }, [onDragOverChange]);

  const handleDragEndContainer = useCallback((_e: React.DragEvent) => {
    // Clean up when drag is cancelled (e.g. Escape key).
    dragCounterRef.current = 0;
    draggedRelPathRef.current = null;
    onDragOverChange(null);
    setIsDragging(false);
  }, [onDragOverChange]);

  const handleDragEnd = useCallback((_e: React.DragEvent) => {
    // Called from the source item's onDragEnd — clean up drag state.
    dragCounterRef.current = 0;
    draggedRelPathRef.current = null;
    onDragOverChange(null);
    setIsDragging(false);
  }, [onDragOverChange]);

  const handleDropRoot = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      draggedRelPathRef.current = null;
      onDragOverChange(null);
      setIsDragging(false);

      // Internal tree move — drag from another item dropped on the root area.
      const sourcePath = draggedRelPathRef.current ?? e.dataTransfer.getData("text/plain");
      if (sourcePath) {
        const name = sourcePath.split("/").pop() ?? sourcePath;
        if (sourcePath !== name) {
          onMoveFile(sourcePath, "");
        }
      }
    },
    [onDragOverChange, onMoveFile],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (!loaded && loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-bg-core p-3">
        <p className="text-[11px] text-zinc-600">loading…</p>
      </div>
    );
  }

  if (rootError && rootEntries.length === 0 && !createState) {
    return (
      <div className="flex-1 overflow-y-auto bg-bg-core p-3 select-none">
        <p className="text-[11px] text-fault-vector break-words">
          could not list this directory
        </p>
        <p className="mt-1 text-[10px] text-zinc-600 break-words">{rootError}</p>
      </div>
    );
  }

  if (loaded && rootEntries.length === 0 && !createState) {
    return (
      <div
        ref={treeRef}
        className={`flex-1 overflow-y-auto bg-bg-core p-3 select-none ${
          dragOverRelPath === "" ? "ring-2 ring-signal-high/50" : ""
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, relPath: "", isDir: true });
        }}
        onDragEnter={handleDragEnterContainer}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeaveContainer}
        onDragEnd={handleDragEndContainer}
        onDrop={handleDropRoot}
      >
        <p className="text-[11px] text-zinc-600">(empty directory)</p>
      </div>
    );
  }

  return (
    <div
      ref={treeRef}
      className={`flex-1 overflow-y-auto bg-bg-core py-1 select-none ${
        dragOverRelPath === "" ? "ring-2 ring-signal-high/50" : ""
      }`}
      onContextMenu={(e) => {
        // Right-click on empty area: show root context menu.
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, relPath: "", isDir: true });
      }}
      onDragEnter={handleDragEnterContainer}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeaveContainer}
      onDragEnd={handleDragEndContainer}
      onDrop={handleDropRoot}
    >
      {rootEntries.map((entry) => (
        <FileTreeItem
          key={entry.name}
          entry={entry}
          relPath={entry.name}
          depth={0}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
          onListDirectory={onListDirectory}
          expandedPaths={expandedPaths}
          onToggleExpand={onToggleExpand}
          onContextMenu={handleContextMenu}
          refreshKey={refreshKey}
          // Inline rename
          renameState={renameState}
          onStartRename={startRename}
          onSubmitRename={submitRename}
          onCancelRename={cancelRename}
          // Inline create
          createState={createState}
          onSubmitCreate={submitCreate}
          onCancelCreate={cancelCreate}
          // Drag
          dragOverRelPath={dragOverRelPath}
          onDragOverChange={onDragOverChange}
          onMoveFile={onMoveFile}
          draggedRelPathRef={draggedRelPathRef}
          dragCounterRef={dragCounterRef}
          isDragging={isDragging}
          setIsDragging={setIsDragging}
          onDragEnd={handleDragEnd}
        />
      ))}

      {/* Inline create input at root level */}
      {createState && createState.parentRelPath === "" && (
        <div
          className="flex items-center gap-1.5"
          style={{ paddingLeft: `${8 + 0 * 14}px` }}
        >
          <span className="w-3.5 text-[10px] text-signal-low shrink-0 text-center">
            {createState.type === "folder" ? "▸" : ""}
          </span>
          <InlineInput
            placeholder={createState.type === "file" ? "filename.ext…" : "folder name…"}
            onSubmit={(name) => submitCreate(name)}
            onCancel={cancelCreate}
          />
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-bg-surface border border-grid-bounds shadow-xl py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <ContextMenuButton
            onClick={() => {
              onOpenFile(contextMenu.relPath);
              setContextMenu(null);
            }}
          >
            Open
          </ContextMenuButton>
          {contextMenu.isDir && (
            <ContextMenuButton
              onClick={() => {
                onToggleExpand(contextMenu.relPath);
                setContextMenu(null);
              }}
            >
              Toggle expand
            </ContextMenuButton>
          )}

          <div className="border-t border-grid-bounds my-1" />

          <ContextMenuButton
            onClick={() => startCreate(contextMenu.relPath, "file")}
          >
            New File…
          </ContextMenuButton>
          <ContextMenuButton
            onClick={() => startCreate(contextMenu.relPath, "folder")}
          >
            New Folder…
          </ContextMenuButton>

          <div className="border-t border-grid-bounds my-1" />

          <ContextMenuButton onClick={() => startRename(contextMenu.relPath)}>
            Rename…
          </ContextMenuButton>
          <ContextMenuButton
            className="text-fault-vector"
            onClick={() => handleDelete(contextMenu.relPath, contextMenu.isDir)}
          >
            Delete…
          </ContextMenuButton>

          <div className="border-t border-grid-bounds my-1" />

          <ContextMenuButton onClick={() => handleReveal(contextMenu.relPath)}>
            Reveal in File Explorer
          </ContextMenuButton>
          <ContextMenuButton onClick={() => handleCopyPath(contextMenu.relPath)}>
            Copy Path
          </ContextMenuButton>
        </div>
      )}
    </div>
  );
}

/* ── Context menu button ──────────────────────────────────────────────── */

function ContextMenuButton({
  onClick,
  className = "",
  children,
}: {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-bg-core transition-colors ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ─── Recursive Tree Item ─────────────────────────────────────────────── */

interface FileTreeItemProps {
  entry: FileEntry;
  relPath: string;
  depth: number;
  activeFile: string | null;
  onOpenFile: (relPath: string) => void;
  onListDirectory: (relPath: string) => Promise<FileEntry[]>;
  expandedPaths: Set<string>;
  onToggleExpand: (relPath: string) => void;
  onContextMenu: (e: React.MouseEvent, relPath: string, isDir: boolean) => void;
  /** Bumped by the parent to force a re-fetch of this directory's children. */
  refreshKey: number;

  // Inline rename
  renameState: { relPath: string; initialName: string } | null;
  onStartRename: (relPath: string) => void;
  onSubmitRename: (newName: string) => Promise<void>;
  onCancelRename: () => void;

  // Inline create
  createState: { parentRelPath: string; type: "file" | "folder" } | null;
  onSubmitCreate: (name: string) => Promise<void>;
  onCancelCreate: () => void;

  // Drag-drop
  dragOverRelPath: string | null;
  onDragOverChange: (path: string | null) => void;
  onMoveFile: (sourceRelPath: string, targetDirRelPath: string) => Promise<void>;
  /** Ref tracking the source item's relPath during an internal drag. */
  draggedRelPathRef: React.MutableRefObject<string | null>;
  /** Counter preventing false container dragLeave when moving between items. */
  dragCounterRef: React.MutableRefObject<number>;
  /** Whether any item in the tree is currently being dragged. */
  isDragging: boolean;
  /** Setter for the tree-level dragging state. */
  setIsDragging: React.Dispatch<React.SetStateAction<boolean>>;
  /** Cleanup handler called when a drag operation ends (on the source element). */
  onDragEnd: (e: React.DragEvent) => void;
}

function FileTreeItem({
  entry,
  relPath,
  depth,
  activeFile,
  onOpenFile,
  onListDirectory,
  expandedPaths,
  onToggleExpand,
  onContextMenu,
  renameState,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  createState,
  onSubmitCreate,
  onCancelCreate,
  dragOverRelPath,
  onDragOverChange,
  onMoveFile,
  draggedRelPathRef,
  dragCounterRef,
  isDragging,
  setIsDragging,
  onDragEnd,
  refreshKey,
}: FileTreeItemProps) {
  const [children, setChildren] = useState<TreeNode[] | null>(null);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const isExpanded = expandedPaths.has(relPath);
  const isActive = activeFile === relPath;
  const hidden = isHidden(entry.name);
  const icon = fileIcon(entry.name);
  const isBeingRenamed = renameState?.relPath === relPath;
  const isDragOver = dragOverRelPath === relPath;
  const isDragOverDir = isDragOver && entry.isDir;
  const isDragOverFile = isDragOver && !entry.isDir;
  const isBeingDragged = isDragging && draggedRelPathRef.current === relPath;

  // Load children when expanded for the first time, and re-load them whenever
  // the parent bumps `refreshKey` (e.g. after a create/delete/rename, on
  // window focus, or from a filesystem watcher event). Without this, the first
  // lazy load would be cached forever and expanded directories would show
  // stale contents after external changes.
  //
  // `children` is deliberately omitted from the deps: it is set *inside* the
  // effect, so including it would retrigger the effect after every fetch and
  // spin into an infinite loop. We instead track the last-applied refreshKey
  // in a ref and only refetch when it advances or the directory newly expands.
  const lastRefreshKey = useRef<number>(-1);
  useEffect(() => {
    if (!entry.isDir || !isExpanded) return;
    if (lastRefreshKey.current === refreshKey && children !== null) return;
    lastRefreshKey.current = refreshKey;
    let cancelled = false;
    setLoadingChildren(true);
    onListDirectory(relPath)
      .then((entries) => {
        if (!cancelled) {
          setChildren(
            entries.map((e) => ({
              entry: e,
              relPath: `${relPath}/${e.name}`,
              loaded: false,
              loading: false,
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setChildren([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingChildren(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.isDir, isExpanded, onListDirectory, relPath, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      onToggleExpand(relPath);
    } else {
      onOpenFile(relPath);
    }
  }, [entry.isDir, relPath, onToggleExpand, onOpenFile]);

  const handleContext = useCallback(
    (e: React.MouseEvent) => {
      onContextMenu(e, relPath, entry.isDir);
    },
    [onContextMenu, relPath, entry.isDir],
  );

  // ── Drag-and-drop handlers ─────────────────────────────────────────────

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      // Track the source path in a ref (more reliable than dataTransfer).
      draggedRelPathRef.current = relPath;
      e.dataTransfer.setData("text/plain", relPath);
      e.dataTransfer.effectAllowed = "move";
      setIsDragging(true);

      // Custom drag preview showing the file name.
      try {
        const preview = document.createElement("div");
        preview.textContent = ` 📄 ${basename(relPath)}`;
        preview.style.cssText =
          "padding:4px 10px;background:#1e1e1e;color:#e0e0e0;font-size:12px;" +
          "border-radius:4px;border:1px solid #555;position:absolute;top:-1000px;left:-1000px;" +
          "white-space:nowrap;";
        document.body.appendChild(preview);
        e.dataTransfer.setDragImage(preview, 0, 0);
        requestAnimationFrame(() => document.body.removeChild(preview));
      } catch {
        /* setDragImage not supported */
      }
    },
    [relPath, draggedRelPathRef, setIsDragging],
  );

  const handleItemDragOver = useCallback(
    (e: React.DragEvent) => {
      // Always allow drops — non-directories target the parent folder.
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      onDragOverChange(relPath);
    },
    [relPath, onDragOverChange],
  );

  const handleItemDragLeave = useCallback(
    (_e: React.DragEvent) => {
      // Only clear if we're leaving this specific item (not a child).
      if (dragOverRelPath === relPath) {
        onDragOverChange(null);
      }
    },
    [dragOverRelPath, relPath, onDragOverChange],
  );

  const handleItemDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      draggedRelPathRef.current = null;
      onDragOverChange(null);
      setIsDragging(false);

      // Read source path from ref first (reliable), fall back to dataTransfer.
      const sourcePath = draggedRelPathRef.current ?? e.dataTransfer.getData("text/plain");
      if (sourcePath && sourcePath !== relPath) {
        // If the target is a directory, move into it.
        // If the target is a file, move into its parent directory (like VS Code).
        const targetDir = entry.isDir ? relPath : parentDir(relPath);
        await onMoveFile(sourcePath, targetDir);
      }
    },
    [relPath, entry.isDir, onMoveFile, onDragOverChange, dragCounterRef, draggedRelPathRef, setIsDragging],
  );

  return (
    <div>
      {/* ── The item row ───────────────────────────────────────────── */}
      <button
        draggable={!isBeingRenamed}
        onClick={isBeingRenamed ? undefined : handleClick}
        onContextMenu={handleContext}
        onDragStart={handleDragStart}
        onDragEnd={onDragEnd}
        onDragOver={handleItemDragOver}
        onDragLeave={handleItemDragLeave}
        onDrop={handleItemDrop}
        className={`flex w-full items-center gap-1.5 text-left border-l-2 transition-all duration-100
          ${isActive ? "border-signal-high bg-bg-surface" : "border-transparent hover:bg-bg-surface"}
          ${isDragOverDir ? "ring-1 ring-inset ring-signal-high/60 bg-signal-high/[0.08]" : ""}
          ${isDragOverFile ? "bg-bg-surface/40" : ""}
          ${isBeingDragged ? "opacity-40" : ""}
          ${entry.isDir && !isBeingDragged ? "cursor-grab" : ""}
          ${isDragging && entry.isDir ? "cursor-grabbing" : ""}
        `}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={fileTooltip(entry)}
      >
        {/* Chevron/expand icon */}
        <span className="w-3.5 text-[10px] text-zinc-600 shrink-0 text-center">
          {entry.isDir ? (isExpanded ? "▾" : "▸") : ""}
        </span>

        {/* Loading spinner for lazy-loaded dirs */}
        {entry.isDir && loadingChildren && (
          <span className="w-3.5 text-[10px] text-signal-high shrink-0">•</span>
        )}

        {/* File type icon */}
        {!entry.isDir && icon && (
          <span className="text-[9px] text-zinc-500 w-4 text-center shrink-0">{icon}</span>
        )}

        {/* Name (or rename input) */}
        {isBeingRenamed ? (
          <InlineInput
            value={renameState!.initialName}
            selectExtension
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span
            className={`text-[11px] truncate ${
              isActive
                ? "text-zinc-100"
                : hidden
                  ? "text-zinc-600"
                  : "text-zinc-400"
            }`}
          >
            {entry.name}
          </span>
        )}
      </button>

      {/* ── Children (directory contents) ──────────────────────────────── */}
      {entry.isDir && isExpanded && (
        <div>
          {loadingChildren && children === null && (
            <p className="text-[10px] text-zinc-600 pl-[28px] py-0.5">loading…</p>
          )}
          {children !== null && children.length === 0 && (
            <p className="text-[10px] text-zinc-700 pl-[28px] py-0.5">(empty)</p>
          )}
          {children !== null &&
            children.map((child) => (
              <FileTreeItem
                key={child.relPath}
                entry={child.entry}
                relPath={child.relPath}
                depth={depth + 1}
                activeFile={activeFile}
                onOpenFile={onOpenFile}
                onListDirectory={onListDirectory}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
                onContextMenu={onContextMenu}
                refreshKey={refreshKey}
                renameState={renameState}
                onStartRename={onStartRename}
                onSubmitRename={onSubmitRename}
                onCancelRename={onCancelRename}
                createState={createState}
                onSubmitCreate={onSubmitCreate}
                onCancelCreate={onCancelCreate}
                dragOverRelPath={dragOverRelPath}
                onDragOverChange={onDragOverChange}
                onMoveFile={onMoveFile}
                draggedRelPathRef={draggedRelPathRef}
                dragCounterRef={dragCounterRef}
                isDragging={isDragging}
                setIsDragging={setIsDragging}
                onDragEnd={onDragEnd}
              />
            ))}

          {/* Inline create input as last child of this directory */}
          {createState && createState.parentRelPath === relPath && (
            <div
              className="flex items-center gap-1.5"
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              <span className="w-3.5 text-[10px] text-signal-low shrink-0 text-center">
                {createState.type === "folder" ? "▸" : ""}
              </span>
              <InlineInput
                placeholder={createState.type === "file" ? "filename.ext…" : "folder name…"}
                onSubmit={(name) => onSubmitCreate(name)}
                onCancel={onCancelCreate}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
