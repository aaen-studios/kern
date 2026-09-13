import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtAgo } from "../lib/format";
import { navigate } from "../lib/router";
import type { AuditEntry } from "../lib/types";

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const data = await api<{ entries: AuditEntry[] }>("/audit?limit=300");
        if (!disposed) setEntries(data.entries ?? []);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : "failed");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const visible = [...entries]
    .reverse()
    .filter((entry) =>
      filter
        ? `${entry.action} ${entry.detail}`.toLowerCase().includes(filter.toLowerCase())
        : true,
    );

  return (
    <div>
      <button
        onClick={() => navigate("/overview")}
        className="font-mono text-[11px] text-zinc-500 lg:hidden"
      >
        ←
      </button>
      <h1 className="font-mono text-sm uppercase tracking-[0.2em] text-zinc-100">audit</h1>
      <p className="mt-1 font-mono text-[11px] text-zinc-600">
        lifecycle actions, config changes, and remote requests.
      </p>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter…"
        className="mt-3 w-full max-w-xs border border-grid-bounds bg-bg-core px-2 py-1.5 font-mono text-[11px] text-zinc-200"
      />

      {error && <p className="mt-3 font-mono text-xs text-fault-vector">{error}</p>}

      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr className="border-b border-grid-bounds text-left font-mono text-[10px] lowercase text-zinc-600">
            <th className="py-1.5 pr-3 font-normal">when</th>
            <th className="py-1.5 pr-3 font-normal">action</th>
            <th className="py-1.5 pr-3 font-normal">detail</th>
            <th className="hidden py-1.5 font-normal sm:table-cell">server</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((entry, index) => (
            <tr
              key={`${entry.at}:${index}`}
              className="border-b border-grid-bounds/40 font-mono text-[11px]"
            >
              <td className="whitespace-nowrap py-2 pr-3 text-zinc-600">{fmtAgo(entry.at)}</td>
              <td className="whitespace-nowrap py-2 pr-3 text-zinc-300">{entry.action}</td>
              <td className="py-2 pr-3 text-zinc-400">{entry.detail}</td>
              <td className="hidden py-2 text-zinc-600 sm:table-cell">{entry.server_id ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {visible.length === 0 && (
        <p className="mt-4 font-mono text-[11px] text-zinc-600">nothing recorded.</p>
      )}
    </div>
  );
}
