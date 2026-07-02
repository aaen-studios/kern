"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ALL_CATEGORIES,
  type Category,
  type Plugin,
  type ConfigField,
  type Screenshot,
  isOfficial,
  latestVersion,
  formatRelativeTime,
} from "@/lib/registry";
import { Markdown } from "@/lib/markdown";
import { Badge, VerifiedBadge } from "@/components/ui/Badge";
import { MatrixDivider } from "@/components/ui/MatrixBorder";
import { SectionHeading } from "@/components/ui/Reveal";
import { ConfigPreview } from "@/components/plugins/ConfigPreview";
import { ConfigSchemaEditor } from "@/components/plugins/ConfigSchemaEditor";
import { VersionRowEditor } from "@/components/plugins/VersionRowEditor";
import { GalleryEditor } from "@/components/plugins/GalleryEditor";
import { PublishVersionForm } from "@/components/plugins/PublishVersionForm";

export function EditPluginPageClient({
  plugin: initialPlugin,
}: {
  plugin: Plugin;
}) {
  const router = useRouter();

  // ── Editable fields state ────────────────────────────────────────
  const [displayName, setDisplayName] = useState(initialPlugin.display_name);
  const [description, setDescription] = useState(initialPlugin.description);
  const [category, setCategory] = useState<Category>(initialPlugin.category);
  const [tagsInput, setTagsInput] = useState(initialPlugin.tags.join(", "));
  const [repoUrl, setRepoUrl] = useState(initialPlugin.repo_url ?? "");
  const [homepageUrl, setHomepageUrl] = useState(
    initialPlugin.homepage_url ?? "",
  );
  const [readme, setReadme] = useState(initialPlugin.readme_md);
  const [configSchema, setConfigSchema] = useState<ConfigField[]>(
    initialPlugin.config_schema ?? [],
  );
  const [versions, setVersions] = useState(initialPlugin.versions);
  const [screenshots, setScreenshots] = useState<Screenshot[]>(
    initialPlugin.screenshots ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  // Sync versions when plugin prop changes (after publish via router.refresh)
  useEffect(() => {
    setVersions(initialPlugin.versions);
  }, [initialPlugin.versions]);

  // Mark dirty when any field changes
  const markDirty = useCallback(() => setDirty(true), []);

  // ── Derived values ───────────────────────────────────────────────
  const tagsArray = tagsInput
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const official = isOfficial(initialPlugin.author);
  const currentPlugin = {
    ...initialPlugin,
    display_name: displayName,
    description,
    category,
    tags: tagsArray,
    repo_url: repoUrl || undefined,
    homepage_url: homepageUrl || undefined,
    readme_md: readme,
    config_schema: configSchema.length > 0 ? configSchema : undefined,
    screenshots: screenshots.length > 0 ? screenshots : undefined,
    versions,
  };
  const v = latestVersion(currentPlugin);

  // ── Save handler ─────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      const res = await fetch(`/api/plugins/${initialPlugin.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName,
          description,
          category,
          tags: tagsArray,
          repo_url: repoUrl || null,
          homepage_url: homepageUrl || null,
          readme_md: readme,
          config_schema: configSchema.length > 0 ? configSchema : null,
          screenshots: screenshots.length > 0 ? screenshots : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "failed to save");
      }

      setDirty(false);
      router.push(`/plugins/${initialPlugin.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save");
    } finally {
      setSaving(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────
  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-28 sm:px-6">
      {/* ── Sticky edit-mode banner ──────────────────────────────── */}
      <div className="fixed inset-x-0 top-0 z-50 border-b border-grid-bounds/60 bg-bg-core/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1080px] items-center justify-between px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-signal-high/10 px-2 py-1 font-mono text-[11px] lowercase text-signal-high ring-1 ring-signal-high/30">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-high" />
              edit mode
            </span>
            {dirty && (
              <span className="font-mono text-[11px] lowercase text-warn-vector">
                unsaved changes
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <span className="font-mono text-[11px] lowercase text-fault-vector">
                {error}
              </span>
            )}
            <button
              onClick={() => router.back()}
              className="px-3 py-1.5 font-mono text-[11px] lowercase text-signal-low transition hover:text-zinc-300"
            >
              cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-signal-high px-3 py-1.5 font-mono text-[11px] lowercase text-bg-core transition hover:brightness-110 disabled:opacity-50"
            >
              {saving ? "saving…" : "save changes"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Error banner (inline) ───────────────────────────────── */}
      {error && (
        <div className="mb-6 bg-fault-vector/10 p-3 ring-1 ring-fault-vector/30">
          <p className="font-mono text-xs text-fault-vector">{error}</p>
        </div>
      )}

      {/* ── Breadcrumb ──────────────────────────────────────────── */}
      <nav className="mb-6 font-mono text-[11px] lowercase text-signal-low">
        <Link href="/plugins" className="hover:text-signal-high">
          plugins
        </Link>
        <span className="mx-1">/</span>
        <span className="text-zinc-300">{initialPlugin.id}</span>
      </nav>

      {/* ── Hero section ────────────────────────────────────────── */}
      <header className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl flex-1">
          {/* Display name — editable, styled like h1 */}
          <div className="mb-2 flex items-center gap-2">
            <input
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                markDirty();
              }}
              className="w-full bg-transparent font-mono text-3xl lowercase text-zinc-100 outline-none transition-colors focus-visible:text-signal-high"
              placeholder="plugin name"
            />
            {official && <VerifiedBadge />}
          </div>

          {/* Author / ID / version / updated — read-only */}
          <p className="font-mono text-xs text-signal-low">
            <Link
              href={`/plugins/publishers/${encodeURIComponent(initialPlugin.author_github ?? initialPlugin.author)}`}
              className="hover:text-signal-high"
            >
              {initialPlugin.author_github ?? initialPlugin.author}
            </Link>{" "}
            · {initialPlugin.id} · v{v.version} · updated{" "}
            {formatRelativeTime(initialPlugin.updated_at)}
          </p>

          {/* Description — editable textarea */}
          <textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              markDirty();
            }}
            rows={2}
            className="mt-4 w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-zinc-300 outline-none transition-colors focus-visible:text-signal-high placeholder:text-signal-low/40"
            placeholder="short description of what this plugin does"
          />

          {/* Category + Tags — editable */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value as Category);
                markDirty();
              }}
              className="rounded-sm bg-bg-core px-1.5 py-0.5 font-mono text-[11px] text-signal-low ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
            >
              {ALL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            {/* Live tag badges */}
            {tagsArray.map((t) => (
              <Badge key={t} tone="muted">
                {t}
              </Badge>
            ))}

            {/* Tag editor */}
            <input
              value={tagsInput}
              onChange={(e) => {
                setTagsInput(e.target.value);
                markDirty();
              }}
              placeholder="tag1, tag2, ..."
              className="min-w-[120px] bg-transparent font-mono text-[11px] text-signal-low placeholder:text-signal-low/30 outline-none"
            />
          </div>
        </div>

        {/* Right column — repo / homepage URLs */}
        <div className="flex shrink-0 flex-col gap-3 lg:w-64">
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] lowercase text-signal-low">
              repo url
            </label>
            <input
              value={repoUrl}
              onChange={(e) => {
                setRepoUrl(e.target.value);
                markDirty();
              }}
              placeholder="https://github.com/..."
              className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] lowercase text-signal-low">
              homepage url
            </label>
            <input
              value={homepageUrl}
              onChange={(e) => {
                setHomepageUrl(e.target.value);
                markDirty();
              }}
              placeholder="https://example.com"
              className="w-full bg-bg-core px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
            />
          </div>
        </div>
      </header>

      <MatrixDivider className="mb-10 opacity-60" />

      {/* ── Gallery (editable) ──────────────────────────────────── */}
      <section className="mb-12">
        <SectionHeading kicker="gallery" title="screenshots">
          showcase your plugin in action.
        </SectionHeading>
        <GalleryEditor
          pluginId={initialPlugin.id}
          screenshots={screenshots}
          onChange={(next) => {
            setScreenshots(next);
            markDirty();
          }}
        />
      </section>

      <MatrixDivider className="my-12 opacity-50" />

      {/* ── About / Readme (split editor + preview) ─────────────── */}
      <section className="mb-12">
        <SectionHeading kicker="about" title={displayName || initialPlugin.id}>
          {description || "no description yet"}
        </SectionHeading>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Editor */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] lowercase text-signal-low">
              markdown editor
            </label>
            <textarea
              value={readme}
              onChange={(e) => {
                setReadme(e.target.value);
                markDirty();
              }}
              rows={20}
              className="w-full resize-y bg-bg-core p-4 font-mono text-xs leading-relaxed text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              placeholder="write your readme in markdown..."
            />
          </div>

          {/* Live preview */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] lowercase text-signal-low">
              preview
            </label>
            <div
              className="max-h-[520px] min-h-[200px] overflow-y-auto bg-bg-core p-4 ring-1 ring-grid-bounds"
              style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
            >
              {readme.trim() ? (
                <Markdown content={readme} />
              ) : (
                <p className="font-mono text-xs lowercase text-signal-low/60">
                  nothing written yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <MatrixDivider className="my-12 opacity-50" />

      {/* ── Config schema (editable) ────────────────────────────── */}
      <section className="mb-12">
        <SectionHeading kicker="config" title="fields you'll set">
          the host renders this form from the plugin&rsquo;s configSchema.
          resolved values become userOverrides for lifecycle + scaffold.
        </SectionHeading>
        <div
          className="bg-bg-surface/40 p-6"
          style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
        >
          <ConfigSchemaEditor
            fields={configSchema}
            onChange={(next) => {
              setConfigSchema(next);
              markDirty();
            }}
          />

          {/* Live preview of config */}
          {configSchema.length > 0 && (
            <div className="mt-6 border-t border-grid-bounds/60 pt-6">
              <p className="mb-3 font-mono text-[10px] lowercase text-signal-low">
                live preview
              </p>
              <ConfigPreview fields={configSchema} />
            </div>
          )}
        </div>
      </section>

      <MatrixDivider className="my-12 opacity-50" />

      {/* ── Version history (editable) ──────────────────────────── */}
      <section className="mb-12">
        <SectionHeading kicker="versions" title="version history" />
        <VersionRowEditor
          versions={versions}
          pluginId={initialPlugin.id}
          onVersionsChange={(next) => {
            setVersions(next);
            markDirty();
          }}
        />

        {/* Publish new version */}
        <div className="mt-12 border-t border-grid-bounds/60 pt-12">
          <PublishVersionForm plugin={currentPlugin} />
        </div>
      </section>

      <MatrixDivider className="my-12 opacity-50" />

      {/* ── Stats (live) ────────────────────────────────────────── */}
      <section className="mb-12">
        <SectionHeading kicker="stats" title="registry signal" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="installs"
            value={initialPlugin.install_count.toLocaleString()}
          />
          <Stat label="upvotes" value={String(initialPlugin.rating_sum)} />
          <Stat label="versions" value={String(versions.length)} />
          <Stat
            label="updated"
            value={formatRelativeTime(initialPlugin.updated_at)}
          />
        </div>
      </section>

      {/* ── Trust footer ────────────────────────────────────────── */}
      <MatrixDivider className="my-8 opacity-50" />
      <div className="bg-fault-vector/5 p-5 ring-1 ring-fault-vector/30">
        <p className="font-mono text-[11px] lowercase text-fault-vector">
          {"// "}trust
        </p>
        <p className="mt-2 font-mono text-xs text-zinc-200">
          kern plugins run with full local privileges. install only from authors
          you trust.
        </p>
      </div>
    </main>
  );
}

// ── Stat helper (lifted from the detail page) ─────────────────────
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="bg-bg-surface/40 p-4"
      style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
    >
      <p className="font-mono text-lg text-signal-high">{value}</p>
      <p className="font-mono text-[11px] lowercase text-signal-low">
        {label}
      </p>
    </div>
  );
}
