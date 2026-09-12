/*
  GitHub release fetch for aaen-studios/kern (WEBSITE_MASTER_PROMPT §4).
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

const API = "https://api.github.com/repos/aaen-studios/kern";
export const KERN_REPO_URL = "https://github.com/aaen-studios/kern";
export const RELEASES_PAGE = `${KERN_REPO_URL}/releases/latest`;
/** Minisign-signed, merged across platforms; consumed by the in-app updater. */
export const UPDATER_MANIFEST_URL = `${KERN_REPO_URL}/releases/latest/download/update.json`;

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
  Artifacts the auto-updater consumes (or non-install files). These must never
  be offered as the human "download" button: the updater zips/tarballs are
  fed to the signed updater, and update.json is a manifest.
*/
const NON_HUMAN_SUFFIXES = [".zip", ".tar.gz", ".dmg.gz", ".sig", ".json"];

function isHumanArtifact(name: string): boolean {
  const lower = name.toLowerCase();
  return !NON_HUMAN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export interface AssetMatch {
  /** Exact filename to prefer (used for version-less names like kern-setup.exe). */
  exact?: string;
  /** Case-insensitive substrings — any match qualifies. */
  includes?: string[];
  /** Case-insensitive substrings that disqualify a candidate. */
  excludes?: string[];
}

/*
  Per-platform asset matching (§4.2).

  kern's release assets changed shape in v0.3.0:
    - windows: `kern-setup.exe` (custom per-user installer, NO version in the
      name) + `kern-setup.exe.zip` (updater artifact)
    - macos:   `kern_<v>_aarch64.dmg` (apple silicon only) + `kern.app.tar.gz`
    - linux:   `kern_<v>_amd64.AppImage` + `.AppImage.tar.gz`
    - cli:     `kern-cli.exe` / `kern-cli`

  Rules: exact filename wins; then version-tagged matches (so a stale asset
  from the same release can't win); updater/non-install artifacts are excluded
  up front. Version-less assets (setup.exe, cli) rely on `exact`.
*/
export function findBestAsset(
  assets: Asset[],
  match: AssetMatch,
  version: string,
): Asset | undefined {
  const lower = (s: string) => s.toLowerCase();
  const usable = assets.filter((a) => {
    if (!isHumanArtifact(a.name)) return false;
    return !match.excludes?.some((x) => lower(a.name).includes(lower(x)));
  });

  if (match.exact) {
    const exact = usable.find((a) => lower(a.name) === lower(match.exact!));
    if (exact) return exact;
  }

  const matches = usable.filter((a) =>
    match.includes?.some((p) => lower(a.name).includes(lower(p))),
  );
  const versionMatches = matches.filter((a) => a.name.includes(version));
  if (versionMatches.length > 0) {
    return versionMatches.sort((a, b) => b.name.localeCompare(a.name))[0];
  }
  // No version-tagged candidate: only fall back to a loose match when the
  // caller deliberately asked for a version-independent asset.
  if (match.exact) return undefined;
  return matches.sort((a, b) => b.name.localeCompare(a.name))[0];
}

export interface Platform {
  os: "Windows" | "macOS" | "Linux";
  hint: string;
  /** Small caveat under the download (e.g. missing architecture). */
  note?: string;
  asset?: Asset;
}

export function getPlatforms(release: Release): Platform[] {
  const version = release.tag_name.replace(/^v/i, "");
  return [
    {
      os: "Windows",
      hint: "per-user installer · x64 · no admin",
      asset: findBestAsset(
        release.assets,
        { exact: "kern-setup.exe", includes: ["setup"] },
        version,
      ),
    },
    {
      os: "macOS",
      hint: "apple silicon (m-series) · dmg",
      note: "no intel build yet",
      asset: findBestAsset(
        release.assets,
        { exact: `kern_${version}_aarch64.dmg`, includes: [".dmg"] },
        version,
      ),
    },
    {
      os: "Linux",
      hint: "appimage · x64",
      note: "no .deb yet",
      asset: findBestAsset(
        release.assets,
        { exact: `kern_${version}_amd64.AppImage`, includes: [".appimage"] },
        version,
      ),
    },
  ];
}

export interface CliAssets {
  windows?: Asset;
  unix?: Asset;
}

/*
  Command-line tools shipped alongside the app. Exact names only — they carry
  no version, so guessing could pick an unrelated asset.
*/
export function getCliAssets(release: Release): CliAssets {
  const exact = (name: string) =>
    release.assets.find((a) => a.name.toLowerCase() === name.toLowerCase());
  return { windows: exact("kern-cli.exe"), unix: exact("kern-cli") };
}

export function formatBytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export function formatVersion(tag: string): string {
  return tag.startsWith("v") ? tag : `v${tag}`;
}
