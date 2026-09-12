/**
 * Settings row: manual update check + install.
 *
 * The global UpdateBanner checks once on launch; this gives the user an
 * explicit "check now" with the running version, without waiting for a
 * restart or a later banner appearance.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

type CheckState =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "error";

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateCheckRow() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<CheckState>("idle");
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const totalRef = useRef<number | undefined>(undefined);
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const runCheck = useCallback(async () => {
    setState("checking");
    setError(null);
    setNewVersion(null);
    updateRef.current = null;
    try {
      const u = await check({ timeout: 15000 });
      if (u) {
        updateRef.current = u;
        setNewVersion(u.version);
        setState("available");
      } else {
        setState("current");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, []);

  const install = useCallback(async () => {
    const u = updateRef.current;
    if (!u) return;
    setState("downloading");
    setDownloaded(0);
    setTotal(undefined);
    totalRef.current = undefined;
    try {
      await u.download((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalRef.current = event.data.contentLength;
          setTotal(event.data.contentLength);
        } else if (event.event === "Progress") {
          setDownloaded((prev) => prev + event.data.chunkLength);
        }
      });
      await u.install();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, []);

  return (
    <div className="flex flex-col gap-1 px-3 py-3 bg-bg-surface">
      <label className="text-xs text-zinc-200">Updates</label>
      <div className="text-[11px] text-zinc-500 leading-snug">
        Running kern {version ? `v${version}` : "…"}. Updates are signed and
        verified before install.
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          onClick={runCheck}
          disabled={state === "checking" || state === "downloading"}
          className="btn-mono disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {state === "checking" ? "checking…" : "check for updates"}
        </button>

        {state === "current" && (
          <span className="text-[11px] text-signal-high">up to date</span>
        )}
        {state === "available" && (
          <>
            <span className="text-[11px] text-warn-vector">
              v{newVersion} available
            </span>
            <button onClick={install} className="btn-mono-primary">
              download &amp; install
            </button>
          </>
        )}
        {state === "downloading" && (
          <span className="text-[11px] text-zinc-400">
            downloading… {formatBytes(downloaded)}
            {total !== undefined && ` / ${formatBytes(total)}`}
          </span>
        )}
        {state === "error" && (
          <span className="text-[11px] text-fault-vector">{error}</span>
        )}
      </div>
    </div>
  );
}
