---
title: security model
group: Reference
slug: security
order: 33
description: what is trusted, what is exposed, and where secrets live.
updated: 2026-09-12
---

# security model

kern runs servers on your machine, so the trust boundaries worth knowing are concrete.

## the app itself

- **no admin rights.** the windows installer is per-user (`%LOCALAPPDATA%`), macos and linux builds run unprivileged. kern never asks for elevation.
- **no telemetry, no accounts.** nothing leaves the machine except the update check and the requests you configure (registry, webhooks). there is no kern cloud.
- **files stay local.** config, logs, backups, and audit history live under the app data dir and your instance folders. deleting the app doesn't touch your server folders.

## the automation api

- bound to **loopback only** (`127.0.0.1`) — nothing on the lan can reach it.
- bearer-token auth; the token is a random 64-hex string written to `automation.json` in the app data dir and reused across restarts so scripts keep working.
- plain http **on purpose**: loopback traffic never hits a network, so a self-signed https handshake would add trust prompts without adding a boundary.
- **who can read the token:** anyone who can read your user's app data dir. that's the same trust level as your user account — files in `~` are already readable by processes running as you.

## the web remote

see [web remote](/docs/web-remote). short version: https with a self-signed cert, token in the **os credential vault**, qr pairing, bound to the lan only while enabled. anyone with the token and lan access can control lifecycle — disable it when unused.

## secrets

- plugin secrets and stored credentials go to the **os credential vault** (windows credential manager / macos keychain / secret service), never to `config.json`.
- the rcon password is stored in the vault too.
- `config.json` holds no passwords. instance `.env` files are user content and are never uploaded or synced by kern.

## plugins

plugins are a **capability boundary, not a sandbox** — plugin ui shares the host webview realm. the boundary works by allowlist: every host command maps to a permission the manifest must declare and you must consent to at install time. read [plugin security](/docs/plugin-security) before installing community packages.

## updates

the in-app updater verifies a **minisign signature** against a public key embedded in the binary before installing anything. if verification fails, the update is refused. keys are never shipped to clients.

## backups

archives are plain zips under `<instance>/backups/` — confidential if your world is. backups are not encrypted and not uploaded anywhere; treat them like the world folder itself.

## audit

lifecycle actions, config changes, plugin installs, backups, and task runs are appended to `audit.log` in the app data dir (bounded and rotated). it's local-only, exportable from settings, and a good way to answer "who restarted this at 2am".

## reporting

security issues: open a [github issue](https://github.com/aaen-studios/kern/issues) for non-sensitive reports; for anything exploitable, use github's private vulnerability reporting on the repo.
