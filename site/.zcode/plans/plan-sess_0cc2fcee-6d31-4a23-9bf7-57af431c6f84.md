## Why the error is happening

`middleware.ts` runs in Next.js's **edge-runtime sandbox** on nearly every request (your matcher excludes only static assets). It constructs a Supabase server client and calls `await supabase.auth.getUser()`. Constructing the client fires `_emitInitialSession` → `_loadSession` → `_callRefreshToken` → `_refreshAccessToken`, which does a network `fetch` to Supabase. That fetch dies inside the sandbox's patched fetch (`node_modules/next/dist/server/web/sandbox/context.js:321`) with a bare `Error: fetch failed` — a **transport-layer** failure, not a 401. Because `getUser()` isn't wrapped in try/catch, the rejection propagates and logs on every request.

You're on `next@16.2.10`, where `middleware` is deprecated in favor of `proxy` — and critically, **Proxy defaults to the Node.js runtime** (per the bundled docs at `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`, version-history for v16.0.0). Node.js runtime uses Node's native `fetch` and does not go through the broken edge-sandbox `context.js`. That's the actual fix, not just the deprecation warning.

## Plan — migrate `middleware.ts` → `proxy.ts`

You chose "Migrate to proxy.ts" (keep the Supabase getUser refresh logic, no extra hardening), so this is a faithful migration.

**1. Create `proxy.ts`** at the project root (same level as `app/`) with the contents of `middleware.ts`, changed as follows:
- Rename the exported function `middleware` → `proxy` (required — the file convention looks for a function named `proxy`, or a default export).
- Update the doc comment to say "Proxy" instead of "Middleware".
- Keep everything else byte-for-byte identical: the env-var guard, the cookie `getAll`/`setAll` adapter (reads from `request.cookies`, writes to `response.cookies`), the `await supabase.auth.getUser()` refresh call, and the `config.matcher` regex.
- No `runtime` export is needed or allowed — the docs state the `runtime` config throws inside Proxy files; Node.js is the default.

**2. Delete `middleware.ts`** — verified safe: no code imports `./middleware` (grep of `*.ts`/`*.tsx`/`*.js`/`*.md` excluding `node_modules`/`.next` found only the file itself).

**3. Verify** by running the dev server (`npm run dev`) and loading the homepage; the `fetch failed` stack traces from `@supabase/auth-js` should stop appearing, and the deprecation warning (`The "middleware" file convention is deprecated. Please use "proxy" instead.`) should disappear.

## Not doing (per your choice)

- Not adding try/catch around `getUser()` — you chose to keep the refresh logic as-is. If the Node-runtime `fetch` still ever fails transiently, you may want this hardening later, but it's out of scope here.
- Not touching the other ~9 server-side `getUser()` call sites or `AuthProvider.tsx` — they run on Node/browser runtimes, not the edge sandbox, and were never the source of these errors.

## Note on the codemod

Next ships `npx @next/codemod@canary middleware-to-proxy .` which does the file+function rename. I'm doing it manually instead because the change is a single small file and I want to update the doc comment in the same pass — the codemod wouldn't touch it.