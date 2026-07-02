---
title: overview
group: Getting started
slug: overview
order: 0
description: what kern is, and where to go next.
---

# kern docs

kern (always lowercase) is a **cross-platform desktop server manager** built with tauri v2 (rust backend + react frontend). it turns any folder on your computer into a managed server instance — with a live terminal, telemetry, and graceful lifecycle — and you teach it new server types by installing plugins.

think of it as a self-hosted alternative to cloud game-panel tools (pterodactyl, amp, pufferpanel) — but as a **native desktop app** driven by a **plugin system**.

## where to start

- **new to kern?** start with `getting-started` — download, register your first instance, start it.
- **building a plugin?** read `manifest-reference` first, then `lifecycle`, `config-schema`, and `plugin-ui`.
- **publishing?** see `distribution` for the registry flow.

## the big ideas

- **instance** — a registered project folder that kern manages. full crud, with orphaned-state detection.
- **plugin** — a `.kern` file that teaches kern how to run one type of server.
- **lifecycle** — `start` / `stop` / `restart` / `install`, declared per-plugin and resolved at launch by rust.
- **host api** — the bridge plugins use to talk to tauri commands, events, and the ui shell.

> **note** these docs are the source of truth for plugin developers. the app itself ships with two sample plugins — a game server plugin and a bot runner — that exercise nearly every feature.
