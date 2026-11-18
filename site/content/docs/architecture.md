---
title: architecture
group: Architecture
slug: architecture
order: 40
description: process model, storage layout, and the background workers.
updated: 2026-09-12
---

# architecture

kern is a tauri v2 desktop app: a rust backend (`src-tauri/`) and a react frontend (`src/`) in one window, plus out-of-process surfaces for scripts and phones.

```
┌─ kern (tauri) ───────────────────────────────────────────────┐
│  react ui  ──invoke/events──  rust core                      │
│                               ├─ registry (config.json)      │
│                               ├─ process supervisor          │
│                               ├─ scheduler (30s worker)      │
│                               ├─ plugin host (shadow dom)    │
│                               ├─ automation api (127.0.0.1)  │
│                               ├─ web remote (https, lan)     │
│                               └─ tray + updater              │
└──────────────────────────────────────────────────────────────┘
        │ spawn/stop                        ▲ plugins talk via HostAPI
        ▼                                   │
   server processes (own trees)     .kern plugin bundles
```

## process model

each instance is one supervised process **tree**:

- **spawn.** the plugin's lifecycle command is resolved with `{{userOverrides.*}}` templating, wrapped in a hidden console (windows), and started in the instance folder. a generation counter stamps the launch so stale reader threads can't touch a restarted process.
- **stream.** stdout and stderr are read on background threads, appended to `<instance>/latest.log`, and forwarded to the ui as stream events. a crash writes `crashes/<id>.json` with the exit code and a bounded log tail.
- **stop.** send the graceful command (stdin and/or the plugin's `stop` step) → wait `stopTimeoutSecs` → force-kill the whole tree. the tree is contained from birth: a **job object** on windows, a **process group** on unix, so a stop takes the children with it even if a plugin spawns helpers.
- **detach.** quitting kern does not kill servers. their pipes are closed and the pid + start time persist in `config.json`; the next launch re-adopts verified survivors as pid-only monitors (metrics + force-stop, no stdin/logs).

## logs

`latest.log` is an append-only plain-text mirror of the instance's output; the terminal pane renders it with ansi colors. readers (ui, cli, web remote) only ever read a bounded tail (2 MiB / 2000 lines) so a multi-gigabyte log never blocks anything. backups and crash reports take their own bounded slices. rotation is the server software's job — kern appends.

## plugins

a `.kern` package is a zip: `manifest.json` + an optional esm ui bundle. the host mounts plugin ui in a **shadow root** (styles isolated), and every host call goes through `HostAPI.invoke`, an allowlist keyed by manifest permissions. see the plugin development section and [plugin security](/docs/plugin-security).

## background workers

| worker | cadence | responsibilities |
|---|---|---|
| scheduler | 30s | scheduled tasks, health alerts, due backups + retention, metric history sampling |
| watchdog | event-driven | crash restart with exponential backoff, give-up notifications |
| logwatch | per line | user regex rules over streamed logs (throttled per rule) |
| automation api | per request | loopback json api for `kern-cli` |
| web remote | per request | https mobile page on the lan |
| tray radar | 0.25s | animated tray icon from the metrics pipeline |

all workers are best-effort: a failure is logged and never takes the app down.

## storage layout

```
<app_data>/
├─ config.json          registry + settings
├─ automation.json      loopback port + bearer token
├─ audit.log            bounded action history (+ .1 rotation)
├─ crashes/             per-instance last-crash reports
├─ plugins/             installed .kern contents
├─ web_remote/          self-signed cert material
└─ crashes, ui state, sync scratch

<instance>/
├─ latest.log           appended live
├─ world/               game/server data
└─ backups/             world-*.zip + pre-restore-*.zip
```

secrets never appear in either tree — rcon passwords and plugin secrets live in the os credential vault.

## frontend

react 19 + vite + tailwind v4. state is deliberately plain: component state plus a small persistence layer, with the rust side as the source of truth for anything durable. ui state (window geometry, open tabs, filters) is persisted separately so a restart restores your place.
