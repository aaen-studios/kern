/**
 * Web remote pairing: shows the LAN URL(s), a QR code embedding the access
 * token, and the Cloudflare quick-tunnel status. The token lives in the OS
 * credential vault; this panel is the only place it is displayed.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "../../hooks/useToast";

interface TunnelInfo {
  enabled: boolean;
  running: boolean;
  url: string | null;
  error: string | null;
  binaryFound: boolean;
  binary: string | null;
  managed: boolean;
  mode: string;
  hostname: string | null;
}

interface WebRemoteInfo {
  enabled: boolean;
  running: boolean;
  bind: string;
  port: number;
  bindError: string | null;
  certSans: string[];
  token: string;
  urls: string[];
  qrSvg: string;
  tunnel: TunnelInfo;
  tunnelQrSvg: string;
}

function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export function WebRemotePairing({
  enabled,
  tunnelEnabled,
}: {
  enabled: boolean;
  tunnelEnabled: boolean;
}) {
  const { notify } = useToast();
  const [info, setInfo] = useState<WebRemoteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await invoke<WebRemoteInfo>("web_remote_info"));
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  // Live status: the backend emits on tunnel/web-remote state changes.
  useEffect(() => {
    if (!enabled) return;
    const pending = [
      listen("kern://tunnel-state", () => void refresh()),
      listen("kern://web-remote-state", () => void refresh()),
    ];
    return () => {
      for (const p of pending) void p.then((unlisten) => unlisten());
    };
  }, [enabled, refresh]);

  // cloudflared download progress (`download:cloudflared:progress`).
  useEffect(() => {
    const pending = listen<{ bytes: number; total: number }>(
      "download:cloudflared:progress",
      (event) => {
        const { bytes, total } = event.payload;
        setDownloadPct(total > 0 ? Math.round((bytes / total) * 100) : null);
      },
    );
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  async function regenerate() {
    setBusy(true);
    try {
      setInfo(await invoke<WebRemoteInfo>("web_remote_regenerate_token"));
      notify({
        kind: "success",
        title: "Token rotated",
        message: "Every paired device must re-scan the QR code.",
      });
    } catch (e) {
      notify({ kind: "error", title: "Could not rotate token", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!info) return;
    try {
      await navigator.clipboard?.writeText(info.token);
      notify({ kind: "info", title: "Token copied" });
    } catch {
      notify({ kind: "error", title: "Clipboard unavailable" });
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard?.writeText(url);
      notify({ kind: "info", title: "URL copied" });
    } catch {
      notify({ kind: "error", title: "Clipboard unavailable" });
    }
  }

  async function downloadBinary() {
    setBusy(true);
    setDownloadPct(0);
    try {
      // `tunnel_download_binary` returns TunnelInfo (not WebRemoteInfo) — never
      // assign it to `info`, or the next render crashes on `info.urls`.
      await invoke("tunnel_download_binary");
      await refresh();
      notify({ kind: "success", title: "cloudflared installed" });
    } catch (e) {
      notify({ kind: "error", title: "Download failed", message: String(e) });
    } finally {
      setBusy(false);
      setDownloadPct(null);
    }
  }

  async function retryTunnel() {
    setBusy(true);
    try {
      await invoke("tunnel_apply");
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "Tunnel restart failed", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <div className="px-3 py-3 bg-bg-surface">
        <p className="text-[11px] text-zinc-500">
          Enable the web remote to pair a phone. A self-signed HTTPS certificate
          is generated on first use; the browser will warn once.
        </p>
      </div>
    );
  }

  const tunnel = info?.tunnel;
  const tunnelLive = !!(tunnelEnabled && tunnel?.running && tunnel.url);

  return (
    <div className="px-3 py-3 bg-bg-surface space-y-3">
      <div className="text-[11px] text-zinc-500 leading-snug">
        Scan this code with your phone, or open one of the URLs and enter the
        token.{" "}
        {info?.running
          ? "Server is running."
          : "Starting the server…"}
      </div>

      {tunnelLive ? (
        <img
          src={svgToDataUrl(info!.tunnelQrSvg)}
          alt="public tunnel pairing QR code"
          width={180}
          height={180}
          className="border border-grid-bounds"
        />
      ) : (
        info?.qrSvg && (
          <img
            src={svgToDataUrl(info.qrSvg)}
            alt="web remote pairing QR code"
            width={180}
            height={180}
            className="border border-grid-bounds"
          />
        )
      )}

      {info && (
        <>
          <ul className="space-y-0.5">
            {info.urls.map((url) => (
              <li key={url} className="text-[11px] text-zinc-300 font-mono">
                {url}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <code className="text-[10px] text-zinc-500 font-mono truncate max-w-[220px]">
              token: {info.token.slice(0, 12)}…
            </code>
            <button onClick={copyToken} className="btn-mono">
              copy token
            </button>
            <button
              onClick={regenerate}
              disabled={busy}
              className="btn-mono disabled:opacity-40"
            >
              rotate token
            </button>
          </div>
        </>
      )}

      {/* ── public access via cloudflare ─────────────────────────────── */}
      <div className="border-t border-grid-bounds pt-3 space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          public access
        </p>

        {!tunnelEnabled && (
          <p className="text-[11px] text-zinc-600">
            Turn on “Expose via Cloudflare tunnel” above to reach this panel
            from anywhere.
          </p>
        )}

        {tunnelEnabled && info && !info.tunnel.binaryFound && (
          <div className="space-y-2">
            <p className="text-[11px] text-zinc-500">
              <span className="text-amber-400">cloudflared not found.</span>{" "}
              Download the official binary into kern&apos;s app data, or install
              it on your PATH.
            </p>
            <button
              onClick={() => void downloadBinary()}
              disabled={busy}
              className="btn-mono disabled:opacity-40"
            >
              {downloadPct !== null
                ? `downloading… ${downloadPct}%`
                : "download cloudflared"}
            </button>
          </div>
        )}

        {tunnelEnabled &&
          info?.tunnel.binaryFound &&
          !info.tunnel.running && (
            <div className="space-y-2">
              <p className="text-[11px] text-zinc-500">
                {busy ? "starting tunnel…" : "tunnel is not running."}
                {info.tunnel.error && (
                  <span className="text-red-400"> {info.tunnel.error}</span>
                )}
              </p>
              <button
                onClick={() => void retryTunnel()}
                disabled={busy}
                className="btn-mono disabled:opacity-40"
              >
                start tunnel
              </button>
            </div>
          )}

        {tunnelLive && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <a
                href={tunnel!.url!}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-signal-high font-mono underline underline-offset-2 break-all"
              >
                {tunnel!.url}
              </a>
              <button
                onClick={() => void copyUrl(tunnel!.url!)}
                className="btn-mono shrink-0"
              >
                copy
              </button>
            </div>
            <p className="text-[10px] text-amber-400/90 leading-snug">
              {tunnel?.mode === "named"
                ? "Anyone with this URL and a paired device token can control your servers. Put Cloudflare Access in front for anything long-lived."
                : "Anyone with this URL and your token can control your servers. Quick tunnels are rate-limited and intended for personal use — turn this off when you're done, or switch to a named tunnel for a stable URL."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
