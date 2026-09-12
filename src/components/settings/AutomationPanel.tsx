/**
 * Automation API panel — shows the loopback endpoint + token for `kern-cli`
 * and scripts, with copy buttons.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../../hooks/useToast";

export interface AutomationInfo {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string;
  token: string;
}

export function AutomationPanel() {
  const { notify } = useToast();
  const [info, setInfo] = useState<AutomationInfo | null>(null);

  const load = useCallback(() => {
    invoke<AutomationInfo>("automation_info")
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    load();
    // The server may still be binding at first paint — refresh shortly after.
    const timer = setTimeout(load, 1500);
    return () => clearTimeout(timer);
  }, [load]);

  if (!info) {
    return (
      <div className="px-3 py-3 bg-bg-surface text-[11px] text-zinc-500">
        loading automation endpoint…
      </div>
    );
  }

  const copy = (value: string, label: string) => {
    navigator.clipboard?.writeText(value);
    notify({ kind: "info", title: "Copied", message: label });
  };

  return (
    <div className="px-3 py-3 bg-bg-surface space-y-3">
      <div>
        <div className="text-xs text-zinc-200">Endpoint</div>
        <div className="mt-0.5 text-[11px] text-zinc-500 leading-snug">
          {info.running ? "listening" : info.enabled ? "not listening (restart kern)" : "disabled"}
          {" · loopback only (127.0.0.1), token-authenticated"}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 truncate bg-bg-core border border-grid-bounds px-2 py-1.5 text-[11px] font-mono text-zinc-300">
            {info.url}
          </code>
          <button
            onClick={() => copy(info.url, info.url)}
            className="px-2 py-1.5 text-[11px] border border-grid-bounds text-zinc-400 hover:text-zinc-200"
          >
            copy
          </button>
        </div>
      </div>

      <div>
        <div className="text-xs text-zinc-200">Token</div>
        <div className="mt-0.5 text-[11px] text-zinc-500 leading-snug">
          Stored in <code className="font-mono">automation.json</code> in the app
          data folder; `kern-cli` reads it automatically.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 truncate bg-bg-core border border-grid-bounds px-2 py-1.5 text-[11px] font-mono text-zinc-300">
            {info.token || "(starting…)"}
          </code>
          <button
            onClick={() => copy(info.token, "automation token")}
            disabled={!info.token}
            className="px-2 py-1.5 text-[11px] border border-grid-bounds text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
          >
            copy
          </button>
        </div>
      </div>

      <div className="text-[11px] text-zinc-600 leading-relaxed">
        CLI examples: <code className="font-mono">kern-cli list</code>,{" "}
        <code className="font-mono">kern-cli start "My Server"</code>,{" "}
        <code className="font-mono">kern-cli logs "My Server" --follow</code>
      </div>
    </div>
  );
}
