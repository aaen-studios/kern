---
title: getting started
group: Getting started
slug: getting-started
order: 1
description: download kern, register a folder, start an instance.
---

# getting started

## 1. download

grab the latest build from the [download section](/#download). windows ships first as an nsis installer; macos (`.dmg`) and linux (`.appimage` / `.deb`) follow. the app auto-updates itself after that — updates are minisign-signed.

## 2. register a folder as an instance

a "server instance" is just a project folder kern knows about. point kern at a directory and it becomes a managed instance — no daemons, no config files, no docker.

if a folder is moved or deleted, the instance is flagged **orphaned** rather than silently dropped, so you always know what kern thinks exists.

## 3. install a plugin

the app is intentionally generic. **plugins teach it how to run each type of server.** install the `minecraft_java` plugin to run a minecraft server, or `discord_bot` to scaffold and run a bot.

plugins ship as `.kern` files (a zip with a `manifest.json` and an optional `dist/` ui bundle). double-clicking a `.kern` file opens kern via the `kern://install` deep link.

## 4. start, watch, stop

1. pick the instance, pick the plugin.
2. fill the config form (rendered dynamically from the plugin's `configSchema`).
3. hit `start`. stdout/stderr stream live to the terminal, appended to `<instance>/latest.log`, with full ansi color.
4. the input box is a command dispatcher: `start` / `stop` / `restart` / `install` trigger lifecycle; anything else is piped to stdin.
5. `stop` triggers a **graceful shutdown with a 15-second timeout** before hard-kill — tuned so minecraft world saves (chunk flush + level.dat) complete first.

> **note** per-process telemetry (cpu + ram via `sysinfo`) shows as a reactor channel bar that turns amber above 90% cpu and red on fault.
