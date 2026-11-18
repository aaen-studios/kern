<!-- generated from content/docs/distribution.md - edit the source in kern-web, then run: npm run skill:build -->

# distribution

the registry is live at [kern.aaenz.no](https://kern.aaenz.no) and free to use. there is no pr queue: sign in with github and publish directly.

## self-publish through the web

1. sign in at kern.aaenz.no with github.
2. **submit a plugin** — upload your `.kern`, fill in the details (display name, category, readme, screenshots), and the listing goes live with your first version.
3. **publish new versions** from the plugin&rsquo;s edit page — drag the `.kern`, add a changelog, hit publish. the public page updates immediately.

every version records its `sha256` and size, and kern verifies the hash against the package before installing. storage policies scope uploads to your own plugin path, so no one else can replace your files.

plugins published by the official `ellipog` account get a `verified` badge.

## the cli publisher

maintainers can publish a prebuilt bundle without the browser:

```bash
npm run publish:plugins -- ../kern/release-assets/plugins
```

it verifies each file against the advertised sha256 + size, uploads to storage, and replaces the matching version rows. it needs `SUPABASE_SERVICE_ROLE_KEY` in the environment.

## the in-app marketplace

kern lists the registry from inside the app (plugins → marketplace): browse, search, and install without leaving the app. the registry url is configurable in settings (`registryUrl`).

## the kern:// deep link

the website&rsquo;s "install in kern" buttons fire:

```
kern://install?url=<https-url-to-.kern>&id=<plugin-id>&v=<version>
```

if kern is installed, it opens and installs. if not, the site falls back to "download kern first".

> **danger** kern plugins run with full local privileges. only install plugins from authors you trust. read the readme, check the author&rsquo;s github, and mind the install counts before installing.
