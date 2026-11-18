import fs from "node:fs";
import path from "node:path";
import { slugify, stripMarkdown } from "./slug";

/*
  Docs loader. Reads the authored markdown in content/docs/, parses a tiny
  frontmatter (title, group, slug, order, description, updated), and exposes
  typed accessors for the docs hub: sidebar nav, page lookup, heading TOC,
  full-text search sections, and generateStaticParams.
*/

export interface DocMeta {
  title: string;
  group: string;
  slug: string; // single segment, e.g. "manifest-reference"
  order: number;
  description: string;
  /** Optional ISO date rendered as "updated <date>" on the page. */
  updated?: string;
}

export interface Heading {
  id: string;
  text: string;
  level: number;
}

/** One searchable chunk of a doc: the intro or one `##` section. */
export interface SearchSection {
  slug: string;
  title: string;
  group: string;
  heading: string | null;
  id: string | null;
  text: string;
}

export interface Doc extends DocMeta {
  body: string; // markdown without frontmatter
  path: string; // filesystem path
  headings: Heading[];
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
    } else if (
      key === "title" ||
      key === "group" ||
      key === "slug" ||
      key === "description" ||
      key === "updated"
    ) {
      (meta as Record<string, string>)[key] = clean;
    }
  }
  return { meta, body };
}

/** `##`/`###` headings outside code fences, in document order. */
function extractHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.*)$/);
    if (!m) continue;
    const text = stripMarkdown(m[2]);
    const id = slugify(text);
    if (id) out.push({ id, text, level: m[1].length });
  }
  return out;
}

/** Splits a body into the intro + one chunk per `##` heading for search. */
function extractSections(meta: {
  slug: string;
  title: string;
  group: string;
}, body: string, headings: Heading[]): SearchSection[] {
  const lines = body.split("\n");
  const sections: SearchSection[] = [];
  let currentHeading: Heading | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = stripMarkdown(buffer.join("\n"));
    if (text) {
      sections.push({
        slug: meta.slug,
        title: meta.title,
        group: meta.group,
        heading: currentHeading?.text ?? null,
        id: currentHeading?.id ?? null,
        text,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const headingMatch = !inFence && line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      flush();
      const text = stripMarkdown(headingMatch[1]);
      currentHeading =
        headings.find((h) => h.text === text) ?? { id: slugify(text), text, level: 2 };
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
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
      updated: meta.updated,
      body,
      path: full,
      headings: extractHeadings(body),
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

/** Sidebar group order (docs are ordered within each group by `order`). */
const GROUP_ORDER = [
  "Getting started",
  "Using kern",
  "Automation",
  "Plugin development",
  "Architecture",
  "Reference",
];

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
      updated: d.updated,
    });
  }
  return Array.from(groups.entries())
    .map(([group, items]) => ({
      group,
      docs: items.sort((a, b) => a.order - b.order),
    }))
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a.group);
      const bi = GROUP_ORDER.indexOf(b.group);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

/** Full-text index for the sidebar search (intro + per-section chunks). */
export function getSearchSections(): SearchSection[] {
  return getAllDocs().flatMap((doc) =>
    extractSections(
      { slug: doc.slug, title: doc.title, group: doc.group },
      doc.body,
      doc.headings,
    ),
  );
}
