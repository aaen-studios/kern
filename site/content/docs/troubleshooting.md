---
title: troubleshooting
group: Using kern
slug: troubleshooting
order: 17
description: symptom → cause → fix, from install to stuck servers.
updated: 2026-09-12
---

# troubleshooting

start with `kern-cli doctor` — it checks the endpoint file, connectivity, api version, and registry in one shot.

## install & first launch

**windows: "windows protected your pc"** — smart screen, because the installer isn't os-code-signed. *more info → run anyway*. updates afterwards are minisign-signed and verified before install.

**macos: "kern can't be opened"** — gatekeeper, same reason. right-click the app → *open* once. no intel build yet; apple silicon only.

**linux: appimage won't launch** — `chmod +x kern_*.AppImage` then run it. fuse is needed: install `libfuse2` on debian/ubuntu if the appimage complains.

## cli says "could not read …automation.json"

the cli found no running app:

1. is kern running? `kern-cli doctor` names the path it looked in.
2. is the automation api enabled? **settings → automation & cli** — it's on by default (port `7442`).
3. are you in the same user session? the app data dir is per-user; `sudo kern-cli` won't find your config.
4. using a portable/dev setup? point `KERN_APP_DATA_DIR` at the directory that holds `automation.json`.

## cli exits 4 but kern is running

usually a stale endpoint file from a crashed instance, or a port clash:

- `kern-cli doctor` shows the endpoint's `pid` and start time. compare with the actual process.
- `kern-cli endpoint --format json` prints the url the cli is using.
- restart kern — it rewrites `automation.json` (keeping the token).
- if two kern instances run on one machine, only the first binds `7442`; the second logs `[automation] failed to bind`. give one a different `automationPort`.

## cli exits 4 with 401

the token in the endpoint file doesn't match the running app. restart the app, or delete `automation.json` and restart to re-mint. if you use `KERN_AUTOMATION_TOKEN`, check for a stale value in your shell profile.

## a server won't start

run `kern-cli preflight "<name>"`. the usual suspects:

| finding | fix |
|---|---|
| port held by another process | stop the other process, or change the instance's port config |
| minecraft eula pending | set `eula=true` in `eula.txt` in the instance folder |
| low disk | free space; backups and logs need room |
| `custom instances require a start_command` | it's a `custom` instance with no command — edit the instance and set one, or use the right plugin |
| `java not found` | install a jre/jdk (17+ for modern minecraft) or point the instance at a java path in its config |

## stop takes 30 seconds and reports "stopped-forced"

that's the graceful window expiring. kern sent the stop command (stdin or the plugin's `stop` step), waited, then force-killed the process tree. if it's always forced:

- the server ignores its stop command — check the instance's `stopCommand`.
- the world save genuinely takes that long — raise `stopTimeoutSecs` on the instance.
- it's a custom instance with `stopCommand: ""` — the stdin step is deliberately skipped; kern waits the full timeout then kills. set a stop command if the process supports one.

## "orphaned" instance

the folder is missing (moved, renamed, external drive unplugged). kern keeps the record instead of deleting it. re-point the instance at the folder via **edit**, or remove the record. nothing is deleted automatically, ever.

## web remote unreachable from my phone

1. same network? guest wi-fi often isolates clients.
2. the app binds `0.0.0.0:<port>` only while enabled — check settings.
3. windows firewall: allow the private-network prompt; if you dismissed it, add an inbound rule for the port.
4. https warning is expected (self-signed cert) — accept it once.
5. if you changed `webRemotePort`, re-scan the qr (the url embeds the port).

## logs pane is empty

- the log file is `<instance>/latest.log`; a server that has never produced output has none.
- kern appends stdout/stderr to it while running, so a stopped-and-cleared folder reads empty.
- `kern-cli logs "<name>" --lines 20` shows the tail without the ui.

## plugin install rejected

the dialog names the reason. common ones:

- **unknown permission** — the manifest requests a permission this kern version doesn't know; update kern or the plugin.
- **kernCompat** — the plugin requires a newer host version.
- **checksum mismatch** — the downloaded `.kern` changed in transit; re-download.
- **path traversal** — the archive contains entries that escape the plugin directory; refuse it and tell the author.

see [plugin security](/docs/plugin-security).

## high cpu reading right after start

`sysinfo` computes process cpu as a delta between samples. the first reading after a launch is meaningless (often 100% for host, ~0% for the new process) and corrects within a second or two. it is not your server.

## the dashboard looks broken in my terminal

the full-screen dashboard needs a real terminal. if it garbles, check `TERM`, try windows terminal, or use the plain commands (`kern-cli top --once`, `kern-cli list`) which never use the alternate screen.

## in-app updater says "signature mismatch"

the downloaded artifact didn't verify against the embedded public key. this is the updater protecting you. retry; if it persists, download the installer fresh from the [releases page](https://github.com/aaen-studios/kern/releases). **never** disable signature checks.

## where do i report a bug

[github issues](https://github.com/aaen-studios/kern/issues). include `kern-cli doctor` output, your os, and the exact command or click path.
