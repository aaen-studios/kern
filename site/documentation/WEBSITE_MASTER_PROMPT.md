# kern — Website & Plugin Registry Master Prompt

> Paste this entire document into your AI coding agent (or hand it to a developer) to build
> **kern.app** — the marketing site, docs hub, GitHub-Releases-backed download flow, and a
> live plugin browser/registry for the kern desktop app.
>
> This brief is **self-contained**: it contains every brand value, API shape, file format, and
> architectural decision you need. You do **not** need to read the kern source code to execute it.
> Where exact values matter (color hexes, manifest fields, endpoint shapes), they are given verbatim.

---

## 0. Role & how to use this prompt

You are building **kern.app**, the public website for the **kern** desktop application. Your output is a
production-ready Next.js application plus a Cloudflare-hosted plugin registry backend.

### Build order (follow strictly)
1. **Design system first** (§3) — tokens, fonts, matrix borders, ported shaders. Everything else inherits this.
2. **Landing page** (§10) — hero, feature sections, footer.
3. **Download flow** (§4) — GitHub release fetch + platform cards.
4. **Docs hub** (§8) — surface existing markdown.
5. **Changelog + community** (§9).
6. **Plugin browser front-end** (§7) — against the catalog API.
7. **Plugin registry backend** (§6) — Cloudflare D1 + R2 + Workers, OAuth publish flow.

### Hard rules
- **Never invent brand values.** Use only the tokens, fonts, and copy voice in §3. No new accent hues.
- **Color is semantic.** Green = running/active/CTA, amber = transitional/warn, crimson = error, gray = standby. Never decorative.
- **Copy is lowercase, terse, technical, monospace-flavored.** See §3.6 for examples.
- **Static-first.** All marketing/docs/download content must build to static HTML. Only the plugin registry has a live backend.
- **The canonical GitHub repo is `ellipog/kern`.** Use it everywhere, consistently. (Do not mix org names.)
- **Accessibility is non-negotiable.** Gate all shader/animation on `prefers-reduced-motion`. Provide skip links, visible focus, and ARIA on decorative canvas regions.

### When to stop and ask
If something is genuinely ambiguous and changes architecture (auth provider choice, domain name, whether to ship Phase A or Phase B of the registry first), **ask the user** rather than guessing. Do not ask about purely cosmetic decisions — defer to §3.

---

## 1. Project context

### 1.1 What is kern?
**kern** (always lowercase) is a **cross-platform (Windows, macOS, Linux) desktop server manager** built with
Tauri v2 (Rust backend + React frontend). Think of it as a self-hosted alternative to cloud game-panel tools
(Pterodactyl, AMP, PufferPanel) — but as a **native desktop app** driven by a **plugin system** that teaches it
how to run each kind of server.

> **One-line positioning:** kern turns any folder on your computer into a managed server instance —
> with a live terminal, telemetry, and graceful lifecycle — and you teach it new server types by installing plugins.

Internal codename / document title: **"Lightweight Extensible Server Panel Host."**

### 1.2 What it does (the features the site must sell)
- **Server registry** — register any project folder as a "server instance." Full CRUD, orphaned-state detection
  (if a folder is moved/deleted, the instance is flagged "orphaned" rather than silently dropped).
- **Lifecycle controls** — Start / Stop / Restart / Install, driven by each plugin's `lifecycle` manifest block.
  Graceful shutdown with a **15-second timeout** before hard-kill — deliberately tuned so *Minecraft world saves
  complete* (chunk flush + level.dat) before teardown.
- **Live terminal** — process stdout/stderr streamed live to the UI, appended to `<instance>/latest.log`, with
  full **ANSI color parsing**, dimmed timestamps, command history (Up/Down), and a scroll-to-bottom affordance.
  The input box doubles as a command dispatcher (`start`/`stop`/`restart`/`install` trigger lifecycle; other input is piped to stdin).
- **Per-process telemetry** — real-time **CPU + RAM per instance** via `sysinfo`, surfaced as a "reactor channel"
  matrix bar that turns amber >90% CPU and red on fault.
- **In-app file editor** — Monaco editor with a file tree, tabbed multi-file editing, path-traversal protection,
  and drag-and-drop copy from the OS.
- **Signed auto-updates** — in-app updater pulling signed archives from GitHub Releases (minisign).
- **Backups** — Minecraft world backup/restore.

### 1.3 The killer feature: plugins
The app is intentionally generic. **Plugins teach it how to run each type of server.** A plugin is a `.kern`
file (a zip containing `manifest.json` + an optional `dist/` UI bundle). The host renders each plugin's config
form dynamically from a `configSchema`, runs its declared `lifecycle` commands, and mounts its UI bundle inside
an **isolated Shadow DOM** so plugin styles never bleed. This is the heart of the product and the centerpiece of
the website (see §5–7).

### 1.4 First-party sample plugins (use as social proof)
- **Minecraft Java Server** (`minecraft_java`, v1.2.0, author `kern/sample`) — supports **7 server softwares**:
  vanilla, paper, purpur, fabric, forge, neoforge, quilt. Auto-downloads the correct JAR/installer, accepts EULA,
  edits `server.properties`, manages whitelist/ops/bans, and backs up worlds. Adds "Setup" and "Chat" tabs.
- **Discord Bot Manager** (`discord_bot`, v1.2.0, author `kern/sample`) — supports **4 runtimes**: Node.js, Bun,
  Deno, Rust. Runtime-conditional scaffolding generates the right starter files.

