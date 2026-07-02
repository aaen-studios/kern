/*
  GitHub release fetch for ellipog/kern (WEBSITE_MASTER_PROMPT §4).
  Goal: zero runtime GitHub API calls on the download page — fetch at build
  time, bake into static HTML, revalidate hourly. Server functions return
  null/[] on failure and NEVER throw, so the page never crashes.
*/

export interface Asset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: Asset[];
  body: string;
  published_at: string;
  name?: string;
}

const API = "https://api.github.com/repos/ellipog/kern";
export const RELEASES_PAGE =
  "https://github.com/aaen-studios/kern/releases/latest";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  // GITHUB_TOKEN is optional (server-side only). Raises 60→5000/hr.
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Server-only. Build-time fetch, 1h revalidate. Returns null on failure.
export async function getRelease(): Promise<Release | null> {
  try {
    const res = await fetch(`${API}/releases/latest`, {
      headers: authHeaders(),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Release;
  } catch {
    return null;
  }
}

// First page (5) for the home/landing mini-changelog. Returns [] on failure.
export async function getAllReleases(): Promise<Release[]> {
  try {
    const res = await fetch(`${API}/releases?per_page=5`, {
      headers: authHeaders(),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    return (await res.json()) as Release[];
  } catch {
    return [];
  }
}

// CLIENT-side, paginated, for changelog infinite scroll. No token (public rate
// limit is fine for rare pagination). Returns [] on failure.
export async function getReleasesPage(page: number): Promise<Release[]> {
  try {
    const res = await fetch(
      `${API}/releases?per_page=5&page=${page}`,
      { headers: { Accept: "application/vnd.github.v3+json" } },
    );
    if (!res.ok) return [];
    return (await res.json()) as Release[];
  } catch {
    return [];
  }
}

/*
  Per-platform asset matching (§4.2). Prefer the asset whose name contains the
  version string to avoid grabbing stale assets from older releases.
*/
export function findBestAsset(
  assets: Asset[],
  patterns: string[],
  version: string,
): Asset | undefined {
  const matches = assets.filter((a) =>
    patterns.some((p) => a.name.toLowerCase().includes(p)),
  );
  return (
    matches.find((a) => a.name.includes(version)) ?? // 1. version-tagged filename
    matches.sort((a, b) => b.name.localeCompare(a.name))[0] // 2. newest by name
  );
}

export interface Platform {
  os: "Windows" | "macOS" | "Linux";
  hint: string;
  asset?: Asset;
}

export function getPlatforms(release: Release): Platform[] {
  const version = release.tag_name.replace(/^v/i, "");
  return [
    {
      os: "Windows",
      hint: "nsis installer · x64",
      asset: findBestAsset(release.assets, [".exe", "-setup", "nsis"], version),
    },
    {
      os: "macOS",
      hint: ".dmg · apple silicon + intel",
      asset: findBestAsset(release.assets, [".dmg", ".app.tar.gz"], version),
    },
    {
      os: "Linux",
      hint: ".appimage · .deb",
      asset: findBestAsset(
        release.assets,
        [".appimage", ".deb"],
        version,
      ),
    },
  ];
}

export function formatBytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function formatVersion(tag: string): string {
  return tag.startsWith("v") ? tag : `v${tag}`;
}
