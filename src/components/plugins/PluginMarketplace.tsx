/**
 * Plugin marketplace — browse, search, and install plugins from the kern-web
 * registry (shared Supabase DB). All read endpoints are public; install
 * downloads the .kern and hands it to the existing install path.
 *
 * Rendered as an overlay panel from PluginManager's "browse" button.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "../../hooks/useToast";
import type { RegistryPlugin } from "../../types/features";
import { usePlugins } from "../../hooks/usePlugins";
import { clearPluginManifestCache } from "./PluginBoot";

interface PluginMarketplaceProps {
  onClose: () => void;
}

const CATEGORIES = [
  { key: "", label: "all" },
  { key: "game-server", label: "game server" },
  { key: "bot", label: "bot" },
  { key: "web", label: "web" },
  { key: "database", label: "database" },
  { key: "dev-tool", label: "dev tool" },
];

const SORTS = [
  { key: "popular", label: "popular" },
  { key: "recent", label: "recent" },
  { key: "upvotes", label: "upvotes" },
];

export function PluginMarketplace({ onClose }: PluginMarketplaceProps) {
  const { plugins: installed, refresh } = usePlugins();
  const { notify } = useToast();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("popular");
  const [results, setResults] = useState<RegistryPlugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ bytes: number; total: number } | null>(null);

  // Debounced fetch on query/category/sort change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const list = await invoke<RegistryPlugin[]>("registry_list_plugins", {
          q: query || null,
          category: category || null,
          sort: sort || null,
        });
        if (!cancelled) setResults(list);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, category, sort]);

  const isInstalled = useCallback(
    (slug: string) => installed.some((p) => p.id === slug),
    [installed],
  );

  /** Installed version for a registry slug, when it maps to a local plugin. */
  const installedVersion = useCallback(
    (slug: string) => installed.find((p) => p.id === slug)?.version ?? null,
    [installed],
  );

  async function handleInstall(plugin: RegistryPlugin) {
    const version = plugin.versions[0]?.version;
    if (!version) {
      notify({ kind: "error", title: "No versions", message: `${plugin.displayName} has no downloadable version` });
      return;
    }
    setInstallingSlug(plugin.slug);
    setProgress(null);
    const progressId = `marketplace-${plugin.slug}-${Date.now()}`;

    // Listen for download progress.
    const unlisten = await listen<{ bytes: number; total: number }>(
      `download:${progressId}:progress`,
      (e) => setProgress(e.payload),
    );

    try {
      await invoke("registry_install_plugin", {
        slug: plugin.slug,
        version,
        progressId,
        // Verify the package against the registry's advertised checksum when
        // present (protects against corrupted or tampered downloads).
        expectedSha256: plugin.versions[0]?.sha256 ?? null,
      });
      clearPluginManifestCache(plugin.slug);
      await refresh();
      notify({ kind: "success", title: "Installed", message: `${plugin.displayName} ${version}` });
    } catch (e) {
      notify({ kind: "error", title: "Install failed", message: String(e) });
    } finally {
      unlisten();
      setInstallingSlug(null);
      setProgress(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative z-10 w-full max-w-3xl h-[80vh] flex flex-col border border-grid-bounds bg-bg-surface"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-grid-bounds">
          <div>
            <h2 className="text-xs tracking-[0.15em] uppercase text-zinc-200">marketplace</h2>
            <p className="text-[10px] text-zinc-500 font-mono">kern-web registry</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm">
            ✕
          </button>
        </div>

        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-grid-bounds">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search plugins…"
            className="flex-1 min-w-[160px] bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 focus:border-signal-low outline-none"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="bg-bg-core border border-grid-bounds px-2 py-1.5 text-[11px] text-zinc-300"
          >
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="bg-bg-core border border-grid-bounds px-2 py-1.5 text-[11px] text-zinc-300"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Error */}
        {error && (
          <p className="m-3 text-[11px] text-fault-vector border border-fault-vector/40 bg-fault-vector/5 px-2 py-1">
            {error}
          </p>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="p-4 text-[11px] text-zinc-600">loading…</p>}
          {!loading && results.length === 0 && !error && (
            <p className="p-4 text-[11px] text-zinc-600">no plugins found</p>
          )}
          {!loading &&
            results.map((p) => {
              const installedFlag = isInstalled(p.slug);
              const localVersion = installedVersion(p.slug);
              const installing = installingSlug === p.slug;
              const latest = p.versions[0];
              const hasUpdate =
                installedFlag &&
                !!latest &&
                !!localVersion &&
                latest.version !== localVersion;
              return (
                <div
                  key={p.slug}
                  className="flex items-start justify-between gap-3 px-4 py-3 border-b border-grid-bounds hover:bg-bg-core transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-100 font-medium">{p.displayName}</span>
                      {p.featured && (
                        <span className="text-[9px] tracking-[0.15em] uppercase text-signal-high border border-signal-low px-1">
                          featured
                        </span>
                      )}
                      {installedFlag && (
                        <span className="text-[9px] tracking-[0.15em] uppercase text-zinc-500">
                          installed{localVersion ? ` v${localVersion}` : ""}
                        </span>
                      )}
                      {hasUpdate && (
                        <span className="text-[9px] tracking-[0.15em] uppercase text-warn-vector border border-warn-vector/40 px-1">
                          update available
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2">{p.description}</p>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-zinc-600 font-mono">
                      <span>↑ {p.upvotes}</span>
                      <span>↓ {p.installCount}</span>
                      {p.authorGithub && <span>by {p.authorGithub}</span>}
                      {latest && <span>v{latest.version}</span>}
                    </div>
                    {installing && progress && progress.total > 0 && (
                      <div className="mt-2 h-1 bg-grid-bounds">
                        <div
                          className="h-full bg-signal-high transition-all"
                          style={{ width: `${Math.round((progress.bytes / progress.total) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleInstall(p)}
                    disabled={installing}
                    className={`shrink-0 px-3 py-1.5 text-[11px] font-semibold transition-opacity ${
                      installedFlag
                        ? "text-zinc-300 border border-grid-bounds hover:border-signal-low"
                        : "text-bg-core bg-signal-high hover:opacity-80"
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    {installing
                      ? "installing…"
                      : hasUpdate
                        ? "update"
                        : installedFlag
                          ? "reinstall"
                          : "install"}
                  </button>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
