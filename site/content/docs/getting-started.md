---
title: getting started
group: Getting started
slug: getting-started
order: 1
description: download kern, register a folder, start an instance.
---

# getting started

## 1. download

grab the latest build from the [download section](/#download).

- **windows** — `kern-setup.exe`, a **per-user installer**: no admin or uac prompt, installs to `%localappdata%\kern`, creates start menu and optional desktop shortcuts, and registers `.kern` file associations and the `kern://` protocol so double-clicking a plugin package just works. it also installs `kern-cli`.
- **macos** — apple silicon `.dmg` (no intel build yet). gatekeeper may refuse the first launch: right-click → *open*.
- **linux** — `.appimage` (no `.deb` yet).

the builds are not os-code-signed. on windows, smart screen shows "windows protected your pc" the first time — choose *more info → run anyway*. after that, the app updates itself in place: updates are minisign-signed and verified before install.

for the command line — including the full-screen dashboard (run `kern-cli` with no arguments) — and the automation api, see `cli`.

## 2. register a folder as an instance

a "server instance" is just a project folder kern knows about. point kern at a directory and it becomes a managed instance — no daemons, no config files, no docker.

already have a server folder? the register flow has an **import** option: pick the folder and kern inspects it (jars, launch scripts, `server.properties`, `eula.txt`) and pre-fills the plugin runtime for you. nothing is moved or modified.

if a folder is moved or deleted, the instance is flagged **orphaned** rather than silently dropped, so you always know what kern thinks exists.

## 3. install a plugin

the app is intentionally generic. **plugins teach it how to run each type of server.** install a plugin for the server type you want to run — try the game server plugin for a minecraft server, or `discord_bot` to scaffold and run a bot.

plugins ship as `.kern` files (a zip with a `manifest.json` and an optional `dist/` ui bundle). double-clicking a `.kern` file opens kern via the `kern://install` deep link.

## 4. start, watch, stop

1. pick the instance, pick the plugin.
2. fill the config form (rendered dynamically from the plugin's `configSchema`).
3. hit `start`. stdout/stderr stream live to the terminal, appended to `<instance>/latest.log`, with full ansi color.
4. the input box is a command dispatcher: `start` / `stop` / `restart` / `install` trigger lifecycle; anything else is piped to stdin.
5. `stop` triggers a **graceful shutdown first** — kern sends the stop command, waits the instance's timeout (30 seconds by default, configurable per instance), then force-kills the whole process tree if it hasn't exited. a forced stop shows as `stopped-forced`.

> **note** per-process telemetry (cpu + ram via `sysinfo`) shows as a reactor channel bar that turns amber above 90% cpu and red on fault. when a server exits unexpectedly, the monitor shows a **last crash** card with the exit code and the final log lines.
