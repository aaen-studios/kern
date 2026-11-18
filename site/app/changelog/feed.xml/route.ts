import { getRecentReleases } from "@/lib/github";

/*
  /changelog/feed.xml — Atom feed of GitHub releases, build-cached for an
  hour. Linked from the changelog page via metadata alternates.
*/

export const dynamic = "force-static";
export const revalidate = 3600;

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://kern.aaenz.no";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET() {
  const releases = await getRecentReleases();
  const updated = releases[0]?.published_at ?? new Date().toISOString();

  const entries = releases
    .map(
      (r) => `  <entry>
    <title>${esc(r.name || r.tag_name)}</title>
    <link href="${esc(r.html_url)}"/>
    <id>${esc(r.html_url)}</id>
    <updated>${esc(r.published_at)}</updated>
    <content type="text">${esc(r.body ?? "")}</content>
  </entry>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>kern changelog</title>
  <subtitle>release history for kern — any server, one panel.</subtitle>
  <link href="${BASE}/changelog/feed.xml" rel="self"/>
  <link href="${BASE}/changelog"/>
  <id>${BASE}/changelog</id>
  <updated>${esc(updated)}</updated>
  <author><name>aaen studios</name></author>
${entries}
</feed>
`;

  return new Response(xml, {
    headers: {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
