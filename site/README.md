# kern-web

**kern.aaenz.no** — the public website and plugin registry for [kern](https://github.com/aaen-studios/kern), an open source cross-platform desktop server manager built with Tauri.

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
npm install
npm run dev
```

open [localhost:3000](http://localhost:3000).

## environment

copy `.env.example` to `.env.local` and fill in the values:

- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — supabase project
- `SUPABASE_SERVICE_ROLE_KEY` — server-side supabase access
- `RESEND_API_KEY` — email for plugin reports

## project structure

```
app/              — next.js app router pages and api routes
components/       — react components (brand, layout, ui, landing, auth, download, plugins)
content/          — markdown docs and plugin seed data
lib/              — utilities (github, supabase, auth, markdown rendering)
public/           — static assets
supabase/         — database migrations
```

## contributing

this is an open source project. pull requests, issues, and discussions are welcome on [github](https://github.com/aaen-studios/kern).

## license

the code in this repository is available under the terms of the [kern](https://github.com/aaen-studios/kern) project.