### 1.5 Target audience
Self-hosters and hobbyists running their own game servers (especially Minecraft), Discord/automation bots, and
local dev servers/APIs — people who currently juggle a pile of terminal windows, `.bat`/`.sh` scripts, and
folder shortcuts. Secondary: plugin developers (the docs hub and registry are for them).

### 1.6 Tech stack of the app (for reference / "built with" colophon)
Tauri 2 · Rust (`sysinfo`, `ureq`, `zip`, `walkdir`) · React 19 · Tailwind CSS 4 · TypeScript · Vite 7 ·
Monaco Editor · Bun (package manager + dev). Cross-platform via `deploy.sh` (NSIS on Windows, `.dmg` on macOS,
`.AppImage`/`.deb` on Linux).

### 1.7 Site goals
1. **Convert** visitors to downloads (Windows first; macOS/Linux as available).
2. **Educate** plugin developers (docs hub).
3. **Grow the ecosystem** (the plugin registry/browser — the differentiator vs. every other panel tool).
4. **Build trust** (changelog, signed updates, transparent roadmap, community links).

---

## 2. Tech stack (prescribed for the website)

| Layer | Choice | Why |
|---|---|---|
| **Framework** | **Next.js** (App Router, latest) | RSC for build-time GitHub fetch; static-capable; proven pattern (adapted from a sibling project). |
| **Styling** | **Tailwind CSS 4** | Matches kern's own stack; lets you import its design tokens verbatim (see §3). |
| **Language** | **TypeScript** (strict) | Non-negotiable. |
| **Content** | MDX for docs (source = existing markdown in `documentation/`) | Reuse what exists; add code-block + callout components. |
| **Animation** | Framer Motion + CSS keyframes | For section reveals; the brand shaders are pure canvas/CSS (§3.5). |
| **Markdown rendering** | Zero-dependency renderer (see §9.3) | GitHub release notes only need a tiny subset. |
| **Deployment (site)** | **Vercel** (free tier) | Auto-detects Next.js; ideal for build-time release fetch. |
| **Plugin registry backend** | **Cloudflare Workers + D1 + R2** (all free tier) | See §6 — zero-egress blob storage is the killer feature for a download host. |

### Environment variables
```
GITHUB_TOKEN          # fine-grained PAT, server-side release fetch (raises API limit 60→5000/hr)
CF_ACCOUNT_ID         # Cloudflare account
D1_DATABASE_ID        # plugin catalog database
R2_BUCKET_KERN        # .kern blob storage bucket
GITHUB_OAUTH_CLIENT_ID / _SECRET   # publish-flow auth (Phase B)
KERN_REGISTRY_API_KEY # optional admin/moderation key
```
Put `GITHUB_TOKEN` in the Vercel build env and Cloudflare Worker secrets. **Never commit it.** Add `.env*` to `.gitignore`.

---

## 3. Brand & design system (verbatim from kern)

> Source of truth: `documentation/DesignGuide.md` and `src/styles/global.css`. These are the **exact** values;
> reproduce them in the site's Tailwind theme.

### 3.1 Identity — "Signal Radar"
The kern mark is a **glowing green signal-radar / emission-core**: a bright signal-green core with concentric
rings of green dots on a near-black rounded square, with a soft green radial bloom. The simplified single-ring
variant is used at small sizes. Reproduce as inline SVG; animate the rings for the hero (§3.5, §10).

### 3.2 Color tokens (CSS / Tailwind)
Use these as Tailwind theme colors (`bg-bg-core`, `text-signal-high`, `border-grid-bounds`, etc.). **No other hues.**

| Token | Hex | Meaning |
|---|---|---|
| `bg-core` | `#050506` | Absolute base background (near-black). Page background. |
| `bg-surface` | `#0B0C10` | Cards, panels, elevated surfaces. |
| `grid-bounds` | `#161920` | Inactive dots, dotted dividers, scrollbar thumbs. |
| `signal-high` | `#4CF5A0` | **Primary brand accent — signal green.** Running/active/primary CTA. |
| `signal-low` | `#4C525E` | Standby / offline / muted text. |
| `warn-vector` | `#F5A04C` | Warnings / transitional states (amber). |
| `fault-vector` | `#F54C4C` | Errors / terminated (crimson). |

Body text default: Tailwind `zinc-300` over `bg-core`.

Tailwind theme block to drop into `globals.css`:
```css
@import "tailwindcss";

@theme {
  --color-bg-core: #050506;
  --color-bg-surface: #0b0c10;
  --color-grid-bounds: #161920;
  --color-signal-high: #4cf5a0;
  --color-signal-low: #4c525e;
  --color-warn-vector: #f5a04c;
  --color-fault-vector: #f54c4c;
  --font-mono: "JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace;
}
```

### 3.3 Typography
- **One family, everywhere:** `--font-mono` = `"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace`.
  Consider self-hosting JetBrains Mono for performance; otherwise the system mono fallback is fine. **No sans-serif, no web-font serifs.**
- **Base size 13px**, `line-height: 1.4`, antialiased.
- Headings: same family, heavier weight / larger size — **not** a different family. Keep them lowercase and terse.

### 3.4 Layout primitives
- **4px spacing grid.** All padding/gaps in multiples of 4.
- **Dotted-matrix boundaries instead of solid lines.** Implement as a utility:
  ```css
  @utility matrix-border {
    background-image: radial-gradient(#161920 1px, transparent 1px);
    background-size: 6px 6px;
    background-repeat: repeat;
    background-position: center;
  }
  ```
  Use this for section dividers, card outlines, and table separators. **Avoid solid 1px borders** except for focus rings.
