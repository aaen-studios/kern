import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPluginsByAuthor,
  getAuthors,
  isOfficial,
} from "@/lib/registry";
import { PluginCard } from "@/components/plugins/PluginCard";
import { VerifiedBadge } from "@/components/ui/Badge";
import { MatrixDivider } from "@/components/ui/MatrixBorder";

export async function generateStaticParams() {
  const authors = await getAuthors();
  return authors.map((author) => ({ author }));
}

export async function generateMetadata(
  props: PageProps<"/plugins/publishers/[author]">,
): Promise<Metadata> {
  const { author } = await props.params;
  const decoded = decodeURIComponent(author);
  return {
    title: decoded,
    description: `plugins published by ${decoded} on the kern registry.`,
  };
}

export default async function PublisherPage(
  props: PageProps<"/plugins/publishers/[author]">,
) {
  const { author } = await props.params;
  const decoded = decodeURIComponent(author);
  const plugins = await getPluginsByAuthor(decoded);
  if (plugins.length === 0) notFound();

  const official = isOfficial(decoded);

  // Grab avatar from the first plugin that has one
  const avatar = plugins.find((p) => p.author_avatar)?.author_avatar;

  return (
    <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-28 sm:px-6">
      <nav className="mb-6 font-mono text-[11px] lowercase text-signal-low">
        <Link href="/plugins" className="hover:text-signal-high">
          plugins
        </Link>
        <span className="mx-1">/</span>
        <span className="text-zinc-300">{decoded}</span>
      </nav>

      <header className="mb-10">
        <div className="flex items-center gap-3">
          {avatar && (
            <img
              src={avatar}
              alt=""
              className="h-8 w-8 rounded-full ring-1 ring-grid-bounds"
            />
          )}
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-3xl lowercase text-zinc-100">
              {decoded}
            </h1>
            {official && <VerifiedBadge />}
          </div>
        </div>
        <p className="mt-2 font-mono text-xs text-signal-low">
          {official ? "official kern publisher" : "community publisher"} ·{" "}
          {plugins.length} plugin{plugins.length === 1 ? "" : "s"}
        </p>
        {official && (
          <p className="mt-3 max-w-xl font-mono text-xs text-zinc-300">
            verified by kern — these plugins are maintained by the kern team and
            carry the <code className="text-signal-high">verified</code> badge.
          </p>
        )}
      </header>

      <MatrixDivider className="mb-8 opacity-60" />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {plugins.map((p) => (
          <PluginCard key={p.id} plugin={p} />
        ))}
      </div>
    </main>
  );
}
