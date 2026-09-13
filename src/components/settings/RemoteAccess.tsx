/**
 * Web remote access: which interface the panel binds to, the URLs it's
 * reachable at, and the self-signed certificate coverage.
 *
 * Binding lives here (desktop) rather than in the panel itself — a wrong
 * remote bind would strand every paired device until someone reaches the
 * machine locally.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "../../hooks/useToast";

interface InterfaceInfo {
  name: string;
  ip: string;
  /** "loopback" | "private" | "public" */
  kind: string;
}

interface RemoteInfo {
  running: boolean;
  bind: string;
  port: number;
  bindError: string | null;
  certSans: string[];
  urls: string[];
}

const CUSTOM = "__custom__";

export function RemoteAccess({
  enabled,
  bind,
  onBind,
}: {
  enabled: boolean;
  bind: string;
  onBind: (value: string) => void;
}) {
  const { notify } = useToast();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<RemoteInfo>("web_remote_info");
      setInfo(next);
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    void invoke<InterfaceInfo[]>("web_remote_interfaces")
      .then(setInterfaces)
      .catch(() => setInterfaces([]));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, bind, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const pending = listen("kern://web-remote-state", () => void refresh());
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [enabled, refresh]);

  const presets: { value: string; label: string; hint: string }[] = [
    {
      value: "0.0.0.0",
      label: "All interfaces (0.0.0.0)",
      hint: "reachable from your LAN and, with the tunnel, from anywhere",
    },
    {
      value: "127.0.0.1",
      label: "Localhost only (127.0.0.1)",
      hint: "only this machine — pair with a tunnel, or front it with your own reverse proxy",
    },
    ...interfaces
      .filter((i) => i.kind !== "loopback")
      .map((i) => ({
        value: i.ip,
        label: `${i.ip} · ${i.name}`,
        hint: i.kind === "private" ? "private network address" : "public address",
      })),
  ];

  const known = presets.some((p) => p.value === bind);
  const selected = known ? bind : CUSTOM;

  async function regenerateCert() {
    setBusy(true);
    try {
      await invoke("web_remote_regenerate_cert");
      await refresh();
      notify({
        kind: "success",
        title: "certificate regenerated",
        message: "Devices will need to accept the new certificate once.",
      });
    } catch (e) {
      notify({ kind: "error", title: "regenerate failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;

  return (
    <div className="px-3 py-3 bg-bg-surface border-t border-grid-bounds space-y-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-2">
          bind address
        </p>
        <select
          value={selected}
          onChange={(e) => {
            const value = e.target.value;
            if (value === CUSTOM) {
              setCustom(known ? "" : bind);
            } else {
              onBind(value);
            }
          }}
          className="w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100"
        >
          {presets.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value={CUSTOM}>custom address…</option>
        </select>
        <p className="mt-1 text-[10px] text-zinc-600">
          {presets.find((p) => p.value === selected)?.hint ??
            "type an address to bind (e.g. a secondary LAN or VPN interface)"}
        </p>

        {selected === CUSTOM && (
          <div className="mt-2 flex gap-2">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="192.168.1.50"
              className="flex-1 bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 font-mono"
            />
            <button
              type="button"
              disabled={!custom.trim()}
              onClick={() => onBind(custom.trim())}
              className="btn-mono disabled:opacity-40"
            >
              apply
            </button>
          </div>
        )}
      </div>

      {info?.bindError && (
        <p className="text-[11px] text-fault-vector border border-fault-vector/40 bg-fault-vector/5 px-2 py-1 leading-snug">
          {info.bindError}
        </p>
      )}

      {info && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">
            reachable at
          </p>
          {info.urls.length === 0 ? (
            <p className="text-[11px] text-zinc-600">no addresses</p>
          ) : (
            <ul className="space-y-0.5">
              {info.urls.map((url) => (
                <li key={url} className="font-mono text-[11px] text-zinc-300">
                  {url}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[10px] text-zinc-600 leading-snug">
            {info.bind === "0.0.0.0"
              ? "listening on every interface."
              : info.bind === "127.0.0.1"
                ? "loopback only — LAN devices can't connect. use the tunnel or your own reverse proxy."
                : `listening on ${info.bind} only.`}{" "}
            {info.running ? "server is running." : "server is not running."}
          </p>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            certificate
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void regenerateCert()}
            className="btn-mono disabled:opacity-40"
          >
            regenerate
          </button>
        </div>
        <p className="mt-1 text-[10px] text-zinc-600 leading-snug">
          {info?.certSans?.length
            ? `covers: ${info.certSans.join(", ")}`
            : "no certificate recorded yet — one is generated on first start."}
        </p>
        <p className="mt-1 text-[10px] text-zinc-600 leading-snug">
          browsers accept a self-signed certificate once per device. the tunnel
          serves a real Cloudflare certificate instead, so paired phones never
          see the warning over public access.
        </p>
      </div>
    </div>
  );
}
