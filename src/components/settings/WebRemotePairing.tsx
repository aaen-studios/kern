/**
 * Web remote pairing: shows the LAN URL(s), a QR code embedding the access
 * token, and a rotate button. The token lives in the OS credential vault; this
 * panel is the only place it is displayed.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../../hooks/useToast";

interface WebRemoteInfo {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  urls: string[];
  qrSvg: string;
}

function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export function WebRemotePairing({ enabled }: { enabled: boolean }) {
  const { notify } = useToast();
  const [info, setInfo] = useState<WebRemoteInfo | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="px-3 py-3 bg-bg-surface space-y-3">
      <div className="text-[11px] text-zinc-500 leading-snug">
        Scan this code with your phone, or open one of the URLs and enter the
        token. {info?.running ? "Server is running." : "Restart kern to start the server on the new settings."}
      </div>

      {info?.qrSvg && (
        <img
          src={svgToDataUrl(info.qrSvg)}
          alt="web remote pairing QR code"
          width={180}
          height={180}
          className="border border-grid-bounds"
        />
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
    </div>
  );
}