- **Thin scrollbars:** 6px wide, `grid-bounds` thumb, transparent track, `signal-low` on hover.
- **Content max-width:** ~960–1100px for marketing; ~820px for prose/docs.

### 3.5 The signature motif — dot-matrix / radar shaders
kern renders status as **arrays of light-emitting micro-nodes driven by pure-math shader functions**
(`polarRadar`, `sineRipple`, `reactorChannel` in the app's `src/components/matrix/`). This is the
brand-defining visual. **Port it to the web** as the hero background and as decorative section accents:

- **Hero:** an animated radar/signal-radar canvas behind the headline — a green core with concentric rings of
  dots, a slow rotating sweep, and traveling dot-waves. Dim, low-opacity, never competes with text.
- **Status chips & "running" indicators:** a row of dots using these keyframes (lift verbatim from the app):
  ```css
  /* green — traveling wave (running) */
  @keyframes dot-wave   { 0%,100% { opacity:.2 } 50% { opacity:1 } }
  /* amber — slow breathe (starting/installing) */
  @keyframes dot-breathe{ 0%,100% { opacity:.25 } 50% { opacity:.85 } }
  /* crimson — rapid blink (error) */
  @keyframes dot-blink  { 0%,100% { opacity:.3 } 50% { opacity:1 } }
  ```
  Stagger `animation-delay` per dot to create the wave.
- **Section accents:** a faint static dot-grid (the `matrix-border` pattern at low opacity) behind feature blocks.
- **Performance & a11y:** render shaders on `<canvas>` or CSS only (no heavy libs); **pause/hide under `prefers-reduced-motion`**; mark decorative canvases `aria-hidden="true"`.

### 3.6 Copy voice
**Lowercase, terse, technical, monospace-flavored.** No exclamation marks. No marketing fluff. Use real
domain nouns. Examples lifted directly from the app UI to match tone:
- `registry (3)` · `+ new` · `latest.log` · `reactor` · `orphan`
- `no instances registered` · `no output yet — start the instance to begin streaming`
- Section headings like: `signal radar` · `live terminal` · `reactor channel` · `lifecycle` · `plugins` · `auto-update`

Buttons: lowercase verbs — `download`, `view on github`, `install in kern`, `read the docs`, `browse plugins`.

---

## 4. GitHub release / download flow

> Adapt the proven pattern from a sibling Next.js site. The goal: **zero runtime GitHub API calls on the
> download page** — fetch at build time, bake into static HTML, revalidate hourly.

### 4.1 Release-fetch library — `lib/github.ts`
Reimplement this (pointed at `ellipog/kern`, not galdr):
```ts
export interface Asset  { name: string; browser_download_url: string; size: number; }
export interface Release{ tag_name: string; html_url: string; assets: Asset[]; body: string; published_at: string; }

const API = "https://api.github.com/repos/ellipog/kern";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Server-only. Build-time fetch, 1h revalidate. Returns null on failure (never throws).
export async function getRelease(): Promise<Release | null> {
  try {
    const res = await fetch(`${API}/releases/latest`, { headers: authHeaders(), next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// First page (5) for the home/landing mini-changelog.
export async function getAllReleases(): Promise<Release[]> {
  try {
    const res = await fetch(`${API}/releases?per_page=5`, { headers: authHeaders(), next: { revalidate: 3600 } });
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

// CLIENT-side, paginated, for changelog infinite scroll. No token (public rate limit is fine for rare pagination).
export async function getReleasesPage(page: number): Promise<Release[]> {
  const res = await fetch(`${API}/releases?per_page=5&page=${page}`, { headers: { Accept: "application/vnd.github.v3+json" } });
  if (!res.ok) return [];
  return res.json();
}
```

### 4.2 Per-platform asset matching
Render **one card per OS** (Windows / macOS / Linux). Match assets by substring; **prefer the asset whose name
contains the version string** to avoid grabbing stale assets from older releases. Degrade to "Not available yet"
with a fallback link to the GitHub releases page.

```ts
function findBestAsset(assets: Asset[], patterns: string[], version: string): Asset | undefined {
  const matches = assets.filter(a => patterns.some(p => a.name.toLowerCase().includes(p)));
  return matches.find(a => a.name.includes(version))          // 1. version-tagged filename
     ?? matches.sort((a,b) => b.name.localeCompare(a.name))[0]; // 2. newest by name
}

function getPlatforms(release: Release) {
  const version = release.tag_name.replace(/^v/i, "");
  return [
    { os: "Windows", asset: findBestAsset(release.assets, [".exe", "-setup", "nsis"], version) },
    { os: "macOS",   asset: findBestAsset(release.assets, [".dmg", ".app.tar.gz"], version) },
    { os: "Linux",   asset: findBestAsset(release.assets, [".appimage", ".deb"], version) },
  ];
}
```
> Note: kern ships a Windows **NSIS** installer (`kern_<v>_x64-setup.exe` style) and the deploy script produces
> `.dmg` (macOS) and `.AppImage`/`.deb` (Linux). The patterns above cover all three. Adjust substrings to the
> actual asset names once the first multi-platform release ships.

### 4.3 Download card UI
Each card: OS label, the matched asset's filename, file size (`(bytes/1024/1024).toFixed(1) + " MB"`), a primary
`download` button linking to `asset.browser_download_url` (signal-green), and the OS that has no asset shows
"Not available yet" (signal-low) with a secondary link to `https://github.com/ellipog/kern/releases/latest`.
Show the latest **version badge** (`v{tag_name}`) above the cards.

### 4.4 Signed-update awareness (do not re-implement, just reference)
kern's desktop auto-updater pulls `releases/latest/download/update.json` (minisign-signed). The website's
download buttons are the **manual fallback**; the in-app updater handles patching. You don't build the update
channel — just mention "auto-updates itself" as a feature on the landing page.

### 4.5 Fallback when release is null
If `getRelease()` returns null (API down at build time), render the download section with a single link to
`https://github.com/ellipog/kern/releases/latest`. **Never crash the page.**

---

## 5. Plugin system primer (read this before building the browser)

The plugin browser displays and distributes these. You must understand the format.

### 5.1 The `.kern` package
A `.kern` file is a **zip archive** containing:
- `manifest.json` (required) — metadata + behavior declaration (full schema below).
- `dist/index.js` (optional) — the plugin's ESM UI bundle, mounted in an isolated Shadow DOM.
- `dist/index.css` (optional) — injected into the shadow root.
- Any other assets the bundle references.

### 5.2 `manifest.json` schema
```jsonc
{
  "id": "minecraft_java",            // unique, lowercase, underscores — the registry key
  "displayName": "Minecraft Java Server",
  "version": "1.2.0",                // semver
  "author": "kern/sample",           // or a GitHub handle
  "description": "Run and manage Minecraft Java Edition servers…",
  "uiEntry": "dist/index.js",        // ESM bundle exposing mount(hostApi)

  // Dynamic config form the HOST renders when creating/editing a server instance:
  "configSchema": [
    { "key": "runtime", "label": "Server Software", "type": "select",
      "options": ["vanilla","paper","purpur","fabric","forge","neoforge","quilt"], "default": "purpur" },
    { "key": "mc_version", "label": "Minecraft Version", "type": "text", "default": "1.21" },
    { "key": "jvm_args",   "label": "JVM Arguments", "type": "text", "default": "-Xms2G -Xmx2G …" }
    // …also: java_version, java_path, server_jar, server_port, accept_eula
  ],

  // Named lifecycle steps. Commands support {{userOverrides.*}} templating resolved at launch by Rust.
  // Runtime-qualified keys (start.forge, start.node) win when an override matches.
  "lifecycle": {
    "start":        { "command": "{{userOverrides.java_path}}",
                      "args": ["{{userOverrides.jvm_args}}", "-jar", "{{userOverrides.server_jar}}", "--nogui"] },
    "start.forge":  { "command": "{{userOverrides.server_jar}}", "args": ["nogui"], "useShell": true }
    // also stop, install, etc.
  },

  // Starter files written into a fresh instance dir, with optional `when` conditions + templating.
  "scaffold": {
    "eula":   { "path": "eula.txt",   "content": "eula={{userOverrides.accept_eula}}\n" },
    "readme": { "path": "README.txt", "content": "Minecraft Server ({{userOverrides.mc_version}})…" }
  },

  // Declarative tabs the plugin registers in the server detail view.
  "tabs": [ { "id": "mc-setup", "label": "Setup" }, { "id": "mc-chat", "label": "Chat" } ]
}
```

### 5.3 Plugin UI isolation & HostAPI
A plugin's `mount(mountPoint, serverData, hostApi)` runs inside an **isolated Shadow DOM** (so plugin Tailwind
never bleeds into the host). The `hostApi` exposes:
- `invoke(command, args)` — call Tauri/Rust commands.
- `serverPath` — the instance directory.
- `listen(event, cb)` — subscribe to Tauri events.
- **Extension registrars:** `registerTab`, `registerToolbarAction`, `registerSidebarItem`.

