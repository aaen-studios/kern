/** Lazy file tree: directories load their children on first expand. */

import { useState } from "react";
import type { FileEntry } from "../../lib/types";
import { fmtBytes } from "../../lib/format";

export interface TreeApi {
  /** Children by directory path ("" = instance root); undefined = unloaded. */
  cache: Map<string, FileEntry[]>;
  loadDir: (dir: string) => Promise<void>;
  invalidate: (dir?: string) => void;
}

export function FileTree({
  cache,
  loadDir,
  activePath,
  dirtyPaths,
  onOpenFile,
  onContext,
  onDropFiles,
  rootLabel = "instance root",
}: {
  cache: Map<string, FileEntry[]>;
  loadDir: (dir: string) => Promise<void>;
  activePath: string | null;
  dirtyPaths: Set<string>;
  onOpenFile: (relPath: string) => void;
  onContext: (relPath: string, isDir: boolean) => void;
  onDropFiles: (dir: string, files: FileList) => void;
  rootLabel?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
        void loadDir(dir);
      }
      return next;
    });
  };

  const renderDir = (dir: string, depth: number) => {
    const children = cache.get(dir);
    if (children === undefined) {
      return (
        <p className="px-2 py-1 font-mono text-[10px] text-zinc-600" style={{ paddingLeft: depth * 12 + 8 }}>
          loading…
        </p>
      );
    }
    return children.map((entry) => {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      const isExpanded = expanded.has(rel);
      return (
        <div key={rel}>
          <div
            className={`group flex cursor-pointer items-center gap-1.5 py-1 pr-1 hover:bg-bg-core ${
              activePath === rel ? "bg-bg-core" : ""
            } ${dropTarget === rel && entry.isDir ? "ring-1 ring-signal-high" : ""}`}
            style={{ paddingLeft: depth * 12 + 8 }}
            onClick={() => (entry.isDir ? toggle(rel) : onOpenFile(rel))}
            onContextMenu={(event) => {
              event.preventDefault();
              onContext(rel, entry.isDir);
            }}
            onDragOver={(event) => {
              if (!entry.isDir) return;
              event.preventDefault();
              setDropTarget(rel);
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(event) => {
              if (!entry.isDir) return;
              event.preventDefault();
              setDropTarget(null);
              if (event.dataTransfer.files.length) onDropFiles(rel, event.dataTransfer.files);
            }}
          >
            <span className={`w-3 font-mono text-[10px] ${entry.isDir ? "text-signal-high" : "text-zinc-700"}`}>
              {entry.isDir ? (isExpanded ? "▾" : "▸") : " "}
            </span>
            <span
              className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                entry.isDir ? "text-zinc-300" : "text-zinc-400"
              }`}
            >
              {entry.name}
            </span>
            {dirtyPaths.has(rel) && <span className="h-1.5 w-1.5 rounded-full bg-warn-vector" />}
            {!entry.isDir && (
              <span className="font-mono text-[9px] text-zinc-700">{fmtBytes(entry.size)}</span>
            )}
            <button
              onClick={(event) => {
                event.stopPropagation();
                onContext(rel, entry.isDir);
              }}
              className="font-mono text-[11px] text-zinc-700 opacity-0 group-hover:opacity-100 lg:opacity-0"
              title="actions"
            >
              ⋯
            </button>
          </div>
          {entry.isDir && isExpanded && renderDir(rel, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className="h-full overflow-y-auto py-1"
      onDragOver={(event) => {
        event.preventDefault();
        setDropTarget("");
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(event) => {
        event.preventDefault();
        setDropTarget(null);
        if (event.dataTransfer.files.length) onDropFiles("", event.dataTransfer.files);
      }}
    >
      <div className="px-2 pb-1 font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-700">
        {rootLabel}
      </div>
      {renderDir("", 0)}
    </div>
  );
}
