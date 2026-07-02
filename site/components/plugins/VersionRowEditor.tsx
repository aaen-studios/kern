"use client";

import { useState } from "react";
import type { PluginVersion } from "@/lib/registry";
import { formatRelativeTime } from "@/lib/registry";
import { formatBytes } from "@/lib/github";

/*
  Editable version table. Each row has an inline changelog input and a
  delete button. Emits changes up to the parent.
*/

export function VersionRowEditor({
  versions,
  pluginId,
  onVersionsChange,
}: {
  versions: PluginVersion[];
  pluginId: string;
  onVersionsChange: (versions: PluginVersion[]) => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const sorted = [...versions].sort((a, b) => b.created_at - a.created_at);

  const handleChangelogChange = (version: string, changelog: string) => {
    onVersionsChange(
      versions.map((v) => (v.version === version ? { ...v, changelog } : v)),
    );
  };

  const handleDelete = async (version: string) => {
    setDeleting(version);
    try {
      const res = await fetch(
        `/api/plugins/${pluginId}/versions/${encodeURIComponent(version)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "failed to delete version");
      }
      onVersionsChange(versions.filter((v) => v.version !== version));
      setConfirmDelete(null);
    } catch (err) {
      console.error("delete version error:", err);
    } finally {
      setDeleting(null);
    }
  };

  if (sorted.length === 0) {
    return (
      <p className="font-mono text-xs lowercase text-signal-low">
        no versions published.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-grid-bounds/60 text-left">
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">
              version
            </th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">
              compat
            </th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">
              updated
            </th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">
              size
            </th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">
              changelog
            </th>
            <th className="py-2 font-mono text-[11px] lowercase text-signal-low"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v, i) => (
            <tr
              key={v.version}
              className={`border-b border-grid-bounds/30 ${i === 0 ? "text-zinc-200" : "text-signal-low"}`}
            >
              <td className="py-3 pr-4 font-mono text-xs">
                <span className={i === 0 ? "text-signal-high" : ""}>
                  {v.version}
                </span>
                {i === 0 && (
                  <span className="ml-2 font-mono text-[10px] lowercase text-signal-low">
                    latest
                  </span>
                )}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px]">
                {v["kern-compat"] ?? "—"}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px]">
                {formatRelativeTime(v.created_at)}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px]">
                {formatBytes(v.size_bytes)}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px]">
                <input
                  value={v.changelog ?? ""}
                  onChange={(e) =>
                    handleChangelogChange(v.version, e.target.value)
                  }
                  placeholder="—"
                  className="w-full min-w-[140px] bg-bg-core px-2 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
                />
              </td>
              <td className="py-3">
                {confirmDelete === v.version ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDelete(v.version)}
                      disabled={deleting === v.version}
                      className="font-mono text-[11px] lowercase text-fault-vector transition hover:brightness-125"
                    >
                      {deleting === v.version ? "deleting…" : "confirm"}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="font-mono text-[11px] lowercase text-signal-low transition hover:text-zinc-300"
                    >
                      cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(v.version)}
                    className="font-mono text-[11px] lowercase text-signal-low transition hover:text-fault-vector"
                    title="delete version"
                  >
                    🗑
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
