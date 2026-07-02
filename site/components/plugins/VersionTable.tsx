import type { PluginVersion } from "@/lib/registry";
import { formatRelativeTime } from "@/lib/registry";
import { formatBytes } from "@/lib/github";

/*
  §7.2 — version table. version, kern-compat, date, size, changelog excerpt,
  per-version download.
*/
export function VersionTable({ versions }: { versions: PluginVersion[] }) {
  const sorted = [...versions].sort((a, b) => b.created_at - a.created_at);
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
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">version</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">compat</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">updated</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">size</th>
            <th className="py-2 pr-4 font-mono text-[11px] lowercase text-signal-low">changelog</th>
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
                <span className={i === 0 ? "text-signal-high" : ""}>{v.version}</span>
                {i === 0 && (
                  <span className="ml-2 font-mono text-[10px] lowercase text-signal-low">
                    latest
                  </span>
                )}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-signal-low">
                {v["kern-compat"] ?? "—"}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-signal-low">
                {formatRelativeTime(v.created_at)}
              </td>
              <td className="py-3 pr-4 font-mono text-[11px] text-signal-low">
                {formatBytes(v.size_bytes)}
              </td>
              <td className="max-w-[260px] py-3 pr-4 font-mono text-[11px] text-signal-low">
                <span className="line-clamp-1">{v.changelog ?? "—"}</span>
              </td>
              <td className="py-3">
                <a
                  href={v.download_url}
                  className="font-mono text-[11px] lowercase text-signal-high transition hover:brightness-125"
                >
                  download
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
