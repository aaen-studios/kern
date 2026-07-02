"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PluginUploader } from "./PluginUploader";
import type { Plugin } from "@/lib/registry";

export function PublishVersionForm({ plugin }: { plugin: Plugin }) {
  const router = useRouter();
  const [version, setVersion] = useState("");
  const [changelog, setChangelog] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [sha256, setSha256] = useState("");
  const [sizeBytes, setSizeBytes] = useState(0);
  const [uploaded, setUploaded] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleUploadComplete = (
    _manifest: { id: string; displayName: string; version: string; author: string },
    path: string,
    sha: string,
    bytes: number,
  ) => {
    setStoragePath(path);
    setSha256(sha);
    setSizeBytes(bytes);
    setUploaded(true);
    setError("");

    // If the uploader returned a version, use it as default if not already set
    if (!version && _manifest.version) {
      setVersion(_manifest.version);
    }
  };

  const handlePublish = async () => {
    if (!version || !storagePath || !sha256) {
      setError("upload a .kern file and enter a version number first");
      return;
    }

    setPublishing(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(`/api/plugins/${plugin.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version,
          kern_compat: "0.1.0",
          storage_path: storagePath,
          sha256,
          size_bytes: sizeBytes,
          changelog: changelog.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "failed to publish version");
      }

      setSuccess(`version ${version} published!`);
      setVersion("");
      setChangelog("");
      setStoragePath("");
      setSha256("");
      setSizeBytes(0);
      setUploaded(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to publish");
    } finally {
      setPublishing(false);
    }
  };

  return (
    <section>
      <h2 className="mb-4 font-mono text-lg lowercase text-zinc-100">
        publish new version
      </h2>

      {error && (
        <div className="mb-4 bg-fault-vector/10 p-3 ring-1 ring-fault-vector/30">
          <p className="font-mono text-xs text-fault-vector">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-4 bg-signal-high/10 p-3 ring-1 ring-signal-high/30">
          <p className="font-mono text-xs text-signal-high">{success}</p>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {/* Version input */}
        <div className="flex flex-col gap-1.5">
          <label className="font-mono text-[11px] lowercase text-signal-low">
            version <span className="text-fault-vector">*</span>
          </label>
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="e.g. 1.1.0"
            disabled={uploaded}
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high disabled:opacity-50"
          />
        </div>

        {/* File upload */}
        <div className="flex flex-col gap-1.5">
          <label className="font-mono text-[11px] lowercase text-signal-low">
            .kern file <span className="text-fault-vector">*</span>
          </label>
          {version ? (
            <PluginUploader
              pluginId={plugin.id}
              version={version}
              onUploadComplete={handleUploadComplete}
              onError={setError}
            />
          ) : (
            <div className="flex cursor-not-allowed flex-col items-center justify-center gap-2 border-2 border-dashed border-grid-bounds bg-bg-core p-8 opacity-50">
              <p className="font-mono text-xs text-signal-low">
                enter a version number above to enable upload
              </p>
            </div>
          )}
          {uploaded && (
            <p className="font-mono text-[10px] text-signal-high">
              file uploaded · sha256: {sha256.slice(0, 16)}…
            </p>
          )}
        </div>

        {/* Changelog */}
        <div className="flex flex-col gap-1.5">
          <label className="font-mono text-[11px] lowercase text-signal-low">
            changelog
          </label>
          <textarea
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            rows={3}
            placeholder="what changed in this release?"
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
          />
        </div>

        {/* Publish button */}
        <button
          onClick={handlePublish}
          disabled={publishing || !uploaded || !version}
          className="self-start bg-signal-high px-6 py-2 font-mono text-xs lowercase text-bg-core transition hover:brightness-110 disabled:opacity-50"
        >
          {publishing ? "publishing…" : "publish version"}
        </button>
      </div>
    </section>
  );
}
