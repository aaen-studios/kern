---
name: kern
description: Build kern plugins and automate the kern desktop server manager — .kern manifests, lifecycle commands, config forms, plugin UI, kern-cli, the loopback automation API, backups, scheduled tasks, notifications, and the web remote. Use when working on or asking about kern, a .kern plugin, or kern-cli.
---

# kern

kern is a cross-platform desktop server manager (tauri v2 + rust + react). it turns any folder into a managed "server instance" with lifecycle controls (start / stop / restart / install), a live terminal, telemetry, backups, scheduled tasks, a crash watchdog, notifications, a plugin system, a loopback automation api, and `kern-cli`.

## when this skill applies

- writing, reviewing, or debugging a kern plugin (`.kern` package, `manifest.json`, `ui.js`)
- driving a running kern app: `kern-cli`, http calls to the automation api, backups, tasks
- answering questions about kern's config, architecture, or security model

## references

`references/` mirrors the published docs at https://kern.aaenz.no/docs (generated from `content/docs/`, don't hand-edit). read only what the task needs:

| task | read |
|---|---|
| manifest fields, `.kern` layout | references/manifest-reference.md |
| config form fields | references/config-schema.md |
| start / stop / install commands, templating | references/lifecycle.md |
| starter files written to new instances | references/scaffold.md |
| custom plugin ui, host api, shadow dom | references/plugin-ui.md |
| packaging and registry distribution | references/packaging.md, references/distribution.md |
| plugin permissions and consent | references/plugin-security.md |
| install kern, register an instance | references/getting-started.md |
| what kern is, big ideas | references/overview.md |
| every kern-cli command and flag | references/cli.md |
| http api endpoints, bearer token | references/automation-api.md |
| app config.json fields | references/config-json.md |
| backup create / restore / retention | references/backups.md |
| cron / interval tasks, watchdog | references/tasks.md |
| cpu/ram alerts, fleet health | references/monitoring.md |
| toasts, webhooks, log alert regexes | references/notifications.md |
| phone control, qr pairing, tunnels | references/web-remote.md |
| threat model, token handling | references/security.md |
| symptoms → fixes | references/troubleshooting.md |
| copy-paste setups | references/recipes.md |
| glossary, faq, shortcuts | references/glossary.md, references/faq.md, references/shortcuts.md |
| internals, process tree handling | references/architecture.md |

if a reference seems stale, the site is the source of truth: https://kern.aaenz.no/llms.txt indexes every page, and https://kern.aaenz.no/raw/docs/<slug> serves the raw markdown.

## invariants (get these right)

- `manifest.json` `id`: lowercase + underscores only (`web_api`, not `Web-API`).
- a `.kern` file is a **zip**: `manifest.json` (required), plus optional `dist/index.js` (esm ui bundle) and `dist/index.css`.
- `dist/index.js` exports `mount(mountPoint, serverData, hostApi)`; kern mounts it in a shadow root and injects the css there.
- lifecycle commands support `{{userOverrides.*}}` templating and runtime-qualified keys (`start.bun` wins over `start` when the runtime matches).
- `useShell: true` is only for shell-semantics commands (e.g. forge installers); prefer direct exec.
- the automation api is **loopback-only** (`127.0.0.1:7442`), authenticated with a bearer token from `<app_data>/automation.json`; never suggest exposing it to a network.
- the web remote (lan phone control) is separate, https, token-paired; treat its token like a password.
- plugins are a **capability boundary, not a sandbox** — permissions are an allowlist declared in the manifest and consented at install; never describe them as isolating untrusted code.
- `stop` must return promptly (e.g. send the server's own stop command); the host hard-kills the process tree after `stopTimeoutSecs` (default 30s).
