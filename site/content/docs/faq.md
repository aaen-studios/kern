---
title: faq
group: Reference
slug: faq
order: 31
description: short answers to the questions that come up first.
updated: 2026-09-12
---

# faq

**is kern free?** yes. no accounts, no tiers, no telemetry.

**what can it actually run?** anything you can start from a folder with a command. officially-patterned plugins cover minecraft java (paper/purpur/fabric/forge/neoforge), discord bots in four runtimes, and generic node/rust/python services, but the engine is generic — a `custom` instance is just a command and a working directory.

**does it need docker?** no. one process tree per instance, supervised directly.

**where does my data live?** the app data dir (settings/plugins) and your instance folders (logs/backups/worlds). see [config.json](/docs/config-json). deleting kern never deletes your servers.

**does quitting kern stop my servers?** no — they're deliberately detached and re-adopted on the next launch. use `kern-cli stop` / the stop button when you mean stop.

**can i control it from my phone?** yes — the [web remote](/docs/web-remote): the full panel (console, files, backups, tasks, metrics) over https, paired with one-scan invites, or published anywhere through a cloudflare tunnel.

**can i script it?** yes — [`kern-cli`](/docs/cli) for shells, and the [automation api](/docs/automation-api) for anything else, both on loopback with a bearer token.

**is there a daemon / headless mode?** not yet. the app is the daemon; it runs in the tray. a headless build is a roadmap item.

**how is this different from pterodactyl / amp?** those are web panels that manage servers on remote boxes with their own agents. kern is a native desktop app: your machine, your files, no docker, no browser, plus a plugin system for what "a server" means.

**why is the installer unsigned?** code-signing certificates cost money and the project is free. the installer is unsigned, but **updates are minisign-signed and verified** — the risky part (silent self-update) is protected.

**intel macs?** apple silicon only today. the dmg says so.

**linux packages?** appimage for now; `.deb` is on the roadmap.

**can two people share one kern?** it's a desktop app for one machine/user. multi-machine sync is export/import into a git repo, not real-time collaboration.

**do health alerts and log alerts survive restarts?** the rules live in `config.json`, yes. the rolling metric history is in-memory and resets on exit — it's telemetry, not a database.

**what happens if i edit config.json by hand?** with kern closed, it's honored on the next load; unknown fields are ignored and new fields default. with kern running, your edits race the app's writes — use the api or the ui.

**can a plugin read my other servers or files outside its instance?** only if you granted `servers:read` / `files:read` and it uses them; file commands resolve paths under server directories. see [plugin security](/docs/plugin-security).

**how do i uninstall cleanly?** uninstall the app, then delete the app data dir and any instance folders you created. nothing else is left behind.
