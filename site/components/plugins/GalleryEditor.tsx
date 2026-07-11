"use client";

import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase";
import type { Screenshot } from "@/lib/registry";
import { StatusDots } from "@/components/ui/StatusDots";

const MAX_SCREENSHOTS = 4;

/*
  Editable screenshot gallery. Grid of up to 4 slots.
  Click to upload images. Shows thumbnails, allows remove/replace.
  Images are uploaded to Supabase Storage.
*/

export function GalleryEditor({
  pluginId,
  screenshots,
  onChange,
}: {
  pluginId: string;
  screenshots: Screenshot[];
  onChange: (screenshots: Screenshot[]) => void;
}) {
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleUpload = async (index: number, file: File) => {
    // Validate image type
    if (!file.type.startsWith("image/")) {
      return;
    }

    setUploadingIndex(index);

    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop() ?? "png";
      // eslint-disable-next-line react-hooks/purity -- called from event handler only, not render
      const filePath = `${pluginId}/screenshots/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("plugin-assets")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: true,
        });

      if (uploadError) throw new Error(uploadError.message);

      // Get public URL
      const { data: urlData } = supabase.storage
        .from("plugin-assets")
        .getPublicUrl(filePath);

      const url = urlData?.publicUrl ?? "";
      if (!url) throw new Error("failed to get public url");

      const next = [...screenshots];
      next[index] = { url, alt: file.name.replace(/\.[^/.]+$/, "") };
      onChange(next);
    } catch (err) {
      console.error("screenshot upload error:", err);
    } finally {
      setUploadingIndex(null);
    }
  };

  const handleRemove = (index: number) => {
    onChange(screenshots.filter((_, i) => i !== index));
  };

  const handleReplace = (index: number) => {
    inputRefs.current[index]?.click();
  };

  // Pad to MAX_SCREENSHOTS with empty slots for visual grid
  const padded: (Screenshot | null)[] = [...screenshots];
  while (padded.length < MAX_SCREENSHOTS) {
    padded.push(null);
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {padded.map((slot, i) => (
        <div
          key={i}
          className="relative aspect-video overflow-hidden bg-bg-core ring-1 ring-grid-bounds"
        >
          {slot ? (
            // Filled slot
            <>
              <img
                src={slot.url}
                alt={slot.alt ?? ""}
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 opacity-0 transition-opacity hover:opacity-100">
                <button
                  onClick={() => handleReplace(i)}
                  className="rounded-sm bg-signal-high/20 px-2 py-1 font-mono text-[10px] lowercase text-signal-high ring-1 ring-signal-high/40 transition hover:brightness-125"
                >
                  replace
                </button>
                <button
                  onClick={() => handleRemove(i)}
                  className="rounded-sm bg-fault-vector/20 px-2 py-1 font-mono text-[10px] lowercase text-fault-vector ring-1 ring-fault-vector/40 transition hover:brightness-125"
                >
                  remove
                </button>
              </div>
            </>
          ) : (
            // Empty slot — upload area
            <button
              onClick={() => inputRefs.current[i]?.click()}
              disabled={uploadingIndex === i}
              className="flex h-full w-full flex-col items-center justify-center gap-1 transition hover:bg-bg-surface/60 disabled:opacity-50"
            >
              <input
                ref={(el) => {
                  inputRefs.current[i] = el;
                }}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload(i, file);
                  e.target.value = "";
                }}
              />
              {uploadingIndex === i ? (
                <StatusDots status="breathe" label="uploading screenshot" count={3} />
              ) : (
                <>
                  <span className="text-lg text-signal-low">+</span>
                  <span className="font-mono text-[10px] lowercase text-signal-low">
                    add screenshot
                  </span>
                </>
              )}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