### 5.4 The `kern://` deep-link protocol (critical for the browser)
kern registers a deep-link handler. **Double-clicking a `.kern` file** opens the app via
`kern://install?…`. The website's "Install in kern" buttons must fire the same protocol so a click in the browser
launches (or focuses) kern and begins installation:

```
kern://install?url=<https-url-to-.kern>&id=<plugin-id>&v=<version>
```
- If kern is installed, it opens and installs.
- If not installed, the click does nothing useful — so **also show a "download kern first" fallback** when the
  deep link fails (e.g., a timeout fallback to the download section). Detect via a short timer + `window.blur` heuristic.

### 5.5 Trust model
Plugins are **unsigned / trust-based** today. The registry must surface: author identity (GitHub), install counts,
community ratings, and a clear "install at your own risk" notice. (Future: optional signing — leave room in the
data model, §6.4.)

---

## 6. Plugin hosting & distribution model (the centerpiece)

**Goal:** a dynamic, ecosystem-grade plugin registry that is **free to run** at any reasonable scale.

### 6.1 Recommended primary architecture — Cloudflare free tier
| Concern | Choice | Why |
|---|---|---|
| **Blob storage (the `.kern` files)** | **Cloudflare R2** | **Zero egress fees** — the single most important property for a download host. Downloads don't cost you money as the ecosystem grows. 10 GB free, then ~$0.015/GB-mo storage. |
| **Catalog (metadata, search, versions, counts, ratings)** | **Cloudflare D1** (SQLite at the edge) | Free tier: 5 GB storage, 5 M reads / 100 k writes/day. SQL makes search/filter/ranking easy. |
| **API + auth** | **Cloudflare Workers** | 100 k req/day free; runs the catalog API, the publish flow, and the `kern://install` redirector. |
| **Auth for publishers** | **GitHub OAuth** (via Worker + `openid-client` / `aronija`-style) | Publishers log in with GitHub; their `author` identity is verified. Free. |
| **CI / curation** | **GitHub Actions** on a `kern-registry` repo | Phase A submission = a PR adding a plugin entry; CI validates the manifest and publishes to D1/R2 on merge. (JSR-style.) |
| **Site hosting** | **Vercel** (Next.js) | Build-time release fetch; calls the Worker API at runtime for the browser. |

