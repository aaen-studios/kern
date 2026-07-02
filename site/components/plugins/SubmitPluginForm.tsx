"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { ALL_CATEGORIES, type Category } from "@/lib/registry";
import { PluginUploader } from "./PluginUploader";
import type { KernManifest } from "@/lib/kern";

type Step = "upload" | "metadata" | "confirm";

export function SubmitPluginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Upload state
  const [manifest, setManifest] = useState<KernManifest | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [sha256, setSha256] = useState("");
  const [sizeBytes, setSizeBytes] = useState(0);

  // Metadata state (pre-filled from manifest, editable)
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Category>("other");
  const [tags, setTags] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [homepageUrl, setHomepageUrl] = useState("");
  const [readme, setReadme] = useState("");

  const handleUploadComplete = (
    m: KernManifest,
    path: string,
    sha: string,
    bytes: number,
  ) => {
    setManifest(m);
    setStoragePath(path);
    setSha256(sha);
    setSizeBytes(bytes);

    // Pre-fill from manifest
    setSlug(m.id?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ?? "");
    setDisplayName(m.displayName ?? "");
    setDescription(m.description ?? "");
    setCategory((m.category as Category) ?? "other");
    setTags((m.tags ?? []).join(", "));
    setRepoUrl(m.repoUrl ?? "");
    setHomepageUrl(m.homepageUrl ?? "");
    setReadme("");

    setStep("metadata");
  };

  const handleSubmit = async () => {
    if (!slug || !displayName || !description) {
      setError("slug, display name, and description are required");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError("you must be signed in to publish a plugin");
        setSubmitting(false);
        return;
      }

      // Create the plugin listing
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          display_name: displayName,
          description,
          category,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          repo_url: repoUrl || undefined,
          homepage_url: homepageUrl || undefined,
          readme_md: readme || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "failed to create plugin");
      }

      const plugin = await res.json();

      // Create the first version
      const versionRes = await fetch(`/api/plugins/${plugin.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: manifest?.version ?? "1.0.0",
          kern_compat: "0.1.0",
          storage_path: storagePath,
          sha256,
          size_bytes: sizeBytes,
          changelog: "Initial release.",
        }),
      });

      if (!versionRes.ok) {
        const data = await versionRes.json();
        throw new Error(data.error ?? "failed to create version");
      }

      // Redirect to the new plugin page
      router.push(`/plugins/${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      {/* Step indicator */}
      <div className="mb-8 flex items-center gap-2 font-mono text-[11px] lowercase text-signal-low">
        <StepDot active={step === "upload"} done={step !== "upload"} label="upload" />
        <span className="text-grid-bounds">——</span>
        <StepDot active={step === "metadata"} done={step === "confirm"} label="details" />
        <span className="text-grid-bounds">——</span>
        <StepDot active={step === "confirm"} done={false} label="publish" />
      </div>

      {error && (
        <div className="mb-6 bg-fault-vector/10 p-3 ring-1 ring-fault-vector/30">
          <p className="font-mono text-xs text-fault-vector">{error}</p>
        </div>
      )}

      {step === "upload" && (
        <div>
          <h2 className="mb-2 font-mono text-lg lowercase text-zinc-100">
            upload your .kern file
          </h2>
          <p className="mb-6 font-mono text-xs text-signal-low">
            we&apos;ll extract the manifest to pre-fill the details.
          </p>
          <PluginUploader
            pluginId="new"
            version="1.0.0"
            onUploadComplete={handleUploadComplete}
            onError={setError}
          />
        </div>
      )}

      {step === "metadata" && (
        <div>
          <h2 className="mb-6 font-mono text-lg lowercase text-zinc-100">
            plugin details
          </h2>

          <div className="flex flex-col gap-5">
            <Field label="slug">
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="my-awesome-plugin"
                className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </Field>

            <Field label="display name">
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="My Awesome Plugin"
                className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </Field>

            <Field label="description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="what does your plugin do?"
                className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </Field>

            <Field label="category">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              >
                {ALL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="tags (comma-separated)">
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="minecraft, java, paper"
                className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </Field>

            <Field label="repo url (optional)">
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/you/plugin"
                className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </Field>

            <Field label="homepage url (optional)">
              <input
                value={homepageUrl}
                onChange={(e) => setHomepageUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </Field>
          </div>

          <div className="mt-8 flex items-center gap-3">
            <button
              onClick={() => setStep("upload")}
              className="px-4 py-2 font-mono text-xs lowercase text-signal-low transition hover:text-zinc-300"
            >
              back
            </button>
            <button
              onClick={() => setStep("confirm")}
              disabled={!slug || !displayName || !description}
              className="bg-signal-high px-4 py-2 font-mono text-xs lowercase text-bg-core transition hover:brightness-110 disabled:opacity-50"
            >
              review & publish
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <div>
          <h2 className="mb-6 font-mono text-lg lowercase text-zinc-100">
            review & publish
          </h2>

          <div className="flex flex-col gap-3 bg-bg-surface p-5 ring-1 ring-grid-bounds">
            <Row label="slug" value={slug} />
            <Row label="name" value={displayName} />
            <Row label="description" value={description} />
            <Row label="category" value={category} />
            <Row label="tags" value={tags} />
            <Row label="version" value={manifest?.version ?? "1.0.0"} />
            <Row label="file size" value={`${(sizeBytes / 1024).toFixed(1)} KB`} />
            <Row label="sha256" value={sha256.slice(0, 16) + "…"} />
          </div>

          <p className="mt-4 font-mono text-[11px] text-signal-low">
            by publishing, you confirm this plugin is safe and follows the kern
            registry guidelines.
          </p>

          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={() => setStep("metadata")}
              className="px-4 py-2 font-mono text-xs lowercase text-signal-low transition hover:text-zinc-300"
            >
              back
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-signal-high px-6 py-2 font-mono text-xs lowercase text-bg-core transition hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? "publishing…" : "publish plugin"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <span className={`flex items-center gap-1 ${done ? "text-signal-high" : active ? "text-zinc-300" : "text-signal-low"}`}>
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          done ? "bg-signal-high" : active ? "bg-zinc-300" : "bg-signal-low"
        }`}
      />
      {label}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] lowercase text-signal-low">
        {label}
      </span>
      {children}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[11px] lowercase text-signal-low">
        {label}
      </span>
      <span className="font-mono text-xs text-zinc-300">{value}</span>
    </div>
  );
}
