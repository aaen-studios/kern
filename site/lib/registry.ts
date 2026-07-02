/*
  Plugin registry types + accessors. Shaped to mirror the future Cloudflare
  Worker API (§6) so swapping the seed fixture for a live backend is a one-line
  change: replace the body of these functions with fetch() calls to the Worker.
  For now they read the static seed (server-side import → fully static site).
*/
import seed from "@/content/plugins/seed.json";

export type Category =
  | "game-server"
  | "bot"
  | "web"
  | "database"
  | "dev-tool"
  | "other";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "select";
  default?: string;
  options?: string[];
}

export interface PluginVersion {
  version: string;
  "kern-compat"?: string;
  download_url: string;
  sha256?: string;
  size_bytes: number;
  changelog?: string;
  created_at: number;
}

export interface Plugin {
  id: string;
  display_name: string;
  description: string;
  author: string; // GitHub login or 'kern/official' | 'kern/sample'
  category: Category;
  tags: string[];
  config_schema?: ConfigField[];
  versions: PluginVersion[];
  readme_md: string;
  repo_url?: string;
  homepage_url?: string;
  featured?: boolean;
  created_at: number;
  updated_at: number;
  install_count: number;
  rating_sum: number;
  rating_count: number;
}

export const ALL_CATEGORIES: Category[] = [
  "game-server",
  "bot",
  "web",
  "database",
  "dev-tool",
  "other",
];

const plugins = seed.plugins as Plugin[];

export interface PluginQuery {
  q?: string;
  category?: string;
  tag?: string;
  author?: string;
  verified?: boolean;
  sort?: "popular" | "recent" | "rating";
}

export function getPlugins(query: PluginQuery = {}): Plugin[] {
  let result = [...plugins];

  if (query.q) {
    const q = query.q.toLowerCase();
    result = result.filter(
      (p) =>
        p.display_name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)) ||
        p.id.toLowerCase().includes(q),
    );
  }
  if (query.category && query.category !== "all") {
    result = result.filter((p) => p.category === query.category);
  }
  if (query.tag) {
    const tag = query.tag;
    result = result.filter((p) => p.tags.includes(tag));
  }
  if (query.author) {
    result = result.filter((p) => p.author === query.author);
  }
  if (query.verified) {
    result = result.filter((p) => isOfficial(p.author));
  }

  switch (query.sort) {
    case "recent":
      result.sort((a, b) => b.updated_at - a.updated_at);
      break;
    case "rating":
      result.sort((a, b) => avgRating(b) - avgRating(a));
      break;
    case "popular":
    default:
      result.sort((a, b) => b.install_count - a.install_count);
  }
  return result;
}

export function getPlugin(id: string): Plugin | null {
  return plugins.find((p) => p.id === id) ?? null;
}

export function getPluginsByAuthor(author: string): Plugin[] {
  return plugins.filter((p) => p.author === author);
}

export function getPublishers(): { author: string; count: number; official: boolean }[] {
  const map = new Map<string, number>();
  for (const p of plugins) {
    map.set(p.author, (map.get(p.author) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([author, count]) => ({ author, count, official: isOfficial(author) }))
    .sort((a, b) => b.count - a.count);
}

export function getAllTags(): string[] {
  const set = new Set<string>();
  for (const p of plugins) for (const t of p.tags) set.add(t);
  return Array.from(set).sort();
}

export function getPluginIds(): string[] {
  return plugins.map((p) => p.id);
}

export function getAuthors(): string[] {
  return Array.from(new Set(plugins.map((p) => p.author))).sort();
}

// ---- helpers ----

export function isOfficial(author: string): boolean {
  return author === "kern/official" || author === "kern/sample";
}

export function avgRating(p: Plugin): number {
  return p.rating_count === 0 ? 0 : p.rating_sum / p.rating_count;
}

export function latestVersion(p: Plugin): PluginVersion {
  // versions are pre-sorted newest-first in the seed; fall back to max by date.
  if (p.versions.length === 0) {
    return {
      version: "0.0.0",
      download_url: "",
      size_bytes: 0,
      created_at: p.updated_at,
    };
  }
  return p.versions.reduce((a, b) => (b.created_at > a.created_at ? b : a));
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < day) return "today";
  if (diff < day * 30) return `${Math.floor(diff / day)}d ago`;
  if (diff < day * 365) return `${Math.floor(diff / (day * 30))}mo ago`;
  return `${Math.floor(diff / (day * 365))}y ago`;
}
