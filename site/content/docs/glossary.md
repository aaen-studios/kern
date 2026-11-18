---
title: glossary
group: Reference
slug: glossary
order: 32
description: the words kern uses, in one place.
updated: 2026-09-12
---

# glossary

**instance** — a folder registered with kern, plus the settings that describe how to run it. one instance = one supervised process tree.

**plugin** — a `.kern` package that teaches kern a server type: manifest metadata, a config form, lifecycle commands, optional ui. see `manifest-reference`.

**`.kern` file** — the plugin archive (a zip). double-clicking one opens kern's install dialog via the `kern://` protocol.

**lifecycle** — the named steps a plugin declares: `install`, `start`, `stop`, `restart`. resolved by rust at launch, with `{{userOverrides.*}}` templating.

**userOverrides** — the values from the instance's config form (port, jar path, runtime…), referenced by lifecycle commands and scaffold files.

**manifest** — `manifest.json` inside a plugin: id, version, permissions, config schema, lifecycle, scaffold.

**host api** — the bridge a plugin ui uses to talk to the app (`invoke`, `listen`, tab/toolbar registrars), gated by manifest permissions.

**orphaned** — the instance's folder is missing (moved, renamed, unplugged). kern keeps the record and flags it instead of deleting anything.

**adopted** — a process that survived a kern restart with no pipes: it's monitored by pid (liveness, metrics, force-stop) but can't receive stdin or stream logs it didn't start.

**graceful stop** — the stop pipeline: stdin/stop command → wait `stopTimeoutSecs` → force-kill the tree. the result of a forced path is `stopped-forced`.

**stopped-forced** — the status when the graceful window expired and kern killed the tree. see `lifecycle`.

**watchdog** — per-instance crash policy: auto-restart with exponential backoff up to `maxAttempts`, with notifications and a last-crash report.

**preflight** — the read-only checks before a start: port conflicts (with the owning pid), pending minecraft eula, low disk.

**snapshot / backup** — the `world/` directory zipped into `<instance>/backups/world-<timestamp>.zip`. a restore first snapshots the current world as `pre-restore-<epoch>.zip`.

**alert rules** — per-instance cpu/ram thresholds with a sustained window; firing raises a notification (and webhook).

**notification center** — the in-app history of events (crashes, backups, alerts…), with optional native toasts and webhook mirroring.

**audit log** — an append-only local record of lifecycle actions, config changes, plugin installs, backups, and task runs.

**kern-cli** — the command line for a running kern. full-screen dashboard with no arguments.

**automation api** — the loopback, bearer-token json api on `127.0.0.1` that `kern-cli` speaks.

**web remote** — the optional https control panel on your lan, paired by qr.

**reactor channel** — the cpu/ram telemetry bar in the instance header. amber above 90%, red on fault.

**server type** — a plugin id (`custom`, `minecraft_java`, `discord_bot`). `custom` means "just run this command".
