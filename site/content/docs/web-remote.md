---
title: web remote
group: Using kern
slug: web-remote
order: 11
description: the full kern panel in a browser — lan over https, or anywhere via cloudflare quick / named tunnels.
updated: 2026-09-14
---

# web remote

the web remote is a full control panel served by kern itself: console, files, backups, schedules, metrics, and audit — the same actions the desktop app performs, reachable from a phone, a laptop, or anywhere through a tunnel. enable it under **settings → web remote**.

```
https://192.168.1.20:7440
```

## pairing

devices pair with **single-use invites**. the owner creates one under **settings → web remote people** (name, role, optional server list), then shares the QR or link:

```
https://<panel-url>/#invite=ABCD2345
```

the invite expires in 15 minutes, works once, and redeems into a named device token stored on that device only. the owner's original keyring token keeps working as an admin credential (the legacy `?token=` QR), so existing setups don't break.

- **viewer** — read only: status, logs, metrics, files, audit.
- **operator** — viewer plus lifecycle, console input, file writes, backups, task runs.
- **admin** — everything, including creating/removing instances, installing plugins, and managing people.

roles can additionally be scoped to specific server ids. everything a remote user does is written to the audit log with their name.

## what the panel can do

- **overview** — host load and instance cards with live cpu/ram and quick actions.
- **console** — live log stream (server-sent events, no polling lag), command input piped to the instance's stdin, command history.
- **metrics** — cpu/ram charts from the rolling 7-day history.
- **files** — browse, edit (with on-disk conflict detection), create folders, rename, delete, upload, download.
- **backups** — list, create, restore, delete — whatever the plugin defines (minecraft worlds today).
- **tasks** — scheduled tasks with a run-now button.
- **audit** — the full action history, including remote requests.
- **settings** — device info, tunnel control, and (for admins) invite/user/device management.

the panel is an installable PWA: through a tunnel (real https) you can add it to your home screen and it behaves like an app.

## public access via cloudflare tunnel

two modes, both powered by a `cloudflared` child process that dials out — no port forwarding:

- **quick** — no account needed. kern runs `cloudflared tunnel --url https://localhost:<port>` and shows the random `*.trycloudflare.com` URL. rate-limited and best for personal, occasional access.
- **named** — stable hostname on your own domain. create a tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/), route a public hostname to `https://localhost:7440`, then paste the connector token under **settings → web remote → named**. the token lives in the os credential vault (never `config.json`).

both modes restart automatically if cloudflared exits while the toggle is on, and the settings panel shows the current URL, the pairing QR, and the last connector error. if `cloudflared` isn't installed, kern offers to download the official binary into its app data; a copy on `PATH` is used as-is.

### protecting the tunnel with cloudflare access

a public URL plus a valid device token is full control, so put access in front for anything long-lived:

1. in Zero Trust → **Access → Applications**, add a self-hosted app for your hostname.
2. add a policy (one-time pin to your email, google, github — whatever you use).
3. leave the kern device tokens in place: access gates the edge, kern gates the panel. both must pass.

> **warn** quick tunnel URLs are public by design and rotate whenever the tunnel restarts. anyone with the URL *and* a paired device token controls your servers. keep the tunnel off when you don't need it, revoke devices you no longer trust, and prefer named tunnels + access for daily use.

## security model

- **https everywhere.** on the lan kern serves a self-signed certificate generated on first run (accept it once per device). through a tunnel, cloudflare terminates tls with a real certificate — which is also what lets the PWA install.
- **device tokens, not one shared secret.** tokens are random, stored hashed on the host, revocable per device, and carry a role + server scope. the plaintext only ever exists on the paired device.
- **invites are single-use.** 15-minute ttl, strict rate limiting on pairing and auth failures, and every remote mutation is attributed in the audit log.
- **scoped api.** the browser talks to the same api the desktop app and CLI use, behind a per-route scope policy (view / control / admin). unknown routes require admin — new endpoints can't leak to viewers by accident.

## firewall

the first time the remote binds to the lan, windows firewall shows its standard "allow access" prompt. allow **private networks** only; access is token-authenticated either way. this is an os dialog, not a kern one.

## turning it off

**settings → web remote → disable** stops the listener immediately; paired devices keep their tokens so re-enabling doesn't require re-pairing. revoke individual devices under **web remote people**, or rotate the owner token to invalidate the legacy credential.

## scripts

for automation on the same machine, use the [automation api](/docs/automation-api) instead — loopback http, no certificate dance, same routes. `kern-cli` speaks it natively.
