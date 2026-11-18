# kern site

**kern.aaenz.no** — the public website and plugin registry for [kern](https://github.com/aaen-studios/kern), an open source cross-platform desktop server manager built with Tauri. it lives in `site/` of the kern repo (it was the separate `kern-web` repo until 2026-11-18, history kept).

## overview

this is a [next.js](https://nextjs.org) project (app router) serving as the marketing site, documentation hub, and plugin registry backend for the kern desktop application.

- **landing page** — hero, feature mockups, download links via GitHub releases
- **docs** — markdown-powered documentation hub
- **plugin registry** — browse, search, submit, and manage plugins (supabase-backed)
- **changelog** — live release feed from GitHub
- **open source** — contributions and forks welcome

## tech stack

| tool | role |
|---|---|
| next.js 16 | react framework (app router) |
| react 19 | ui library |
| tailwind css v4 | styling |
| supabase | auth + plugin registry database |
| motion | animations |
| resend | email notifications |
| jetbrains mono | typography |

## getting started

```bash
cd site
bun install
bun run dev
```

open [localhost:3000](http://localhost:3000).

## deploys

the site runs on the aaen VPS next to the other sites (Cloudflare Tunnel → Caddy → `next start`), set up in `ellipog/vps-hosting` (`sites/conf/kern.conf`). a push to `main` that touches `site/` builds and switches to the new release with no downtime; GitHub shows it as the `vps/kern` commit status. production secrets live on the VPS, not in this repo.

## environment

copy `.env.example` to `.env.local` and fill in the values:

- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — supabase project
- `SUPABASE_SERVICE_ROLE_KEY` — server-side supabase access
- `RESEND_API_KEY` — email for plugin reports

then apply the database migrations: run `supabase/migration.sql` and
`supabase/migrations/0002_storage_rls.sql` in the supabase SQL editor (or
`supabase db push`). the storage policies are what allow plugin authors to
upload `.kern` files from the browser.

## project structure

```
app/              — next.js app router pages and api routes
components/       — react components (brand, layout, ui, landing, auth, download, plugins)
content/          — markdown docs and plugin seed data
lib/              — utilities (github, supabase, auth, markdown rendering)
public/           — static assets
scripts/          — build tooling (skill generation)
supabase/         — database migrations
```

## ai agents

the docs ship as an [agent skill](https://skills.sh) so coding agents can build kern plugins and script `kern-cli` without scraping the site:

```bash
npx skills add aaen-studios/kern          # install the skill (claude code, opencode, cursor, …)
npm i -D @aaen-studios/kern               # or the npm package (pinned / offline)
```

agents that prefer the web can use [kern.aaenz.no/llms.txt](https://kern.aaenz.no/llms.txt) and the raw markdown at `/raw/docs/<slug>`.

the skill lives at the repo root in `skills/kern` (so `npx skills add aaen-studios/kern` finds it). `skills/kern/references/` is generated from `site/content/docs/` — after editing docs run `bun run skill:build` (and `bun run skill:check` before committing).

## publishing official plugin updates

the first-party plugins (`minecraft_java`, `discord_bot`) live in this repo
under `plugins/`. to ship a
new version:

1. at the repo root: bump the manifest, rebuild the UI, repack, and build the upload
   bundle — `bun run plugins:check` must pass:

   ```bash
   bun run plugins:build && bun run plugins:pack && bun run plugins:check
   bun run plugins:bundle        # fresh release-assets/plugins bundle + meta.json
   ```

2. in `site/`: update `content/plugins/seed.json` (version entry, changelog,
   readme) so seed mode and the landing cards match.
3. publish to the live registry — uploads the `.kern` files to the
   `plugin-kern` bucket and replaces the `plugin_versions` rows. `--dry-run`
   verifies the bundle locally first:

   ```bash
   bun run publish:plugins -- ../release-assets/plugins --dry-run
   bun run publish:plugins -- ../release-assets/plugins --update-meta
   ```

   `--update-meta` also refreshes the `plugins` row (description, readme,
   config schema, tags) from the seed. needs `SUPABASE_SERVICE_ROLE_KEY` in
   `.env.local`.
4. verify: `/api/download?id=<slug>&v=<version>` should 302, and the plugin
   page should show the new version.

## contributing

this is an open source project. pull requests, issues, and discussions are welcome on [github](https://github.com/aaen-studios/kern).

## license

the code in this repository is available under the terms of the [MIT license](./LICENSE).