**Why this wins on "dynamic + free":** R2's zero egress means viral download spikes cost nothing; D1 gives real
SQL search/ranking (not just static JSON); Workers give a real API for install counts + ratings + OAuth publish.
Every component has a generous free tier that covers a long runway.

### 6.2 Phased delivery
- **Phase A — Curated registry (ship first).** Submission is a PR to a `kern-registry` GitHub repo. A GitHub
  Action validates the `.kern` (unzip, parse `manifest.json`, check `id`/`version`/schema), uploads the blob to
  R2, and upserts a row in D1. Curation = maintainers review the PR. Zero auth infra needed; instant trust signal.
- **Phase B — Open self-publish + engagement.** Add GitHub-OAuth login on the site; publishers upload `.kern`
  files directly through the browser (Worker validates + writes to R2/D1). Add star ratings, reviews, and live
  install counters. Keep Phase A's PR path as the "verified/official" tier.

### 6.3 Catalog data model (D1 / SQLite)
```sql
CREATE TABLE plugins (
  id            TEXT PRIMARY KEY,          -- manifest id, e.g. minecraft_java
  display_name  TEXT NOT NULL,
  description   TEXT,
  author        TEXT NOT NULL,             -- GitHub login or 'kern/official'
  author_github_id   INTEGER,              -- verified publisher (NULL = curated/unknown)
  category      TEXT,                      -- 'game-server' | 'bot' | 'web' | 'database' | 'dev-tool' | 'other'
  tags          TEXT,                      -- JSON array: ["minecraft","java","paper",…]
  icon_url      TEXT,
  gallery       TEXT,                      -- JSON array of image URLs
  readme_md     TEXT,                      -- rendered on detail page
  repo_url      TEXT,
  homepage_url  TEXT,
  verified      INTEGER DEFAULT 0,
  featured      INTEGER DEFAULT 0,
  created_at    INTEGER, updated_at INTEGER,
  install_count INTEGER DEFAULT 0,
  rating_sum    INTEGER DEFAULT 0, rating_count INTEGER DEFAULT 0
);

CREATE TABLE plugin_versions (
  plugin_id   TEXT NOT NULL,
  version     TEXT NOT NULL,               -- semver
  kern_compat TEXT,                        -- min host version, if declared
  download_url TEXT NOT NULL,              -- R2 URL (or signed)
  sha256      TEXT,
  size_bytes  INTEGER,
  changelog   TEXT,
  created_at  INTEGER,
  PRIMARY KEY (plugin_id, version),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id)
);

CREATE TABLE reviews (          -- Phase B
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT, github_user_id INTEGER, github_login TEXT,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5), body TEXT, created_at INTEGER,
  UNIQUE(plugin_id, github_user_id)
);

CREATE TABLE install_events (   -- anonymized, for counters + sparklines
  plugin_id TEXT, version TEXT, occurred_at INTEGER
);
```

### 6.4 Worker API (REST, edge)
```
GET  /api/plugins                ?q=&category=&tag=&sort=popular|recent|rating&page=&limit=
GET  /api/plugins/:id            → plugin + latest version + gallery + rating
GET  /api/plugins/:id/versions   → version history
GET  /api/plugins/:id/readme     → rendered markdown
GET  /api/auth/github            → OAuth start
GET  /api/auth/github/callback   → OAuth callback, sets HttpOnly session cookie
POST /api/publish  (auth)        → multipart .kern upload; Worker validates + writes R2/D1 (Phase B)
POST /api/reviews/:id (auth)     → upsert review (Phase B)
POST /api/track/install          → { id, version } increments counter (no auth; rate-limited)
GET  /api/latest-version         → mirror of GitHub releases/latest for the site badge
```
The `/api/track/install` endpoint is hit by the `kern://install` redirector **before** redirecting, so install
counts reflect real browser→app handoffs.

### 6.5 The `kern://install` redirector
The "Install in kern" button does **not** link straight to `kern://…`. It links to the Worker:
```
https://kern.app/api/install/:id?v=:version
```
The Worker: (1) records an install event, (2) 302-redirects to
`kern://install?url=<R2-url>&id=<id>&v=<version>`. This guarantees counting even when the protocol handler
swallows the navigation, and lets you swap blob URLs without editing every button.

### 6.6 Versioning & update semantics
- Plugins are semver. The catalog's "latest version" = highest semver per `id`.
- The desktop app's future in-app browser can query `/api/plugins/:id` to show "update available."
- Leave a `kern_compat` column so a plugin can declare the minimum host version; surface incompatibility warnings in the browser.

### 6.7 Moderation & curation policy
- **Phase A:** maintainer review on PR. Official plugins (`kern/official`, `kern/sample`) get a `verified` badge.
- **Phase B:** reports via GitHub Issues against `kern-registry`; soft-delete (`featured=0`, hidden flag) for takedowns.
- Every detail page shows: author, GitHub link, version history, install count, ratings, and a "report" link.
- Prominent but unobtrusive notice: *"kern plugins run with full local privileges. Install only from authors you trust."*

### 6.8 Decision matrix — all alternatives (documented for completeness)

