/**
 * Plugins page (admin): installed list with uninstall, `.kern` upload-install,
 * and the registry marketplace with background-job installs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { fmtBytes } from "../lib/format";
import { navigate } from "../lib/router";
import { useToast } from "../lib/toast";
import type { Job, PluginManifest, RegistryPlugin } from "../lib/types";

export function Plugins() {
  const { push } = useToast();
  const [installed, setInstalled] = useState<PluginManifest[]>([]);
  const [market, setMarket] = useState<RegistryPlugin[]>([]);
  const [query, setQuery] = useState("");
  const [marketBusy, setMarketBusy] = useState(false);
  const [installing, setInstalling] = useState<Record<string, Job>>({});
  const pollTimers = useRef<number[]>([]);

  const loadInstalled = useCallback(async () => {
    try {
      const data = await api<{ plugins: PluginManifest[] }>("/plugins");
      setInstalled(data.plugins ?? []);
    } catch (err) {
      push(err instanceof Error ? err.message : "plugins failed", "error");
    }
  }, [push]);

  const loadMarket = useCallback(
    async (search: string) => {
      setMarketBusy(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("q", search.trim());
        const data = await api<{ plugins: RegistryPlugin[] }>(
          `/registry/plugins?${params.toString()}`,
        );
        setMarket(data.plugins ?? []);
      } catch (err) {
        push(err instanceof Error ? err.message : "marketplace failed", "error");
      } finally {
        setMarketBusy(false);
      }
    },
    [push],
  );

  useEffect(() => {
    void loadInstalled();
    void loadMarket("");
    return () => {
      for (const timer of pollTimers.current) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const watchJob = useCallback(
    (slug: string, jobId: string) => {
      const timer = window.setInterval(async () => {
        try {
          const job = await api<Job>(`/jobs/${encodeURIComponent(jobId)}`);
          setInstalling((prev) => ({ ...prev, [slug]: job }));
          if (job.state !== "running") {
            window.clearInterval(timer);
            if (job.state === "done") {
              push(`${slug}: ${job.message || "installed"}`, "success");
              void loadInstalled();
            } else {
              push(`${slug}: ${job.message || "install failed"}`, "error");
            }
            window.setTimeout(() => {
              setInstalling((prev) => {
                const next = { ...prev };
                delete next[slug];
                return next;
              });
            }, 4000);
          }
        } catch {
          window.clearInterval(timer);
        }
      }, 1500);
      pollTimers.current.push(timer);
    },
    [push, loadInstalled],
  );

  async function uploadInstall(files: FileList) {
    for (const file of Array.from(files)) {
      try {
        const res = await fetch(
          `/api/plugins/upload-install?name=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${localStorage.getItem("kern.token") ?? ""}` },
            body: file,
          },
        );
        const data = (await res.json()) as {
          error?: string;
          displayName?: string;
          version?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "install failed");
        push(`installed ${data.displayName ?? file.name} v${data.version ?? "?"}`, "success");
        void loadInstalled();
      } catch (err) {
        push(`${file.name}: ${err instanceof Error ? err.message : "install failed"}`, "error");
      }
    }
  }

  return (
    <div className="max-w-4xl">
      <h1 className="font-mono text-sm uppercase tracking-[0.2em] text-zinc-100">plugins</h1>
      <p className="mt-1 font-mono text-[11px] text-zinc-600">
        installed plugins, uploads, and the registry marketplace.
      </p>

      {/* installed */}
      <section className="mt-6 card-panel">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-400">
            installed ({installed.length})
          </h2>
          <label className="ml-auto cursor-pointer border border-signal-high/40 px-3 py-1 font-mono text-[11px] lowercase text-signal-high">
            install .kern
            <input
              type="file"
              accept=".kern"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files?.length) void uploadInstall(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
        </div>
        <div className="mt-2">
          {installed.map((plugin) => (
            <div
              key={plugin.id}
              className="flex items-center gap-2 border-b border-grid-bounds/40 py-2"
            >
              <span className="font-mono text-[11px] text-zinc-300">
                {plugin.displayName ?? plugin.id}{" "}
                <span className="text-zinc-600">
                  · {plugin.id} · v{plugin.version ?? "?"}
                  {plugin.author ? ` · ${plugin.author}` : ""}
                </span>
              </span>
              <button
                onClick={async () => {
                  if (!confirm(`uninstall ${plugin.id}?`)) return;
                  try {
                    await api(`/plugins/${encodeURIComponent(plugin.id)}`, { method: "DELETE" });
                    push("plugin removed", "warn");
                    void loadInstalled();
                  } catch (err) {
                    push(err instanceof Error ? err.message : "uninstall failed", "error");
                  }
                }}
                className="ml-auto font-mono text-[10px] text-fault-vector"
              >
                uninstall
              </button>
            </div>
          ))}
          {installed.length === 0 && (
            <p className="py-1 font-mono text-[11px] text-zinc-600">no plugins installed.</p>
          )}
        </div>
      </section>

      {/* marketplace */}
      <section className="mt-4 card-panel">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-400">
            marketplace
          </h2>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadMarket(query);
            }}
            placeholder="search the registry…"
            className="input ml-auto max-w-[220px]"
          />
          <button onClick={() => void loadMarket(query)} disabled={marketBusy} className="btn">
            {marketBusy ? "…" : "search"}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {market.map((plugin) => {
            const versions = plugin.versions ?? [];
            const latest = versions
              .slice()
              .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
            const job = installing[plugin.slug];
            const alreadyInstalled = installed.some((entry) => entry.id === plugin.id);
            return (
              <div key={plugin.id} className="border border-grid-bounds bg-bg-core p-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-100">
                    {plugin.displayName}
                  </span>
                  {latest && (
                    <span className="font-mono text-[10px] text-zinc-600">v{latest.version}</span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 font-mono text-[10px] text-zinc-500">
                  {plugin.description}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  {latest?.sizeBytes ? (
                    <span className="font-mono text-[10px] text-zinc-700">
                      {fmtBytes(latest.sizeBytes)}
                    </span>
                  ) : null}
                  <button
                    disabled={!latest || !!job || alreadyInstalled}
                    onClick={async () => {
                      if (!latest) return;
                      try {
                        const result = await api<{ jobId: string }>("/registry/install", {
                          json: { slug: plugin.slug, version: latest.version },
                        });
                        push(`installing ${plugin.displayName}…`, "info");
                        watchJob(plugin.slug, result.jobId);
                      } catch (err) {
                        push(err instanceof Error ? err.message : "install failed", "error");
                      }
                    }}
                    className="ml-auto border border-signal-high/40 px-2.5 py-1 font-mono text-[10px] lowercase text-signal-high disabled:opacity-40"
                  >
                    {job ? job.state : alreadyInstalled ? "installed" : "install"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {market.length === 0 && !marketBusy && (
          <p className="mt-3 font-mono text-[11px] text-zinc-600">nothing from the registry.</p>
        )}
      </section>

      <button
        onClick={() => navigate("/overview")}
        className="mt-6 font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
      >
        ← back to overview
      </button>
    </div>
  );
}
