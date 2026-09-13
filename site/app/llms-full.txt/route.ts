import { getAllDocs } from "@/lib/docs";

/*
  /llms-full.txt — every doc concatenated for one-shot agent ingestion
  (llmstxt.org convention). /llms.txt stays the compact index; the raw
  per-page markdown lives at /raw/docs/<slug>.
*/

export const dynamic = "force-static";

export function GET() {
  const docs = getAllDocs();
  const base = "https://kern.aaenz.no";

  const lines: string[] = [
    "# kern — full documentation",
    "",
    "> every kern doc concatenated for one-shot agent ingestion.",
    `> index: ${base}/llms.txt · skill: npx skills add ellipog/kern-web`,
    "",
  ];

  for (const doc of docs) {
    lines.push(
      `<!-- doc: ${doc.slug} | group: ${doc.group} | source: ${base}/docs/${doc.slug} -->`,
      "",
      doc.body.trim(),
      "",
    );
  }

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
