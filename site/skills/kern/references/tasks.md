<!-- generated from content/docs/tasks.md - edit the source in kern-web, then run: npm run skill:build -->

# scheduled tasks

every instance can carry its own scheduled tasks. a task fires when **any** of its configured schedule modes is due, and never twice in the same minute.

| field | meaning |
|---|---|
| `id` | stable id (host-generated) |
| `name` | label shown in the ui |
| `enabled` | off keeps the task but stops firing |
| `action` | `restart` \| `start` \| `stop` \| `command` \| `backup` \| `health` |
| `command` | payload — see below |
| `intervalSecs` | run every n seconds (`0` = unused) |
| `dailyAt` | local `HH:MM` (`""` = unused) |
| `cron` | 5-field cron: `min hour dom month dow` |
| `announceMinutes` | for restarts: minutes before the restart to warn players in the console |
| `lastRunSecs` | host-managed dedupe |

## actions

| action | `command` holds | effect |
|---|---|---|
| `restart` | `""` | graceful stop → start, with announcements |
| `start` / `stop` | `""` | lifecycle |
| `command` | the line | sent to stdin when running; run through the shell when stopped |
| `backup` | `""` | snapshot `world/` and prune to the retention count |
| `health` | `notify` or `restart` | checks the instance each tick; `restart` recovers a dead process |

## schedule examples

```
every 6h            intervalSecs = 21600
daily at 04:00      dailyAt = "04:00"
weekdays at 04:00   cron = "0 4 * * 1-5"
mondays at 03:30    cron = "30 3 * * 1"
```

restart tasks can announce a countdown:

```json
{
  "name": "nightly-restart",
  "action": "restart",
  "dailyAt": "04:00",
  "announceMinutes": [5, 1]
}
```

that sends the manifest's pre-restart console line at t-5m and t-1m (for minecraft: `say restarting in 5 minutes`) before stopping.

## running tasks

- **ui** — monitor → tasks has **run now** per task.
- **cli** — `kern-cli task list "My Server"`, `kern-cli task run "My Server" nightly-restart` (name or id).
- **api** — `POST /servers/{id}/tasks/{taskId}/run`.

every run lands in the [audit log](./automation-api.md) (`task` action) and raises a notification.

## notifications

task failures and backup results use the normal notification path — in-app center, native toast when unfocused, and your [webhook](./notifications.md) if configured. a webhook is the usual way to learn that a 4am restart didn't come back up.

> **note** a task's schedule lives in `config.json`; edits through the ui or `PATCH /servers/{id}` take effect on the next scheduler tick (up to 30s).
