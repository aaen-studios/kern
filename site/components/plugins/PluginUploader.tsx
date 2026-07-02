"use client";

import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase";
import type { KernManifest } from "@/lib/kern";

/**
 * Drag-and-drop .kern file uploader.
 * Uploads the file to Supabase Storage and returns the manifest + storage path.
 */
export function PluginUploader({
  pluginId,
  version,
  onUploadComplete,
  onError,
}: {
  pluginId: string;
  version: string;
  onUploadComplete: (manifest: KernManifest, storagePath: string, sha256: string, sizeBytes: number) => void;
  onError: (error: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    // Validate extension
    if (!file.name.endsWith(".kern")) {
      onError("only .kern files are accepted");
      return;
    }

    // Validate size (max 50 MB)
    if (file.size > 50 * 1024 * 1024) {
      onError("file must be smaller than 50 MB");
      return;
    }

    setUploading(true);
    setProgress(0);

    try {
      const supabase = createClient();
      const filePath = `${pluginId}/${version}/plugin.kern`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from("plugin-kern")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: true,
        });

      if (uploadError) {
        onError(uploadError.message);
        setUploading(false);
        return;
      }

      setProgress(100);

      // Compute SHA256 (async via SubtleCrypto)
      const sha256 = await computeSHA256(file);

      onUploadComplete(
        { id: pluginId, displayName: "", version, author: "" },
        filePath,
        sha256,
        file.size,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
      onClick={() => inputRef.current?.click()}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed p-8 transition-colors ${
        dragging
          ? "border-signal-high bg-signal-high/5"
          : "border-grid-bounds bg-bg-core hover:border-signal-high/50"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".kern"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      {uploading ? (
        <div className="flex flex-col items-center gap-3">
          <p className="font-mono text-xs text-signal-low">uploading…</p>
          <div className="h-1 w-48 bg-grid-bounds">
            <div
              className="h-full bg-signal-high transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : (
        <>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-signal-low"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className="font-mono text-xs text-signal-low">
            drag & drop your <code className="text-signal-high">.kern</code> file here
          </p>
          <p className="font-mono text-[10px] text-signal-low">or click to browse</p>
        </>
      )}
    </div>
  );
}

/**
 * Compute SHA-256 hash of a file using the Web Crypto API.
 */
async function computeSHA256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
