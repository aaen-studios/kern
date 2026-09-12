/**
 * File search panel - provides project-wide search for files and file contents.
 *
 * Integrates into the FileEditorPanel as a collapsible search sidebar.
 * Shows matching files with line previews, clicking opens the file at the match.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SearchMatch {
  relPath: string;
  lineNumber: number | null;
  linePreview: string | null;
}

interface FileSearchPanelProps {
  /** Server instance id. */
  serverId: string;
  /** Callback when a file should be opened from search results. */
  onOpenFile: (relPath: string, line?: number | null) => void;
  /** Called when the user dismisses the search popup (Esc / close button). */
  onClose: () => void;
}

/**
 * File search panel component.
 * Shows a search input and results list below the file tree header.
 */
export function FileSearchPanel({ serverId, onOpenFile, onClose }: FileSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"filenames" | "contents">("contents");
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchTimeoutRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on mount so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Perform search
  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const matches = await invoke<SearchMatch[]>("search_files", {
        id: serverId,
        query: searchQuery,
        mode,
        include: "*",
        exclude: "node_modules/**,.git/**,target/**",
      });
      setResults(matches);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [serverId, mode]);

  // Handle query changes with debounce
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = window.setTimeout(() => {
      performSearch(query);
    }, 200);
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [query, performSearch]);

  const handleResultClick = useCallback((match: SearchMatch) => {
    onOpenFile(match.relPath, match.lineNumber);
    onClose();
  }, [onOpenFile, onClose]);

  return (
    <div className="flex flex-col h-full">
      {/* Search input + mode toggle.
          Stacked vertically so the 220px sidebar never overflows — the input
          takes the full width and the name/content toggle sits below it. */}
      <div className="px-3 py-2 border-b border-grid-bounds space-y-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="search files..."
          className="w-full bg-transparent text-[11px] font-mono text-zinc-300 placeholder:text-zinc-600 outline-none"
        />
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setMode("filenames")}
            className={`text-[10px] px-1.5 py-0.5 border transition-colors ${
              mode === "filenames"
                ? "text-signal-high border-signal-low"
                : "text-zinc-600 border-grid-bounds hover:text-zinc-400"
            }`}
            title="Search filenames only"
          >
            name
          </button>
          <button
            onClick={() => setMode("contents")}
            className={`text-[10px] px-1.5 py-0.5 border transition-colors ${
              mode === "contents"
                ? "text-signal-high border-signal-low"
                : "text-zinc-600 border-grid-bounds hover:text-zinc-400"
            }`}
            title="Search file contents"
          >
            content
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <p className="text-[11px] text-zinc-600 px-3 py-1">searching...</p>
        )}
        {error && (
          <p className="text-[11px] text-fault-vector px-3 py-1">{error}</p>
        )}
        {!loading && !error && query && results.length === 0 && (
          <p className="text-[11px] text-zinc-600 px-3 py-1">no results</p>
        )}
        {!loading && !error && !query && (
          <p className="text-[11px] text-zinc-600 px-3 py-1">enter a search query</p>
        )}

        {results.map((match) => (
          <button
            key={`${match.relPath}:${match.lineNumber ?? ""}`}
            onClick={() => handleResultClick(match)}
            className="w-full text-left px-3 py-1.5 hover:bg-bg-surface transition-colors border-b border-grid-bounds last:border-0"
          >
            <p className="text-[11px] text-zinc-400 truncate font-mono">{match.relPath}</p>
            {mode === "contents" && match.lineNumber !== null && match.linePreview && (
              <p className="text-[10px] text-zinc-600 mt-0.5 truncate">
                line {match.lineNumber}: {match.linePreview}
              </p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}