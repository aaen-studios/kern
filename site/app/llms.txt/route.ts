import { getAllDocs } from "@/lib/docs";

/*
  /llms.txt — a compact, machine-readable map of the docs for AI tooling
  (llmstxt.org convention). Lists every page plus its raw markdown source.
*/

export const dynamic = "force-static";

export function GET() {
  const docs = getAllDocs();
  const base = "https://kern.aaenz.no";

  const groups = new Map<string, typeof docs>();
  for (const doc of docs) {
    if (!groups.has(doc.group)) groups.set(doc.group, []);
    groups.get(doc.group)!.push(doc);
  }

  const lines: string[] = [
    "# kern",
    "",
    "> kern is a cross-platform desktop server manager (Tauri v2 + Rust + React).",
    "> Register any project folder as a managed server instance, control its lifecycle,",
    "> stream logs and telemetry, and extend it with plugins. Includes a command line",
    "> (`kern-cli`), a loopback automation API, and an optional LAN web remote.",
    ">",
    "> these docs are also packaged as an agent skill: run `npx skills add ellipog/kern-web`",
    "> (or `npm i -D @aaen-studios/kern`). full text in one response: /llms-full.txt",
    "",
    "## docs",
  ];

  for (const [group, entries] of groups) {
    lines.push("", `### ${group}`);
    for (const doc of entries) {
      lines.push(`- [${doc.title}](${base}/docs/${doc.slug}): ${doc.description}`);
    }
  }

  lines.push("", "## raw markdown");
  for (const doc of docs) {
    lines.push(`- [${doc.title}](${base}/raw/docs/${doc.slug})`);
  }
  lines.push("");

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
