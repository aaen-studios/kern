---
title: web remote
group: Using kern
slug: web-remote
order: 11
description: the full kern panel in a browser — console, files with a real editor, backups, schedules, plugins. lan over https, or anywhere via cloudflare tunnel.
updated: 2026-09-14
---

# web remote

the web remote is a full control panel served by kern itself: console, a Monaco file editor, backups, schedules, metrics, audit, plugin installs — the same actions the desktop app performs, reachable from a phone, a laptop, or anywhere through a tunnel. enable it under **settings → web remote**.

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
- **operator** — viewer plus lifecycle, console input, file writes, backups, tasks.
- **admin** — everything, including creating/removing instances, installing plugins, and managing people.

roles can additionally be scoped to specific server ids. everything a remote user does is written to the audit log with their name.

## where it listens

by default the panel binds every interface on port `7440`. **settings → web remote → bind address** narrows that:

- **all interfaces (0.0.0.0)** — phones on your lan can reach it.
- **localhost only (127.0.0.1)** — nothing on the lan can connect; use the tunnel, or put your own reverse proxy (nginx/caddy) in front. the proxy should forward to `https://127.0.0.1:7440` and may skip origin verification (self-signed cert).
- **any detected interface ip** — bind to one specific address (a second nic, a vpn interface).

the panel shows every URL it is reachable at. kern serves a self-signed certificate covering localhost and your interface addresses; when you bind a new address kern regenerates it automatically, and **regenerate** in settings forces a fresh one (devices re-accept once). through a tunnel, cloudflare serves a real certificate instead — which is also what lets the PWA install.

changing the bind or port restarts the listener immediately. binding is deliberately desktop-only: a wrong remote bind would strand every paired device.

## the panel

- **overview** — host load, instance cards with live cpu/ram, start/stop/restart, and (admins) a **new instance** flow: point at a folder, kern inspects it, you pick a plugin and fill its config form.
- **console** — live stream (server-sent events), command input to stdin, history, filter, autoscroll, log download, saved command snippets, and an RCON player list.
- **files** — the desktop's own Monaco editor (same theme, format-on-save), lazy file tree, tabs with unsaved indicators, create/rename/delete/upload/download, markdown/json/image previews, cross-file content search with jump-to-line, per-file **snapshot history** (capture, restore, delete) and diff against any snapshot. saves are conflict-checked against the file on disk.
- **backups** — create/restore/delete/download, plus the automatic-backup schedule (interval, retention, on clean stop).
- **tasks** — full scheduler editor: daily / interval / cron / manual, command and restart actions, enable toggles, run-now.
- **metrics** — cpu/ram charts from the rolling 7-day history.
- **plugins** (admins) — installed plugins with uninstall, `.kern` upload-install, and the registry marketplace with install progress.
- **audit** — the full action history, including remote requests, with an admin download.
- **settings** — device info, bind/tunnel status, crash notifications, and (admins) invite/user/device management.

## public access via cloudflare tunnel

two modes, both powered by a `cloudflared` child process that dials out — no port forwarding:

- **quick** — no account needed. kern runs `cloudflared tunnel --url https://localhost:<port>` and shows the random `*.trycloudflare.com` URL. rate-limited and best for personal, occasional access.
- **named** — stable hostname on your own domain. create a tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/), route a public hostname to `https://localhost:7440`, then paste the connector token under **settings → web remote → named**. the token lives in the os credential vault (never `config.json`).

the connector dials the address the panel is actually bound to, both modes restart automatically if cloudflared exits while the toggle is on, and the settings panel shows the current URL, the pairing QR, and the last connector error. if `cloudflared` isn't installed, kern offers to download the official binary into its app data (the pairing panel has the progress).

### protecting the tunnel with cloudflare access

a public URL plus a valid device token is full control, so put access in front for anything long-lived:

1. in Zero Trust → **Access → Applications**, add a self-hosted app for your hostname.
2. add a policy (one-time pin to your email, google, github — whatever you use).
3. leave the kern device tokens in place: access gates the edge, kern gates the panel. both must pass.

> **warn** quick tunnel URLs are public by design and rotate whenever the tunnel restarts. anyone with the URL *and* a paired device token controls your servers. keep the tunnel off when you don't need it, revoke devices you no longer trust, and prefer named tunnels + access for daily use.

## notifications

the panel can notify you when an instance transitions into a fault (crash, forced stop, error). enable it under **settings → crash notifications** — the browser asks for permission once. notifications fire while the panel is open (including as an installed PWA in the background on most platforms).

## security model

- **https everywhere.** on the lan kern serves a self-signed certificate (accept it once per device). through a tunnel, cloudflare terminates tls with a real certificate.
- **device tokens, not one shared secret.** tokens are random, stored hashed on the host, revocable per device, and carry a role + server scope. the plaintext only ever exists on the paired device.
- **invites are single-use.** 15-minute ttl, strict rate limiting on pairing and auth failures, and every remote mutation is attributed in the audit log.
- **scoped api.** the browser talks to the same api the desktop app and CLI use, behind a per-route scope policy (view / control / admin). unknown routes require admin — new endpoints can't leak to viewers by accident.

## firewall

the first time the remote binds to the lan, windows firewall shows its standard "allow access" prompt. allow **private networks** only; access is token-authenticated either way. this is an os dialog, not a kern one.

> **note** binding to `127.0.0.1` avoids the firewall prompt entirely (nothing on the lan can reach it).

## turning it off

**settings → web remote → disable** stops the listener immediately; paired devices keep their tokens so re-enabling doesn't require re-pairing. revoke individual devices under **web remote people**, or rotate the owner token to invalidate the legacy credential.

## scripts

for automation on the same machine, use the [automation api](/docs/automation-api) instead — loopback http, no certificate dance, same routes. `kern-cli` speaks it natively.
