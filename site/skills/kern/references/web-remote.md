<!-- generated from content/docs/web-remote.md - edit the source in kern-web, then run: npm run skill:build -->

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

## public access via cloudflare tunnel

need the panel from outside your network? enable **expose via cloudflare tunnel** under the web remote settings. kern runs a [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) **quick tunnel** as a child process and shows the random URL:

```
https://random-words-here.trycloudflare.com
```

- no account, no port forwarding — the connector dials out to cloudflare's edge. https is terminated at the edge; the origin stays on `https://localhost:<port>` with kern's self-signed cert (`--no-tls-verify` on the connector).
- the settings panel shows a **pairing QR for the public URL** once the tunnel is up, plus a copy button.
- kern passes its own `--config` so a named tunnel in `~/.cloudflared/config.yml` is never touched.
- if `cloudflared` isn't installed, the panel offers to download the official binary into kern's app data; a copy on `PATH` is used as-is.
- the tunnel stops when you disable the toggle or quit kern.

> **warn** quick tunnels are public by design. anyone with the URL *and* the token controls your servers. they're also rate-limited and have no uptime guarantee — use them for personal access, not as production infrastructure. for a stable hostname, use a named cloudflare tunnel with your own domain, or a tailscale/zerotier network.

> **note** a freshly created quick tunnel can take a few minutes to resolve on some networks (negative dns caching). if the url doesn't load at first, wait and retry; the tunnel itself is already connected.

> **note** `GET /` requires the token too. open the URL with `?token=…` (what the qr encodes) or send `Authorization: Bearer …`. fetching `/` bare returns `401` — that's the auth working, not a broken tunnel.

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

`webRemotePort` lives in `config.json` (see [config.json](./config-json.md)); changing it restarts the listener with a new certificate if the old one doesn't match the new address.

> **note** for scripts on the same machine, use the [automation api](./automation-api.md) instead — plain http on loopback, no certificate dance.
