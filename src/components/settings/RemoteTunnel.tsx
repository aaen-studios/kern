/**
 * Cloudflare tunnel settings: quick (random URL) vs named (stable hostname
 * via a connector token). The token is stored in the OS credential vault by
 * the backend; this panel only ever writes it (never reads it back).
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "../../hooks/useToast";

interface TunnelInfo {
  enabled: boolean;
  running: boolean;
  url: string | null;
  error: string | null;
  binaryFound: boolean;
  mode: string;
  hostname: string | null;
  namedTokenSet: boolean;
}

export function RemoteTunnel({
  webRemoteEnabled,
  tunnelEnabled,
  mode,
  hostname,
  onMode,
  onHostname,
}: {
  webRemoteEnabled: boolean;
  tunnelEnabled: boolean;
  mode: string;
  hostname: string;
  onMode: (value: string) => void;
  onHostname: (value: string) => void;
}) {
  const { notify } = useToast();
  const [info, setInfo] = useState<TunnelInfo | null>(null);
  const [token, setToken] = useState("");
  const [host, setHost] = useState(hostname);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setInfo(await invoke<TunnelInfo>("tunnel_info"));
    } catch {
      setInfo(null);
    }
  };

  useEffect(() => {
    if (webRemoteEnabled) void refresh();
  }, [webRemoteEnabled]);

  useEffect(() => {
    if (!webRemoteEnabled) return;
    const pending = listen("kern://tunnel-state", () => void refresh());
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [webRemoteEnabled]);

  useEffect(() => setHost(hostname), [hostname]);

  async function saveNamed() {
    setBusy(true);
    try {
      const next = await invoke<TunnelInfo>("tunnel_set_named", {
        token,
        hostname: host,
      });
      setInfo(next);
      setToken("");
      notify({
        kind: "success",
        title: "named tunnel saved",
        message: host
          ? `stable URL: https://${host.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
          : "add the public hostname from the Cloudflare dashboard to see the QR.",
      });
      onHostname(host);
    } catch (e) {
      notify({ kind: "error", title: "could not save tunnel", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function clearNamed() {
    setBusy(true);
    try {
      setInfo(await invoke<TunnelInfo>("tunnel_clear_named"));
      notify({ kind: "info", title: "named tunnel removed" });
      onMode("quick");
    } catch (e) {
      notify({ kind: "error", title: "could not clear tunnel", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!webRemoteEnabled) return null;

  const named = mode === "named";

  return (
    <div className="flex flex-col gap-3 px-3 py-3 bg-bg-surface border-t border-grid-bounds">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-zinc-500 leading-snug">
          {named
            ? "named tunnel — stable hostname on your domain (Cloudflare dashboard)"
            : "quick tunnel — random trycloudflare.com URL, no account needed"}
        </div>
        {info && (
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.15em] ${
              info.running ? "text-signal-high" : "text-zinc-600"
            }`}
          >
            {info.running ? "tunnel up" : tunnelEnabled ? "off" : "disabled"}
          </span>
        )}
      </div>

      {/* mode selector */}
      <div className="flex gap-1">
        {[
          { key: "quick", label: "quick" },
          { key: "named", label: "named (stable url)" },
        ].map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => onMode(opt.key)}
            className={`px-3 py-1.5 font-mono text-[11px] lowercase border transition-colors ${
              mode === opt.key
                ? "border-signal-high text-signal-high bg-signal-high/10"
                : "border-grid-bounds text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {named && (
        <div className="flex flex-col gap-2 border border-grid-bounds p-3 bg-bg-core">
          <p className="text-[11px] text-zinc-500 leading-snug">
            in the Cloudflare Zero Trust dashboard create a tunnel, add a public
            hostname pointing at{" "}
            <code className="text-zinc-300">https://localhost:7440</code>, then
            paste the connector token here. Optionally protect it with Access.
          </p>
          <label className="text-[10px] uppercase tracking-[0.15em] text-zinc-600">
            connector token {info?.namedTokenSet ? "(saved — paste to replace)" : ""}
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="eyJhIjoi..."
            className="w-full bg-bg-surface border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 font-mono focus:border-signal-low outline-none"
          />
          <label className="text-[10px] uppercase tracking-[0.15em] text-zinc-600">
            public hostname (for the QR + link)
          </label>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="kern.example.com"
            className="w-full bg-bg-surface border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 font-mono focus:border-signal-low outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !token.trim()}
              onClick={() => void saveNamed()}
              className="btn-mono disabled:opacity-40"
            >
              {busy ? "saving…" : "save + start"}
            </button>
            {info?.namedTokenSet && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void clearNamed()}
                className="btn-mono text-fault-vector disabled:opacity-40"
              >
                remove token
              </button>
            )}
          </div>
          <p className="text-[10px] text-zinc-600 leading-snug">
            token kept in the OS credential vault. safe to revoke any time in
            the dashboard.
          </p>
        </div>
      )}

      {info?.error && (
        <p className="text-[11px] text-amber-400 leading-snug">{info.error}</p>
      )}
      {!info?.binaryFound && tunnelEnabled && (
        <p className="text-[11px] text-zinc-500">
          cloudflared binary not found — the pairing panel below can download it.
        </p>
      )}
    </div>
  );
}
