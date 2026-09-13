/**
 * Full file manager for the panel: lazy tree, tabs, Monaco (the desktop's own
 * editor component), markdown/json/image previews, snapshot history + diffs,
 * cross-file search, upload/download, create/rename/delete, conflict-safe saves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "../../../components/servers/CodeEditor";
import { DiffViewer } from "../../../components/servers/DiffViewer";
import { FilePreview } from "../../../components/servers/FilePreview";
import { languageFromPath, type OpenFile } from "../../../types/editor";
import "./monaco-env";
import { api, apiRaw } from "../../lib/api";
import { fmtAgo, fmtBytes } from "../../lib/format";
import { downloadInstanceFile } from "../../lib/sse";
import { useToast } from "../../lib/toast";
import type { FileEntry, SearchMatch, SnapshotInfo } from "../../lib/types";
import { FileTree } from "./FileTree";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"];

function parentDir(relPath: string): string {
  const parts = relPath.split("/");
  parts.pop();
  return parts.join("/");
}

function baseName(relPath: string): string {
  return relPath.split("/").pop() ?? relPath;
}

function isImagePath(relPath: string): boolean {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext);
}

export function FilesFeature({
  serverId,
  allowed,
}: {
  serverId: string;
  allowed: boolean;
}) {
  const { push } = useToast();
  const enc = encodeURIComponent;

  // tree
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(() => new Map());
  // editor session
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"edit" | "preview" | "diff">("edit");
  const [diffOriginal, setDiffOriginal] = useState<string | null>(null);
  const [gotoLine, setGotoLine] = useState<number | null>(null);
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  const savedContents = useRef<Map<string, string>>(new Map());
  // panels
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInclude, setSearchInclude] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  // context menu + mobile tree
  const [context, setContext] = useState<{ relPath: string; isDir: boolean } | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const activeFile = useMemo(
    () => openFiles.find((file) => file.relPath === active) ?? null,
    [openFiles, active],
  );

  const dirtyPaths = useMemo(
    () =>
      new Set(
        openFiles
          .filter((file) => file.content !== (savedContents.current.get(file.relPath) ?? ""))
          .map((file) => file.relPath),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openFiles],
  );

  const isDirty = (file: OpenFile) =>
    file.content !== (savedContents.current.get(file.relPath) ?? "");

  /* ── tree ─────────────────────────────────────────────────────────── */

  const loadDir = useCallback(
    async (dir: string) => {
      try {
        const data = await api<{ entries: FileEntry[] }>(
          `/servers/${enc(serverId)}/files?path=${enc(dir)}`,
        );
        const entries = [...(data.entries ?? [])].sort((a, b) =>
          a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
        );
        setCache((prev) => new Map(prev).set(dir, entries));
      } catch (err) {
        push(err instanceof Error ? err.message : "listing failed", "error");
      }
    },
    [serverId, push],
  );

  const invalidate = useCallback((dir: string) => {
    setCache((prev) => {
      const next = new Map(prev);
      next.delete(dir);
      return next;
    });
  }, []);

  useEffect(() => {
    void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  /* ── open/save ────────────────────────────────────────────────────── */

  const openFile = useCallback(
    async (relPath: string, line?: number | null) => {
      setTreeOpen(false);
      setViewMode("edit");
      const existing = openFiles.find((file) => file.relPath === relPath);
      if (existing) {
        setActive(relPath);
        if (line) setGotoLine(line);
        return;
      }
      try {
        const data = await api<{ content: string; mtime: number }>(
          `/servers/${enc(serverId)}/file?path=${enc(relPath)}`,
        );
        savedContents.current.set(relPath, data.content);
        setOpenFiles((prev) => [
          ...prev,
          {
            relPath,
            content: data.content,
            language: languageFromPath(relPath),
            isDirty: false,
            savedAt: Date.now(),
            mtime: data.mtime,
          },
        ]);
        setActive(relPath);
        if (line) setGotoLine(line);
      } catch (err) {
        push(err instanceof Error ? err.message : "read failed", "error");
      }
    },
    [openFiles, serverId, push],
  );

  const closeFile = useCallback(
    (relPath: string) => {
      const file = openFiles.find((entry) => entry.relPath === relPath);
      if (file && isDirty(file) && !confirm(`${baseName(relPath)} has unsaved changes. close anyway?`)) {
        return;
      }
      setOpenFiles((prev) => {
        const next = prev.filter((entry) => entry.relPath !== relPath);
        if (active === relPath) {
          setActive(next.length ? next[next.length - 1].relPath : null);
        }
        return next;
      });
      savedContents.current.delete(relPath);
    },
    [openFiles, active],
  );

  const saveFile = useCallback(
    async (relPath: string, force = false) => {
      const file = openFiles.find((entry) => entry.relPath === relPath);
      if (!file) return;
      try {
        const result = await api<{ mtime: number }>(`/servers/${enc(serverId)}/file`, {
          method: "PUT",
          json: {
            path: relPath,
            content: file.content,
            ...(force ? {} : { expectedMtime: file.mtime }),
          },
        });
        savedContents.current.set(relPath, file.content);
        setOpenFiles((prev) =>
          prev.map((entry) =>
            entry.relPath === relPath
              ? { ...entry, isDirty: false, savedAt: Date.now(), mtime: result.mtime }
              : entry,
          ),
        );
        push(`saved ${baseName(relPath)}`, "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : "save failed";
        if (message.includes("conflict:")) {
          if (confirm(`${baseName(relPath)} changed on disk since you opened it. overwrite anyway?`)) {
            await saveFile(relPath, true);
          }
        } else {
          push(message, "error");
        }
      }
    },
    [openFiles, serverId, push],
  );

  const saveAll = useCallback(async () => {
    for (const file of openFiles) {
      if (isDirty(file)) await saveFile(file.relPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFiles, saveFile]);

  /* ── structural ops ───────────────────────────────────────────────── */

  const fileOp = useCallback(
    async (op: string, path: string, to?: string) => {
      try {
        await api(`/servers/${enc(serverId)}/files`, { json: { op, path, to } });
        invalidate(parentDir(path));
        if (to) invalidate(parentDir(to));
        void loadDir(parentDir(path));
        if (to) void loadDir(parentDir(to));
      } catch (err) {
        push(err instanceof Error ? err.message : "operation failed", "error");
      }
    },
    [serverId, invalidate, loadDir, push],
  );

  const uploadFiles = useCallback(
    async (dir: string, files: FileList) => {
      let uploaded = 0;
      for (const file of Array.from(files)) {
        const rel = dir ? `${dir}/${file.name}` : file.name;
        try {
          const res = await apiRaw(
            `/servers/${enc(serverId)}/upload?path=${enc(rel)}`,
            { method: "POST", body: file },
          );
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error ?? `upload failed (${res.status})`);
          }
          uploaded += 1;
        } catch (err) {
          push(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`, "error");
        }
      }
      if (uploaded) {
        push(`uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}`, "success");
        invalidate(dir);
        void loadDir(dir);
      }
    },
    [serverId, push, invalidate, loadDir],
  );

  /* ── snapshots ────────────────────────────────────────────────────── */

  const loadSnapshots = useCallback(
    async (relPath: string) => {
      try {
        const data = await api<{ snapshots: SnapshotInfo[] }>(
          `/servers/${enc(serverId)}/snapshots?path=${enc(relPath)}`,
        );
        setSnapshots(data.snapshots ?? []);
      } catch (err) {
        push(err instanceof Error ? err.message : "snapshots failed", "error");
      }
    },
    [serverId, push],
  );

  useEffect(() => {
    if (snapshotsOpen && active) void loadSnapshots(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotsOpen, active]);

  /* ── image preview ────────────────────────────────────────────────── */

  useEffect(() => {
    if (viewMode !== "preview" || !activeFile || !isImagePath(activeFile.relPath)) {
      setImageUrl(null);
      return;
    }
    let url: string | null = null;
    let disposed = false;
    void apiRaw(`/servers/${enc(serverId)}/download?path=${enc(activeFile.relPath)}`).then(
      async (res) => {
        if (!res.ok) return;
        const blob = await res.blob();
        if (disposed) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      },
    );
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, activeFile?.relPath, serverId]);

  /* ── search ───────────────────────────────────────────────────────── */

  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearchBusy(true);
    try {
      const params = new URLSearchParams({ q: searchQuery, mode: "contents" });
      if (searchInclude.trim()) params.set("include", searchInclude.trim());
      const data = await api<{ matches: SearchMatch[] }>(
        `/servers/${enc(serverId)}/search?${params.toString()}`,
      );
      setSearchResults(data.matches ?? []);
    } catch (err) {
      push(err instanceof Error ? err.message : "search failed", "error");
    } finally {
      setSearchBusy(false);
    }
  }, [serverId, searchQuery, searchInclude, push]);

  /* ── keyboard ─────────────────────────────────────────────────────── */

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (active) void saveFile(active);
    }
  };

  /* ── render ───────────────────────────────────────────────────────── */

  const dirtyCount = openFiles.filter(isDirty).length;

  return (
    <div className="flex h-[calc(100dvh-14rem)] min-h-[420px] gap-3" onKeyDown={onKeyDown}>
      {/* tree (drawer on mobile) */}
      {treeOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 lg:hidden"
          onClick={() => setTreeOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-72 transform border-r border-grid-bounds bg-bg-surface transition-transform lg:static lg:z-auto lg:w-64 lg:shrink-0 lg:translate-x-0 lg:border ${
          treeOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-1 border-b border-grid-bounds px-2 py-1.5">
          <button
            onClick={() => setTreeOpen(false)}
            className="font-mono text-[11px] text-zinc-500 lg:hidden"
          >
            ✕
          </button>
          <span className="flex-1 font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
            files
          </span>
          {allowed && (
            <>
              <button
                title="new file"
                onClick={async () => {
                  const name = prompt("new file (relative path)");
                  if (name) await fileOp("mkdir", name); // creates parents only; file itself is created on save
                }}
                className="hidden"
              />
              <button
                title="upload"
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.multiple = true;
                  input.onchange = () => {
                    if (input.files?.length) void uploadFiles("", input.files);
                  };
                  input.click();
                }}
                className="font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
              >
                upload
              </button>
            </>
          )}
        </div>
        <div className="h-[calc(100%-34px)]">
          <FileTree
            cache={cache}
            loadDir={loadDir}
            activePath={active}
            dirtyPaths={dirtyPaths}
            onOpenFile={(rel) => void openFile(rel)}
            onContext={(relPath, isDir) => setContext({ relPath, isDir })}
            onDropFiles={(dir, files) => void uploadFiles(dir, files)}
          />
        </div>
      </aside>

      {/* editor column */}
      <div className="flex min-w-0 flex-1 flex-col border border-grid-bounds bg-bg-surface">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-grid-bounds px-2 py-1.5">
          <button
            onClick={() => setTreeOpen(true)}
            className="border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-400 lg:hidden"
          >
            files
          </button>
          {allowed && (
            <>
              <button
                onClick={async () => {
                  const name = prompt("new file (relative path, e.g. config/server.properties)");
                  if (!name) return;
                  await fileOp("mkdir", parentDir(name) || "");
                  await api(`/servers/${enc(serverId)}/file`, {
                    method: "PUT",
                    json: { path: name, content: "" },
                  }).catch((err) =>
                    push(err instanceof Error ? err.message : "create failed", "error"),
                  );
                  invalidate(parentDir(name));
                  void loadDir(parentDir(name));
                  void openFile(name);
                }}
                className="border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-400 hover:text-zinc-200"
              >
                new file
              </button>
              <button
                onClick={async () => {
                  const name = prompt("new folder (relative path)");
                  if (name) await fileOp("mkdir", name);
                }}
                className="border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-400 hover:text-zinc-200"
              >
                new folder
              </button>
            </>
          )}
          <button
            onClick={() => setSearchOpen((value) => !value)}
            className={`border px-2 py-1 font-mono text-[10px] lowercase ${
              searchOpen
                ? "border-signal-high text-signal-high"
                : "border-grid-bounds text-zinc-400 hover:text-zinc-200"
            }`}
          >
            search
          </button>
          {active && (
            <button
              onClick={() => setSnapshotsOpen((value) => !value)}
              className={`border px-2 py-1 font-mono text-[10px] lowercase ${
                snapshotsOpen
                  ? "border-signal-high text-signal-high"
                  : "border-grid-bounds text-zinc-400 hover:text-zinc-200"
              }`}
            >
              history
            </button>
          )}
          {active && (
            <div className="flex overflow-hidden border border-grid-bounds">
              {(["edit", "preview", "diff"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    if (mode === "diff" && diffOriginal === null) setDiffOriginal("");
                    setViewMode(mode);
                  }}
                  className={`px-2 py-1 font-mono text-[10px] lowercase ${
                    viewMode === mode ? "bg-bg-core text-signal-high" : "text-zinc-500"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {dirtyCount > 0 && (
              <span className="font-mono text-[10px] text-warn-vector">{dirtyCount} unsaved</span>
            )}
            {allowed && dirtyCount > 0 && (
              <button
                onClick={() => void saveAll()}
                className="border border-signal-high/40 px-2 py-1 font-mono text-[10px] lowercase text-signal-high"
              >
                save all
              </button>
            )}
          </span>
        </div>

        {/* tabs */}
        {openFiles.length > 0 && (
          <div className="flex overflow-x-auto border-b border-grid-bounds">
            {openFiles.map((file) => (
              <button
                key={file.relPath}
                onClick={() => {
                  setActive(file.relPath);
                  setViewMode("edit");
                }}
                className={`flex shrink-0 items-center gap-1.5 border-r border-grid-bounds px-2.5 py-1.5 font-mono text-[11px] ${
                  active === file.relPath ? "bg-bg-core text-zinc-100" : "text-zinc-500"
                }`}
              >
                {isDirty(file) && <span className="h-1.5 w-1.5 rounded-full bg-warn-vector" />}
                {baseName(file.relPath)}
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    closeFile(file.relPath);
                  }}
                  className="text-zinc-600 hover:text-fault-vector"
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        )}

        {searchOpen && (
          <div className="border-b border-grid-bounds p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runSearch();
                }}
                placeholder="search contents…"
                className="min-w-[160px] flex-1 border border-grid-bounds bg-bg-core px-2 py-1 font-mono text-[11px] text-zinc-200"
              />
              <input
                value={searchInclude}
                onChange={(event) => setSearchInclude(event.target.value)}
                placeholder="include glob (optional)"
                className="w-40 border border-grid-bounds bg-bg-core px-2 py-1 font-mono text-[10px] text-zinc-400"
              />
              <button
                onClick={() => void runSearch()}
                disabled={searchBusy}
                className="border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-300 disabled:opacity-40"
              >
                {searchBusy ? "searching…" : "go"}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="mt-2 max-h-40 overflow-y-auto border border-grid-bounds">
                {searchResults.slice(0, 200).map((match, index) => (
                  <button
                    key={`${match.relPath}:${match.lineNumber}:${index}`}
                    onClick={() => void openFile(match.relPath, match.lineNumber ?? null)}
                    className="block w-full border-b border-grid-bounds/40 px-2 py-1 text-left font-mono text-[10px] hover:bg-bg-core"
                  >
                    <span className="text-signal-high">
                      {match.relPath}
                      {match.lineNumber ? `:${match.lineNumber}` : ""}
                    </span>
                    {match.linePreview && (
                      <span className="ml-2 text-zinc-600">{match.linePreview.trim()}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* editor area */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {!activeFile ? (
            <div className="flex h-full items-center justify-center">
              <p className="font-mono text-[11px] text-zinc-600">
                open a file from the tree. drag files onto the tree to upload.
              </p>
            </div>
          ) : viewMode === "diff" ? (
            <div className="h-full overflow-auto">
              {diffOriginal === "" && (
                <p className="px-3 py-2 font-mono text-[10px] text-zinc-600">
                  pick a snapshot below (history) to diff against.
                </p>
              )}
              <DiffViewer
                original={diffOriginal ?? ""}
                modified={activeFile.content}
                language={activeFile.language}
                height="calc(100dvh - 22rem)"
              />
            </div>
          ) : viewMode === "preview" ? (
            <div className="h-full overflow-auto">
              {isImagePath(activeFile.relPath) ? (
                imageUrl ? (
                  <img src={imageUrl} alt={activeFile.relPath} className="max-w-full" />
                ) : (
                  <p className="px-3 py-2 font-mono text-[10px] text-zinc-600">loading image…</p>
                )
              ) : (
                <FilePreview file={activeFile} />
              )}
            </div>
          ) : (
            <CodeEditor
              language={activeFile.language}
              value={activeFile.content}
              path={activeFile.relPath}
              readOnly={!allowed}
              gotoLine={gotoLine}
              onChange={(value) =>
                setOpenFiles((prev) =>
                  prev.map((file) =>
                    file.relPath === activeFile.relPath
                      ? { ...file, content: value ?? "" }
                      : file,
                  ),
                )
              }
              onSave={() => active && void saveFile(active)}
              onCursorPosition={(line, column) => {
                setCursor({ line, column });
                setGotoLine(null);
              }}
            />
          )}
        </div>

        {/* snapshots strip */}
        {snapshotsOpen && active && (
          <div className="max-h-40 overflow-y-auto border-t border-grid-bounds p-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
                history · {baseName(active)}
              </span>
              {allowed && (
                <button
                  onClick={async () => {
                    try {
                      await api(`/servers/${enc(serverId)}/snapshots`, {
                        json: { path: active },
                      });
                      push("snapshot captured", "success");
                      void loadSnapshots(active);
                    } catch (err) {
                      push(err instanceof Error ? err.message : "snapshot failed", "error");
                    }
                  }}
                  className="ml-auto border border-grid-bounds px-2 py-0.5 font-mono text-[10px] lowercase text-zinc-400"
                >
                  capture now
                </button>
              )}
            </div>
            {snapshots.length === 0 ? (
              <p className="mt-1 font-mono text-[10px] text-zinc-600">no snapshots for this file.</p>
            ) : (
              snapshots.map((snapshot) => (
                <div
                  key={snapshot.id}
                  className="flex items-center gap-2 border-b border-grid-bounds/40 py-1"
                >
                  <span className="font-mono text-[10px] text-zinc-500">
                    {fmtAgo(Math.floor(snapshot.at / 1000))} · {fmtBytes(snapshot.size)}
                  </span>
                  <span className="ml-auto flex gap-2 font-mono text-[10px]">
                    <button
                      onClick={async () => {
                        const data = await api<{ content: string }>(
                          `/servers/${enc(serverId)}/snapshot?path=${enc(active)}&id=${enc(snapshot.id)}`,
                        );
                        setDiffOriginal(data.content);
                        setViewMode("diff");
                      }}
                      className="text-zinc-400 hover:text-signal-high"
                    >
                      diff
                    </button>
                    {allowed && (
                      <>
                        <button
                          onClick={async () => {
                            if (!confirm("restore this snapshot? the current version is snapshotted first."))
                              return;
                            await api(`/servers/${enc(serverId)}/snapshots/restore`, {
                              json: { path: active, id: snapshot.id },
                            });
                            const data = await api<{ content: string; mtime: number }>(
                              `/servers/${enc(serverId)}/file?path=${enc(active)}`,
                            );
                            savedContents.current.set(active, data.content);
                            setOpenFiles((prev) =>
                              prev.map((file) =>
                                file.relPath === active
                                  ? { ...file, content: data.content, mtime: data.mtime }
                                  : file,
                              ),
                            );
                            void loadSnapshots(active);
                          }}
                          className="text-zinc-400 hover:text-warn-vector"
                        >
                          restore
                        </button>
                        <button
                          onClick={async () => {
                            await api(`/servers/${enc(serverId)}/snapshots`, {
                              method: "DELETE",
                              json: { path: active, id: snapshot.id },
                            });
                            void loadSnapshots(active);
                          }}
                          className="text-fault-vector"
                        >
                          delete
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {/* status bar */}
        <div className="flex items-center gap-3 border-t border-grid-bounds px-2 py-1 font-mono text-[10px] text-zinc-600">
          <span className="min-w-0 flex-1 truncate">{active ?? "—"}</span>
          {activeFile && <span>{activeFile.language}</span>}
          {cursor && (
            <span>
              {cursor.line}:{cursor.column}
            </span>
          )}
        </div>
      </div>

      {/* context menu */}
      {context && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContext(null)} />
          <div className="fixed left-1/2 top-1/3 z-50 w-52 -translate-x-1/2 border border-grid-bounds bg-bg-surface py-1 shadow-xl">
            <p className="truncate px-3 py-1 font-mono text-[10px] text-zinc-500">
              {context.relPath}
            </p>
            {!context.isDir && (
              <>
                <MenuButton
                  onClick={() => {
                    void openFile(context.relPath);
                    setContext(null);
                  }}
                >
                  open
                </MenuButton>
                <MenuButton
                  onClick={() => {
                    void downloadInstanceFile(serverId, context.relPath).catch(() =>
                      push("download failed", "error"),
                    );
                    setContext(null);
                  }}
                >
                  download
                </MenuButton>
              </>
            )}
            {context.isDir && allowed && (
              <>
                <MenuButton
                  onClick={async () => {
                    const name = prompt("new file name");
                    const rel = `${context.relPath}/${name}`;
                    setContext(null);
                    if (!name) return;
                    await api(`/servers/${enc(serverId)}/file`, {
                      method: "PUT",
                      json: { path: rel, content: "" },
                    }).catch((err) =>
                      push(err instanceof Error ? err.message : "create failed", "error"),
                    );
                    invalidate(context.relPath);
                    void loadDir(context.relPath);
                    void openFile(rel);
                  }}
                >
                  new file
                </MenuButton>
                <MenuButton
                  onClick={() => {
                    void fileOp("mkdir", `${context.relPath}/${prompt("new folder name") ?? ""}`);
                    setContext(null);
                  }}
                >
                  new folder
                </MenuButton>
              </>
            )}
            {allowed && (
              <>
                <MenuButton
                  onClick={() => {
                    const to = prompt("rename to (relative path)", context.relPath);
                    if (to && to !== context.relPath) void fileOp("rename", context.relPath, to);
                    setContext(null);
                  }}
                >
                  rename
                </MenuButton>
                <MenuButton
                  danger
                  onClick={() => {
                    if (confirm(`delete ${context.relPath}${context.isDir ? " and its contents" : ""}?`)) {
                      void fileOp(context.isDir ? "delete_recursive" : "delete", context.relPath);
                    }
                    setContext(null);
                  }}
                >
                  delete
                </MenuButton>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left font-mono text-[11px] lowercase hover:bg-bg-core ${
        danger ? "text-fault-vector" : "text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}
