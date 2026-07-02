"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ALL_CATEGORIES, type Category, type Plugin } from "@/lib/registry";

export function EditPluginForm({ plugin }: { plugin: Plugin }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(plugin.display_name);
  const [description, setDescription] = useState(plugin.description);
  const [category, setCategory] = useState<Category>(plugin.category);
  const [tags, setTags] = useState(plugin.tags.join(", "));
  const [repoUrl, setRepoUrl] = useState(plugin.repo_url ?? "");
  const [homepageUrl, setHomepageUrl] = useState(plugin.homepage_url ?? "");
  const [readme, setReadme] = useState(plugin.readme_md);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      const res = await fetch(`/api/plugins/${plugin.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName,
          description,
          category,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          repo_url: repoUrl || null,
          homepage_url: homepageUrl || null,
          readme_md: readme,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "failed to save");
      }

      router.push(`/plugins/${plugin.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      {error && (
        <div className="mb-6 bg-fault-vector/10 p-3 ring-1 ring-fault-vector/30">
          <p className="font-mono text-xs text-fault-vector">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-5">
        <Field label="display name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
          />
        </Field>

        <Field label="description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
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
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
          />
        </Field>

        <Field label="repo url">
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
          />
        </Field>

        <Field label="homepage url">
          <input
            value={homepageUrl}
            onChange={(e) => setHomepageUrl(e.target.value)}
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
          />
        </Field>

        <Field label="readme (markdown)">
          <textarea
            value={readme}
            onChange={(e) => setReadme(e.target.value)}
            rows={12}
            className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
          />
        </Field>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="px-4 py-2 font-mono text-xs lowercase text-signal-low transition hover:text-zinc-300"
        >
          cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-signal-high px-4 py-2 font-mono text-xs lowercase text-bg-core transition hover:brightness-110 disabled:opacity-50"
        >
          {saving ? "saving…" : "save changes"}
        </button>
      </div>
    </div>
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
