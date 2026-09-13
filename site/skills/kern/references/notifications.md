<!-- generated from content/docs/notifications.md - edit the source in kern-web, then run: npm run skill:build -->

# notifications, webhooks & alerts

every event kern surfaces — crashes and watchdog restarts, health alerts, backup results, schedule runs, update checks — lands in the **notification center** (the bell in the title bar, with jump-to-server). when the window isn't focused, the same notification is mirrored to a **native os toast**.

## do not disturb

settings → notifications & alerts → *native os notifications* removes the os mirror while keeping the in-app center. the setting is stored in `config.json` and survives restarts.

## webhooks

set a **webhook url** and enable *send webhook events*. every notification is posted as json:

```json
{ "content": "[error] Server crashed\nexit 1", "text": "[error] Server crashed\nexit 1" }
```

`content` is what discord reads; `text` is what slack incoming webhooks read. a generic consumer gets both. delivery is best-effort with a 10-second timeout — a dead endpoint never blocks a lifecycle action.

## log alerts

rules are regular expressions matched against every streamed log line. a match raises a notification (and fires the webhook), throttled to once per minute per rule so a repeating error can't spam you.

| rule | pattern |
| --- | --- |
| out of memory | `OutOfMemoryError` |
| server lag | `(?i)can't keep up` |
| server errors | `\[Server thread/ERROR\]` |

patterns use rust regex syntax. invalid patterns are skipped with a note in the app log rather than disabling the other rules. manage rules under settings → notifications & alerts.
