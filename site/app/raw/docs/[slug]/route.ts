import { readFileSync } from "node:fs";
import { getAllDocs, getDocBySlug } from "@/lib/docs";

/*
  Raw markdown for every doc — the same bytes an author committed, frontmatter
  included. Lets agents and scripts consume the source without scraping HTML,
  and backs the /llms.txt index.

  Statically generated for every authored doc.
*/

export const dynamic = "force-static";

export function generateStaticParams() {
  return getAllDocs().map((doc) => ({ slug: doc.slug }));
}

export async function GET(
  _request: Request,
  { params }: RouteContext<"/raw/docs/[slug]">,
) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) {
    return new Response("not found", { status: 404 });
  }
  const raw = readFileSync(doc.path, "utf8");
  return new Response(raw, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