| Approach | Pros | Cons | Cost |
|---|---|---|---|
| **Static JSON index + `.kern` on GitHub Releases** | Zero infra; version-controlled; trivial CI. | No real search/ratings/counts; release asset limits (2 GB); GitHub bandwidth throttling on viral spikes. | $0 |
| **R2 blobs + static JSON index** (no DB) | Free egress; simple. | Still no dynamic search/counts; rebuild to update. | ~$0 |
| **Cloudflare R2 + D1 + Workers** *(recommended)* | Free egress, real SQL search, live counts/ratings, OAuth publish, edge-fast. | More moving parts; Workers free-tier limits (fine for a registry). | $0 → pennies |
| **JSR-style curated PR registry** (Phase A) | Maximum trust, minimal infra, reviewable. | Friction for submitters; maintainer bottleneck. | $0 |
| **Supabase (Postgres + Storage + Auth)** | Batteries-included; great DX. | Storage egress is metered (not zero); vendor lock-in. | Free → metered |
| **Neon (Postgres) + R2 + Next.js routes** | Serverless Postgres, branching. | You build more glue; egress still R2 (good). | Free → metered |
| **Federated "taps" (Homebrew-style)** | Anyone can host a registry; no central chokepoint. | Complex discovery; harder UX; overkill until ecosystem is large. | $0 (distributed) |

**Recommendation:** ship Phase A (curated PR → R2/D1 via Actions) for trust and speed, then Phase B (OAuth
self-publish + ratings) for ecosystem velocity. This sequence is the best "dynamic + free" path.

---

## 7. Plugin browser spec (front-end)

The showcase feature. Routes under Next.js App Router.

### 7.1 Listing page — `/plugins`
- **Header:** title `plugins`, count `registry (N)`, search input (`q`), sort dropdown (`popular` / `recent` / `rating`).
- **Facet sidebar:** `category` (game-server, bot, web, database, dev-tool, other), `tag` (minecraft, discord,
  node, rust, java, …), `runtime`, `author`, `verified only` toggle. All drive URL search params for shareability.
- **Grid of cards:** each card = icon, `displayName`, one-line description, author (+ verified badge), version,
  category tag, a mini dot-status accent (signal-green if `featured`/recently updated), install count, rating.
  Card click → `/plugins/:id`.
- **States:** skeleton loaders while fetching; friendly empty state (`no plugins match — try clearing filters`);
  error boundary with retry.
- **Data:** fetch from `/api/plugins` (Worker). Cache aggressively; the catalog changes slowly. Consider ISR (`revalidate: 300`).

### 7.2 Detail page — `/plugins/:id`
- **Hero:** icon, `displayName`, `id` (mono, dimmed), verified badge, author (link to GitHub + `/publishers/:author`),
  short description, primary `install in kern` button (→ `/api/install/:id` redirector, §6.5), secondary
  `view source` (repo_url), `download .kern` (direct R2 link), latest-version + last-updated chips.
- **Gallery:** screenshot carousel (from `gallery`).
- **About:** rendered `readme_md` (markdown, §9.3 renderer or MDX).
- **Config preview:** render the plugin's `configSchema` as a **read-only** form so visitors see exactly what
  fields they'll configure (reuse the app's `DynamicForm` concept as a static mock).
- **Versions:** table of `plugin_versions` (version, kern-compat, date, size, changelog excerpt, per-version download).
- **Stats:** install-count sparkline (from `install_events`), rating histogram.
- **Reviews** (Phase B): list + submit form (auth-gated).
- **Trust footer:** the "full local privileges / install at your own risk" notice + report link.

### 7.3 Publisher page — `/publishers/:author`
All plugins by an author/ GitHub user, with a verified identity banner. Encourages ecosystem loyalty.

### 7.4 Submit flow
- Phase A: a prominent `submit a plugin` button → links to the `kern-registry` repo's `CONTRIBUTING.md`
  (how to open a PR with your `.kern`).
- Phase B: `publish` button → GitHub OAuth → upload `.kern` → Worker validates + publishes → live immediately (or after review).

---

## 8. Docs hub spec

Surface the **existing** markdown so plugin devs and users learn the system. Source files already in the repo:
`documentation/PLUGIN_DEVELOPMENT.md`, `documentation/ArchitecturePlan.md`, `documentation/DesignGuide.md`,
`docs/plugin-tabs.md`.

### 8.1 Structure — `/docs`
- Sidebar nav (grouped): **Getting started** (install, first server, first plugin) · **Plugin development**
  (manifest reference, lifecycle, scaffold, configSchema, UI/HostAPI, packaging, distribution) · **Architecture**
  (overview, plugin isolation, process model) · **Design guide** (tokens, motifs).
- **Search:** client-side index (e.g., FlexSearch/Pagefind) over the rendered docs.
- **Code blocks:** syntax highlighting (Shiki), a copy button, and `kern`-manifest language tinting.
- **Callouts:** `> **note**`, `> **warn**`, `> **danger**` styled with warn-vector / fault-vector.
- **Edit-on-GitHub** link per page.

