/*
  Plugin registry types + accessors. Dual-mode:
  - LIVE MODE: queries Supabase (when NEXT_PUBLIC_SUPABASE_URL is set)
  - SEED MODE: reads from seed.json (static fallback, offline builds)

  The public types are shared so pages work identically regardless of source.
*/
import seed from "@/content/plugins/seed.json";

// ── Types ────────────────────────────────────────────────────────

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
  author: string;
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
  /** Live-only: GitHub profile fields (set by API transform) */
  author_github?: string;
  author_avatar?: string;
}

export const ALL_CATEGORIES: Category[] = [
  "game-server",
  "bot",
  "web",
  "database",
  "dev-tool",
  "other",
];

export interface PluginQuery {
  q?: string;
  category?: string;
  tag?: string;
  author?: string;
  verified?: boolean;
  sort?: "popular" | "recent" | "rating" | "upvotes";
}

// ── Seed data (fallback) ─────────────────────────────────────────

const seedPlugins = seed.plugins as Plugin[];

// ── Live functions (Supabase) ────────────────────────────────────

/**
 * True when Supabase env vars are configured → use live mode.
 */
function isLive(): boolean {
  return !!(
    typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/**
 * Fetch plugins from the API (server-side call to our own route).
 * Keeps server components simple: one fetch, fully typed response.
 */
async function fetchFromApi<T>(path: string): Promise<T | null> {
  try {
    const base =
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const res = await fetch(`${base}${path}`, {
      next: { revalidate: 60 }, // ISR: revalidate every 60s
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function mapLivePlugin(raw: Record<string, unknown>): Plugin {
  const versions = (raw.plugin_versions as Record<string, unknown>[] | undefined) ?? [];
  return {
    id: raw.slug as string,
    display_name: raw.display_name as string,
    description: raw.description as string,
    author: (raw.author_github as string) ?? (raw.author as string) ?? "unknown",
    category: raw.category as Category,
    tags: (raw.tags as string[]) ?? [],
    config_schema: raw.config_schema as ConfigField[] | undefined,
    versions: versions.map(mapLiveVersion),
    readme_md: (raw.readme_md as string) ?? "",
    repo_url: (raw.repo_url as string) ?? undefined,
    homepage_url: (raw.homepage_url as string) ?? undefined,
    featured: (raw.featured as boolean) ?? false,
    created_at: new Date(raw.created_at as string).getTime(),
    updated_at: new Date(raw.updated_at as string).getTime(),
    install_count: (raw.install_count as number) ?? 0,
    rating_sum: (raw.upvotes as number) ?? 0, // upvotes → rating_sum for compatibility
    rating_count: 0,
    author_github: (raw.author_github as string) ?? undefined,
    author_avatar: (raw.author_avatar as string) ?? undefined,
  };
}

function mapLiveVersion(raw: Record<string, unknown>): PluginVersion {
  return {
    version: raw.version as string,
    "kern-compat": raw.kern_compat as string | undefined,
    download_url: `/api/download?id=${raw.plugin_id as string}&v=${raw.version as string}`,
    sha256: raw.sha256 as string | undefined,
    size_bytes: (raw.size_bytes as number) ?? 0,
    changelog: (raw.changelog as string) ?? undefined,
    created_at: new Date(raw.created_at as string).getTime(),
  };
}

// ── Public API ───────────────────────────────────────────────────

export async function getPlugins(
  query: PluginQuery = {},
): Promise<Plugin[]> {
  if (isLive()) {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.category && query.category !== "all")
      params.set("category", query.category);
    if (query.tag) params.set("tag", query.tag);
    if (query.author) params.set("author", query.author);
    if (query.verified) params.set("verified", "true");
    if (query.sort) params.set("sort", query.sort);

    const qs = params.toString();
    const data = await fetchFromApi<Record<string, unknown>[]>(
      `/api/plugins${qs ? `?${qs}` : ""}`,
    );
    if (data) return data.map(mapLivePlugin);
    // fallback to seed on fetch failure
  }

  // ── Seed fallback ──────────────────────────────────
  let result = [...seedPlugins];

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
    case "upvotes":
      result.sort((a, b) => b.rating_sum - a.rating_sum);
      break;
    case "popular":
    default:
      result.sort((a, b) => b.install_count - a.install_count);
  }
  return result;
}

export async function getPlugin(id: string): Promise<Plugin | null> {
  if (isLive()) {
    // For live mode we need to fetch all and find by slug, or add a slug endpoint
    const plugins = await getPlugins();
    return plugins.find((p) => p.id === id) ?? null;
  }

  return seedPlugins.find((p) => p.id === id) ?? null;
}

export async function getPluginsByAuthor(
  author: string,
): Promise<Plugin[]> {
  return getPlugins({ author });
}

export async function getPublishers(): Promise<
  { author: string; count: number; official: boolean; avatar?: string }[]
> {
  if (isLive()) {
    const all = await getPlugins();
    const map = new Map<string, { count: number; avatar?: string }>();
    for (const p of all) {
      const key = p.author_github ?? p.author;
      const existing = map.get(key) ?? { count: 0, avatar: p.author_avatar };
      existing.count++;
      map.set(key, existing);
    }
    return Array.from(map.entries())
      .map(([author, info]) => ({
        author,
        count: info.count,
        official: author === "ellipog",
        avatar: info.avatar,
      }))
      .sort((a, b) => b.count - a.count);
  }

  const map = new Map<string, number>();
  for (const p of seedPlugins) {
    map.set(p.author, (map.get(p.author) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([author, count]) => ({
      author,
      count,
      official: isOfficial(author),
    }))
    .sort((a, b) => b.count - a.count);
}

export async function getAllTags(): Promise<string[]> {
  if (isLive()) {
    const all = await getPlugins();
    const set = new Set<string>();
    for (const p of all) for (const t of p.tags) set.add(t);
    return Array.from(set).sort();
  }

  const set = new Set<string>();
  for (const p of seedPlugins) for (const t of p.tags) set.add(t);
  return Array.from(set).sort();
}

export async function getPluginIds(): Promise<string[]> {
  if (isLive()) {
    const all = await getPlugins();
    return all.map((p) => p.id);
  }

  return seedPlugins.map((p) => p.id);
}

export async function getAuthors(): Promise<string[]> {
  if (isLive()) {
    const pubs = await getPublishers();
    return pubs.map((p) => p.author);
  }

  return Array.from(new Set(seedPlugins.map((p) => p.author))).sort();
}

// ── Helpers ──────────────────────────────────────────────────────

export function isOfficial(author: string): boolean {
  return (
    author === "kern/official" ||
    author === "kern/sample" ||
    author === "ellipog"
  );
}

export function avgRating(p: Plugin): number {
  return p.rating_count === 0 ? p.rating_sum : p.rating_sum / p.rating_count;
}

export function latestVersion(p: Plugin): PluginVersion {
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
