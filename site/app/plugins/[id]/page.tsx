import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPlugin,
  getPluginIds,
  isOfficial,
  avgRating,
  latestVersion,
  formatRelativeTime,
} from "@/lib/registry";
import { Markdown } from "@/lib/markdown";
import { InstallButton } from "@/components/plugins/InstallButton";
import { ConfigPreview } from "@/components/plugins/ConfigPreview";
import { VersionTable } from "@/components/plugins/VersionTable";
import { Badge, VerifiedBadge } from "@/components/ui/Badge";
import { MatrixDivider } from "@/components/ui/MatrixBorder";
import { SectionHeading } from "@/components/ui/Reveal";
import { UpvoteButton } from "@/components/plugins/UpvoteButton";
import { ReportButton } from "@/components/plugins/ReportButton";

export async function generateStaticParams() {
  const ids = await getPluginIds();
  return ids.map((id) => ({ id }));
}

export async function generateMetadata(
  props: PageProps<"/plugins/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  const plugin = await getPlugin(id);
  if (!plugin) return { title: "not found" };
  return {
    title: plugin.display_name,
    description: plugin.description,
  };
}

export default async function PluginDetailPage(
  props: PageProps<"/plugins/[id]">,
) {
  const { id } = await props.params;
  const plugin = await getPlugin(id);
  if (!plugin) notFound();

  const official = isOfficial(plugin.author);
  const v = latestVersion(plugin);
  const rating = avgRating(plugin);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: plugin.display_name,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Windows, macOS, Linux",
    description: plugin.description,
    author: {
      "@type": "Person",
      name: plugin.author_github ?? plugin.author,
    },
    softwareVersion: v.version,
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: rating.toFixed(1),
      ratingCount: plugin.rating_count || 1,
    },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };

  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-28 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />

      {/* breadcrumb */}
      <nav className="mb-6 font-mono text-[11px] lowercase text-signal-low">
        <Link href="/plugins" className="hover:text-signal-high">
          plugins
        </Link>
        <span className="mx-1">/</span>
        <span className="text-zinc-300">{plugin.id}</span>
      </nav>

      {/* hero */}
      <header className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2">
            <h1 className="font-mono text-3xl lowercase text-zinc-100">
              {plugin.display_name}
            </h1>
            {official && <VerifiedBadge />}
          </div>
          <p className="font-mono text-xs text-signal-low">
            <Link
              href={`/plugins/publishers/${encodeURIComponent(plugin.author_github ?? plugin.author)}`}
              className="hover:text-signal-high"
            >
              {plugin.author_github ?? plugin.author}
            </Link>{" "}
            · {plugin.id} · v{v.version} · updated{" "}
            {formatRelativeTime(plugin.updated_at)}
          </p>
          <p className="mt-4 font-mono text-sm leading-relaxed text-zinc-300">
            {plugin.description}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge tone={official ? "signal" : "muted"}>
              {plugin.category}
            </Badge>
            {plugin.tags.map((t) => (
              <Badge key={t} tone="muted">
                {t}
              </Badge>
            ))}
          </div>
        </div>

        {/* install column */}
        <div className="flex shrink-0 flex-col gap-3 lg:w-64">
          <InstallButton plugin={plugin} size="lg" />
          <div className="flex flex-col gap-2">
            {plugin.repo_url && (
              <a
                href={plugin.repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center bg-bg-surface px-4 py-2 font-mono text-xs lowercase text-zinc-300 ring-1 ring-grid-bounds transition hover:text-signal-high"
              >
                view source
              </a>
            )}
            <a
              href={v.download_url}
              className="inline-flex items-center justify-center bg-bg-surface px-4 py-2 font-mono text-xs lowercase text-zinc-300 ring-1 ring-grid-bounds transition hover:text-signal-high"
            >
              download .kern
            </a>
          </div>
        </div>
      </header>

      <MatrixDivider className="mb-10 opacity-60" />

      {/* gallery — css/svg mock */}
      <section className="mb-12">
        <div
          className="grid aspect-[16/7] place-items-center bg-bg-core"
          style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
        >
          <div className="text-center">
            <div className="mb-3 flex justify-center gap-2 opacity-80">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-2 w-2 rounded-full"
                  style={{
                    background: ["#4cf5a0", "#f5a04c", "#4c525e"][i],
                  }}
                />
              ))}
            </div>
            <p className="font-mono text-[11px] lowercase text-signal-low">
              {plugin.display_name} · preview
            </p>
          </div>
        </div>
      </section>

      {/* about */}
      <section className="mb-12">
        <SectionHeading kicker="about" title={plugin.display_name}>
          {plugin.description}
        </SectionHeading>
        <Markdown content={plugin.readme_md} />
      </section>

      <MatrixDivider className="my-12 opacity-50" />

      {/* config preview */}
      {plugin.config_schema && plugin.config_schema.length > 0 && (
        <section className="mb-12">
          <SectionHeading kicker="config" title="fields you'll set">
            the host renders this form from the plugin&rsquo;s configSchema.
            resolved values become userOverrides for lifecycle + scaffold.
          </SectionHeading>
          <div
            className="bg-bg-surface/40 p-6"
            style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
          >
            <ConfigPreview fields={plugin.config_schema} />
          </div>
        </section>
      )}

      <MatrixDivider className="my-12 opacity-50" />

      {/* versions */}
      <section className="mb-12">
        <SectionHeading kicker="versions" title="version history" />
        <VersionTable versions={plugin.versions} />
      </section>

      <MatrixDivider className="my-12 opacity-50" />

      {/* stats */}
      <section className="mb-12">
        <SectionHeading kicker="stats" title="registry signal" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="installs"
            value={plugin.install_count.toLocaleString()}
          />
          <Stat label="upvotes" value={String(plugin.rating_sum)} />
          <Stat label="versions" value={String(plugin.versions.length)} />
        </div>
      </section>

      {/* upvote + report */}
      <div className="mb-12 flex items-center gap-4">
        <UpvoteButton pluginId={plugin.id} initialUpvotes={plugin.rating_sum} />
        <ReportButton pluginId={plugin.id} pluginName={plugin.display_name} />
      </div>

      {/* trust footer */}
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
