import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllDocs, getDocBySlug } from "@/lib/docs";
import { Markdown } from "@/lib/markdown";
import { MatrixDivider } from "@/components/ui/MatrixBorder";

/*
  Docs catch-all. /docs → overview; /docs/<slug> → that doc.
  Statically prerendered for every authored doc.
*/

export function generateStaticParams() {
  // [overview] represents the index (/docs). the rest are individual docs.
  return [
    { slug: ["overview"] },
    ...getAllDocs()
      .filter((d) => d.slug !== "overview")
      .map((d) => ({ slug: [d.slug] })),
  ];
}

export async function generateMetadata(
  props: PageProps<"/docs/[[...slug]]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const s = slug?.[0] ?? "overview";
  const doc = getDocBySlug(s);
  if (!doc) return { title: "not found" };
  return {
    title: doc.title,
    description: doc.description,
  };
}

export default async function DocPage(props: PageProps<"/docs/[[...slug]]">) {
  const { slug } = await props.params;
  const s = slug?.[0] ?? "overview";
  const doc = getDocBySlug(s);
  if (!doc) notFound();

  const docs = getAllDocs();
  const idx = docs.findIndex((d) => d.slug === doc.slug);
  const prev = idx > 0 ? docs[idx - 1] : null;
  const next = idx >= 0 && idx < docs.length - 1 ? docs[idx + 1] : null;

  const editUrl = `https://github.com/aaen-studios/kern-web/edit/main/content/docs/${doc.slug}.md`;

  return (
    <article>
      <header className="mb-8">
        <p className="font-mono text-xs lowercase text-signal-low">
          {"// "}{doc.group}
        </p>
        <h1 className="mt-2 font-mono text-3xl lowercase text-zinc-100">
          {doc.title}
        </h1>
        <p className="mt-2 font-mono text-xs text-signal-low">{doc.description}</p>
      </header>

      <MatrixDivider className="mb-8 opacity-60" />

      <Markdown content={doc.body} />

      <MatrixDivider className="my-8 opacity-50" />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-4">
          {prev && (
            <Link
              href={`/docs/${prev.slug}`}
              className="font-mono text-[11px] lowercase text-signal-low transition-colors hover:text-signal-high"
            >
              ← {prev.title}
            </Link>
          )}
          {next && (
            <Link
              href={`/docs/${next.slug}`}
              className="font-mono text-[11px] lowercase text-signal-low transition-colors hover:text-signal-high"
            >
              {next.title} →
            </Link>
          )}
        </div>
        <a
          href={editUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[11px] lowercase text-signal-low transition-colors hover:text-signal-high"
        >
          edit on github ↗
        </a>
      </div>
    </article>
  );
}
