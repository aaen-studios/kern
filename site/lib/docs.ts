import fs from "node:fs";
import path from "node:path";

/*
  Docs loader. Reads the authored markdown in content/docs/, parses a tiny
  frontmatter (title, group, slug, order, description), and exposes typed
  accessors for the docs hub (sidebar nav, page lookup, generateStaticParams).
*/

export interface DocMeta {
  title: string;
  group: string;
  slug: string; // single segment, e.g. "manifest-reference"
  order: number;
  description: string;
}

export interface Doc extends DocMeta {
  body: string; // markdown without frontmatter
  path: string; // filesystem path
}

const DOCS_DIR = path.join(process.cwd(), "content", "docs");

function stripFrontmatter(raw: string): { meta: Partial<DocMeta>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const fm = match[1];
  const body = match[2];
  const meta: Partial<DocMeta> = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    const clean = val.replace(/^["']|["']$/g, "").trim();
    if (key === "order") {
      meta.order = Number(clean);
    } else if (key === "title" || key === "group" || key === "slug" || key === "description") {
      (meta as Record<string, string>)[key] = clean;
    }
  }
  return { meta, body };
}

let cache: Doc[] | null = null;

export function getAllDocs(): Doc[] {
  if (cache) return cache;
  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
  const docs: Doc[] = files.map((file) => {
    const full = path.join(DOCS_DIR, file);
    const raw = fs.readFileSync(full, "utf8");
    const { meta, body } = stripFrontmatter(raw);
    const slug = meta.slug ?? file.replace(/\.md$/, "");
    return {
      title: meta.title ?? slug,
      group: meta.group ?? "Docs",
      slug,
      order: meta.order ?? 99,
      description: meta.description ?? "",
      body,
      path: full,
    };
  });
  docs.sort((a, b) => a.order - b.order);
  cache = docs;
  return docs;
}

export function getDocBySlug(slug: string): Doc | null {
  return getAllDocs().find((d) => d.slug === slug) ?? null;
}

export interface NavGroup {
  group: string;
  docs: DocMeta[];
}

export function getDocNav(): NavGroup[] {
  const docs = getAllDocs();
  const groups = new Map<string, DocMeta[]>();
  for (const d of docs) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group)!.push({
      title: d.title,
      group: d.group,
      slug: d.slug,
      order: d.order,
      description: d.description,
    });
  }
  return Array.from(groups.entries()).map(([group, items]) => ({
    group,
    docs: items.sort((a, b) => a.order - b.order),
  }));
}
