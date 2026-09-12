/*
  Heading slug + plain-text helpers shared by the markdown renderer, the TOC
  extraction in lib/docs.ts, and search. Kept tiny and dependency-free so the
  server renderer and client TOC always agree on anchor ids.
*/

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Strips the markdown syntax we actually use, for search/excerpts. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/[*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
