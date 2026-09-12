---
title: config.json
group: Reference
slug: config-json
order: 30
description: the host's registry file — every setting and instance field.
updated: 2026-09-12
---

# config.json

kern's state lives in a single JSON document at `<app_data>/config.json`:

```json
{
  "version": "2.0.0",
  "settings": { "...": "..." },
  "servers": {
    "srv_a1b2c3": { "id": "srv_a1b2c3", "...": "..." }
  }
}
```

> **warn** the app owns this file. it rewrites it on every change, and manual edits made while kern is running are overwritten. prefer the ui or the [automation api](/docs/automation-api); edit the file only with kern closed.

## settings

| key | type | default | meaning |
|---|---|---|---|
| `defaultSandboxPath` | string | `<app_data>/servers` | where new instances go unless a custom path is chosen |
| `launchOnLogin` | bool | `false` | register kern as an os-login item |
| `closeToTray` | bool | `true` | close (×) hides to the tray instead of quitting |
| `startHiddenInTray` | bool | `false` | stay hidden when launched by the os at login |
| `trayRadar` | bool | `true` | animate the tray icon as a live radar |
| `powerPricePerKwh` | number | `0` | local price; `0` disables the energy meter |
| `machineWatts` | number | `120` | average draw for cost estimation |
| `registryUrl` | string | `https://kern.aaenz.no` | plugin registry base url |
| `webRemoteEnabled` | bool | `false` | serve the lan control panel |
| `webRemotePort` | number | `7440` | https port for the web remote |
| `nativeNotifications` | bool | `true` | mirror notifications to os toasts when unfocused |
| `webhookUrl` | string | `""` | discord/slack/generic webhook |
| `webhookEnabled` | bool | `false` | master switch for webhook delivery |
| `logAlerts` | array | `[]` | `{ id, name, pattern, enabled }` regex rules over streamed logs |
| `automationEnabled` | bool | `true` | serve the loopback [automation api](/docs/automation-api) |
| `automationPort` | number | `7442` | loopback port |
| `syncRepoUrl` | string | `""` | git remote for registry export/import |

`webRemotePassphrase` is a legacy field kept so older files parse.

## instance fields

each entry in `servers` is an instance. the fields you'll actually touch:

| key | type | meaning |
|---|---|---|
| `id` | string | stable `srv_…` id |
| `name` | string | display name |
| `serverType` | string | plugin id (`custom`, `minecraft_java`, `discord_bot`, …) |
| `path` | string | the instance folder |
| `status` | string | `stopped` \| `running` \| `error` \| `stopped-forced` \| transitional states |
| `isOrphaned` | bool | folder missing; set automatically |
| `userOverrides` | object | config-form values, referenced as `{{userOverrides.*}}` |
| `autoStart` | bool | launch with kern |
| `stopCommand` | string? | stdin line for graceful stop; `""` skips stdin, absent uses the plugin default |
| `stopTimeoutSecs` | number | graceful window before force-kill (default `30`) |
| `group` | string? | sidebar group / fleet filter |
| `tags` | string[] | lowercase labels; `--tag` filters |
| `watchdog` | object | `{ enabled, maxAttempts }` crash auto-restart |
| `tasks` | array | see [scheduled tasks](/docs/tasks) |
| `backupSchedule` | object | `{ intervalSecs, keep, onStop, lastBackupSecs }` |
| `alertRules` | object | `{ cpuThreshold, ramThreshold, sustainedSecs, crossedSinceSecs }` |
| `rcon` | object | `{ host, port }` — password lives in the os keyring |
| `commandHistory` / `commandSnippets` | string[] | terminal conveniences |
| `lastPorts` | number[] | last observed listening ports (preflight) |

host-managed fields (`status`, `pid`, `pidStarted`, `isOrphaned`, `lastBackupSecs`, `crossedSinceSecs`, `lastPorts`, task run stamps) are written by kern — `PATCH` and the ui preserve them even if your copy is stale.

## instance state after a crash

if kern quits while servers are running, it **detaches** them rather than killing them. the next launch finds each persisted `pid` + `pidStarted`, verifies the process is still alive and identical (recycled pids fail the start-time check), and re-adopts it as a pid-only monitor. adopted instances show a distinct badge and support metrics and force-stop, but no stdin or log streaming — kern no longer owns their pipes.

## schema version

`version` tracks the document schema. unknown fields are ignored, new fields default, so a config written by an older kern loads cleanly. downgrades aren't supported — back up `config.json` before rolling back.