### 8.2 Recommended doc pages to author (some exist, some to write)
- `getting-started` — download, create first instance, start/stop, terminal basics.
- `manifest-reference` — the full §5.2 schema as a reference table.
- `lifecycle` — commands, `{{userOverrides.*}}` templating, runtime-qualified overrides, `useShell`.
- `scaffold` — starter files, `when` conditions.
- `config-schema` — field types (`text`/`select`), `dependsOn` cascading defaults.
- `plugin-ui` — Shadow DOM isolation, `mount()`, HostAPI, `registerTab/ToolbarAction/SidebarItem`.
- `packaging` — building a `.kern` (the app's `create_plugin_package`), dev seeding.
- `distribution` — how to publish to the registry (Phase A PR flow; Phase B OAuth).

---

## 9. Changelog + community spec

### 9.1 `/changelog` route
- Server component fetches the first 5 releases at build time (`getAllReleases()`).
- Client component renders a release list and implements **infinite scroll** with an `IntersectionObserver`
  watching a sentinel `<div>`; on intersect, call `getReleasesPage(nextPage)` and append; stop when a page is empty.
- Each release: a version badge (e.g., a small radar glyph + `v{tag}`), formatted `published_at`, a
  `view on github ↗` link to `release.html_url`, and the rendered `body`.

### 9.2 Roadmap section
A short, honest list (public GitHub Projects/Issues link preferred). Suggested seed items:
- macOS + Linux signed builds (Windows ships first).
- In-app plugin browser (consume this registry from inside kern).
- Plugin signing / verified publishers.
- Backup/restore for more server types.
- Telemetry history / charts.

### 9.3 Zero-dependency markdown renderer (`lib/markdown.tsx`)
GitHub release bodies only use a tiny subset. Reuse this hand-rolled approach (no `react-markdown`):
handles triple-backtick **fenced code blocks**, `##`/`###` headings, `-`/`*` unordered lists, and inline
`` `code` ``, **bold**, and `[text](url)` links. Map headings → kern heading styles; code → Shiki or a styled `<pre>`.

### 9.4 Community
- GitHub: `github.com/ellipog/kern` (Issues for bugs, Discussions for Q&A + plugin showcases).
- Discord invite (placeholder until created).
- "Show your setup" / plugin showcase prompt linking to Discussions.

---

## 10. Landing page spec (`/`)

Compose top-to-bottom (all sharing the §3 design system):

1. **Sticky nav** — `kern` wordmark + radar glyph, links: `features`, `plugins`, `docs`, `changelog`, and a
   primary `download` button. Fades in on scroll (opacity tied to `scrollY`). Includes a skip link.
2. **Hero** — full viewport. Background: the animated **Signal Radar** shader (§3.5, `aria-hidden`).
   Foreground: H1 (lowercase, terse — e.g., `any server. one panel.` or `manage any instance.`), a one-line
   subhead naming Minecraft/bots/APIs, a primary `download` button (signal-green), `view on github` secondary,
   and a **live version badge** (`v{latest tag}`) pulled from the release fetch. Respect `prefers-reduced-motion`.
3. **Signal Radar / brand strip** — a short, poetic paragraph in the kern voice explaining the radar metaphor
   (status as light-emitting nodes).
4. **Live terminal** feature — a faux terminal mockup with a streaming dot-wave status banner and ANSI-colored
   sample log lines (`[12:04:31] [Server thread/INFO]: Done (3.2s)! For help, type "help"`).
5. **Reactor channel / telemetry** — the matrix bar mockup with cpu/ram/log-activity readouts (amber at >90%).
6. **Lifecycle** — start/stop/restart buttons + a callout about the 15-second graceful shutdown ("world saves complete first").
7. **File editor** — a Monaco-style mock with a file tree.
8. **Plugins** — the two flagship plugins as cards (Minecraft Java — 7 softwares; Discord Bot — 4 runtimes),
   with a `browse all plugins →` link to `/plugins`.
9. **Auto-update** — "updates itself, signed." Short section.
10. **Download** — the §4 platform cards (Windows/macOS/Linux) with the latest version badge + mini-changelog excerpt.
11. **Footer / colophon** — built with Tauri · React · Rust · Tailwind. Links: github, docs, changelog, community, privacy.

Every section: lowercase headings, matrix-border dividers, the dot-grid accent at low opacity, staggered
Framer Motion reveals (skipped under reduced-motion).

---

## 11. Cross-cutting constraints

### 11.1 Accessibility
- `prefers-reduced-motion`: disable all shaders/animations; render static dot-grids instead. Use `useReducedMotion()` (Framer) or a CSS media query.
- Skip-to-content link as the first focusable element.
- Visible focus rings (signal-green outline) — the app resets `*:focus { outline: none }`; **the website must NOT** — keep accessible outlines.
- Decorative canvases/shaders: `aria-hidden="true"`. Status dots: include text labels for screen readers.
- Color contrast: signal-green on bg-core passes AA for large text/UI; body text uses zinc-300.
- Keyboard-navigable filter sidebar, search, and modal flows.

### 11.2 SEO
- `metadata` / `generateMetadata` per route; `metadataBase` = `https://kern.app`.
- `opengraph-image.tsx` — build-time OG image (near-black bg, radar glyph, mono font) via `next/og`.
- **JSON-LD `SoftwareApplication`** in the root layout: `name`, `operatingSystem: "Windows, macOS, Linux"`,
  `applicationCategory: "UtilitiesApplication"`, `downloadUrl` → latest release, `offers` free.
- Per-plugin detail pages: JSON-LD `SoftwareApplication` with `author`, `softwareVersion`, `aggregateRating`.
- sitemap.xml + robots.txt.

### 11.3 Performance
- Static-first: marketing/docs/download render as static HTML; release data fetched at build with `revalidate: 3600`.
- Plugin browser: ISR (`revalidate: 300`) + client-side filter state.
- Lazy-load the hero canvas shader (below-the-fold pause when tab hidden); cap FPS.
- Self-host JetBrains Mono (subset) or rely on system mono to avoid layout shift.

### 11.4 Error handling
- Every server fetch returns `null`/`[]` on failure; UI degrades gracefully (never a white screen).
- `error.tsx` + `not-found.tsx` boundaries in the kern voice (`signal lost`, `no instance found`).
- Plugin API down → cached fallback + retry affordance.

### 11.5 i18n readiness
- Keep all copy in a single `content/` or `messages/` module so translation is possible later. Not required to ship translations now.

---

## 12. Suggested file/tree scaffold

```
kern-web/
├─ app/
│  ├─ layout.tsx                  # metadata, JSON-LD, skip link, font, globals
│  ├─ page.tsx                    # landing (§10) — awaits getRelease()
│  ├─ opengraph-image.tsx         # build-time OG
│  ├─ error.tsx / not-found.tsx
│  ├─ changelog/page.tsx          # §9 — awaits getAllReleases()
│  ├─ plugins/
│  │  ├─ page.tsx                 # §7.1 listing
│  │  ├─ [id]/page.tsx            # §7.2 detail (ISR)
│  │  └─ publishers/[author]/page.tsx
│  └─ docs/
│     ├─ layout.tsx               # sidebar + search
│     └─ [[...slug]]/page.tsx     # MDX from documentation/
├─ components/
│  ├─ layout/   StickyNav.tsx Footer.tsx BackToTop.tsx
│  ├─ landing/  Hero.tsx RadarShader.tsx TerminalMock.tsx ReactorMock.tsx LifecycleMock.tsx PluginCards.tsx
│  ├─ download/ DownloadSection.tsx DownloadSectionClient.tsx VersionBadge.tsx
│  ├─ plugins/  PluginGrid.tsx PluginCard.tsx ConfigPreview.tsx VersionTable.tsx InstallButton.tsx
│  ├─ changelog/ ChangelogList.tsx ReleaseCard.tsx
│  ├─ ui/       Button.tsx MatrixBorder.tsx StatusDots.tsx Badge.tsx Modal.tsx
│  └─ mdx/      Code.tsx Callout.tsx
├─ lib/
│  ├─ github.ts                   # §4.1
│  ├─ markdown.tsx                # §9.3
│  └─ registry.ts                 # fetch wrappers for the Worker API
├─ styles/globals.css             # §3.2 theme + matrix-border + keyframes
├─ content/docs/…                 # MDX mirror of documentation/
└─ registry-worker/               # separate Cloudflare Worker project
   ├─ src/index.ts                # /api/plugins, /api/install/:id, /api/publish, /api/auth/github…
   ├─ schema.sql                  # §6.3
   ├─ wrangler.toml               # D1 + R2 bindings
   └─ .github/workflows/publish.yml   # Phase A: PR → validate → publish to D1/R2
```

### Recommended implementation order
1. `globals.css` theme + `MatrixBorder`/`StatusDots`/`Button` primitives + ported shaders.
2. `layout.tsx` (metadata, JSON-LD, nav, footer) + landing `page.tsx` hero + feature mocks.
3. `DownloadSection` + `lib/github.ts` (real data; the first verifiable win).
4. `/changelog` with infinite scroll.
5. `/docs` MDX pipeline + search.
6. `/plugins` listing + detail (start against a seed JSON fixture so front-end ships before the backend).
7. `registry-worker` (D1 + R2) + Phase A publish Action; swap the fixture for the live API.
8. Phase B: OAuth publish + reviews.

---

## 13. Build, env & deploy

### 13.1 Site (Vercel)
```
bun install
bun run build        # next build (static + ISR)
# deploy: connect repo on Vercel; set GITHUB_TOKEN + KERN_REGISTRY_API_URL in project env
```

### 13.2 Registry backend (Cloudflare)
```
cd registry-worker
wrangler d1 create kern-catalog          # → set D1_DATABASE_ID
wrangler r2 bucket create kern-plugins   # → R2 bucket
wrangler d1 execute kern-catalog --file=./schema.sql
wrangler deploy                          # publishes the Worker
# set secrets: wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
```
GitHub Action (`publish.yml`) on the `kern-registry` repo: on PR, validate the `.kern` (unzip, JSON-schema the
manifest, check id/version uniqueness); on merge to `main`, upload blob to R2 + upsert D1 row.

### 13.3 Domain
Production: `https://kern.app`. Configure DNS for Vercel (site) and a `api.kern.app` (or path-routed
`/api`) CNAME to the Worker. The `kern://` protocol is registered by the desktop app installer.

### 13.4 Security checklist
- `GITHUB_TOKEN` in Vercel/Worker env only; `.env*` gitignored. (Rotate any leaked tokens.)
- Worker input validation on publish (manifest schema, size limits, mime).
- Rate-limit `/api/track/install` and OAuth endpoints.
- CSP headers permitting `kern:` protocol + R2 + GitHub.

---

## Appendix A — kern voice cheat sheet
- lowercase. terse. technical. no exclamation marks. no hype.
- nouns from the domain: `instance`, `registry`, `reactor`, `lifecycle`, `terminal`, `orphan`, `latest.log`, `signal`, `grid`.
- buttons: `download`, `install in kern`, `browse plugins`, `read the docs`, `view on github`, `submit a plugin`.
- empty states: `no instances registered` · `no plugins match` · `signal lost` · `no output yet — start the instance to begin streaming`.

## Appendix B — the seven Minecraft runtimes (for the feature card)
`vanilla` · `paper` · `purpur` · `fabric` · `forge` · `neoforge` · `quilt`

## Appendix C — the four Discord-bot runtimes
`node` · `bun` · `deno` · `rust`

---

*End of master prompt. Hand this file to your AI agent or developer. The first concrete, verifiable milestone is
a deployable landing page whose Download section renders real version + asset data from `ellipog/kern` GitHub
Releases — build that before anything else.*
