---
title: web remote
group: Using kern
slug: web-remote
order: 11
description: control kern from your phone over the lan — https, qr pairing.
updated: 2026-09-12
---

# web remote

the web remote is an optional https control panel served by kern itself, for the moment you're on the couch and the server needs a kick. enable it under **settings → web remote**.

```
https://192.168.1.20:7440  ← scan the qr to pair
```

## security model

- **https, self-signed.** a certificate is generated on first run and stored under `<app_data>/web_remote/` — a secure context on your lan, no external service.
- **token auth.** a random 48-hex token is generated once and kept in the os credential vault (keyring). the settings screen shows a **qr code** that embeds the token, so pairing is one scan.
- **lan-bound.** the server binds `0.0.0.0:<port>` (default `7440`). it is not reachable from outside your network unless you deliberately forward the port.
- **scoped surface.** the phone page can view instances, start/stop/restart, and tail logs — the same lifecycle actions as the desktop. it is a purpose-built page, not the desktop ui (which depends on the tauri bridge a browser doesn't have).

> **warn** anyone with the token on your lan can control your servers. treat the qr like a password; disable the web remote when you don't need it.

## firewall

the first time the remote binds to the lan, windows firewall shows its standard "allow access" prompt. allow **private networks** only; access is token-authenticated either way. this is an os dialog, not a kern one.

## pairing

1. enable the web remote in settings.
2. scan the qr with your phone (camera app).
3. the page opens on `https://<host>:7440/?token=…` and stores the token locally.
4. your browser will warn about the self-signed certificate once — accept and continue.

## what the mobile page can do

- live server cards: status, cpu/ram, uptime
- start / stop / restart
- tail the selected instance's log
- jump between instances

it's read-mostly by design: destructive flows (deleting instances, restoring backups) stay on the desktop, where the confirmation context exists.

## turning it off

settings → web remote → disable stops the listener immediately; the token stays in the vault so re-enabling doesn't re-pair your phone. to revoke a device, disable then delete the stored token in **settings → automation & cli** (or pair again from a new code).

## changed ports

`webRemotePort` lives in `config.json` (see [config.json](/docs/config-json)); changing it restarts the listener with a new certificate if the old one doesn't match the new address.

> **note** for scripts on the same machine, use the [automation api](/docs/automation-api) instead — plain http on loopback, no certificate dance.
