---
title: recipes
group: Using kern
slug: recipes
order: 18
description: copy-paste setups — backups, alerts, deploys, overnight restarts.
updated: 2026-09-12
---

# recipes

small, complete setups built from kern's own knobs. each one is just config + a task or two.

## nightly backup before restart

the safe restart: snapshot, warn players, restart, and only then prune.

1. instance → **monitor → backups**: `intervalSecs: 0`, `onStop: true`, `keep: 14`.
2. instance → **tasks** → new task:
   - action `backup`, `dailyAt "03:55"`
   - action `restart`, `dailyAt "04:00"`, `announceMinutes [5, 1]`

the 03:55 backup runs while the server is still up; the restart's `onStop` snapshot catches anything written in those five minutes.

## discord ping when a server dies

1. settings → notifications → **webhook url**: paste your discord webhook.
2. enable **send webhook events**.
3. instance → **monitor → watchdog**: enable auto-restart (max 5 attempts).

crash, restart attempts, and give-up events all hit the webhook. every payload carries both `content` (discord) and `text` (slack).

## alert on OOM before it kills the server

1. instance → **monitor → alerts**: cpu threshold `0.9`, sustained `60s`.
2. settings → notifications → add a log alert rule: pattern `OutOfMemoryError|java\.lang\.OutOfMemory`, enabled.

log alerts fire from the streamed console the moment the line appears — usually minutes before the process actually dies.

## deploy and restart, from ci

```bash
#!/usr/bin/env bash
set -euo pipefail

kern-cli stop "Prod API" --wait --timeout 60s
rsync -a --delete ./build/ deploy@host:/srv/api/
kern-cli start "Prod API" --wait --timeout 120s
kern-cli wait "Prod API" --for healthy --timeout 60s
echo "deployed $(date -u +%FT%TZ)"
```

exit codes make failures loud: `3` if the instance was renamed, `4` if kern isn't running, `5` if it never came healthy.

## morning fleet check

```bash
kern-cli list --format plain | awk -F'\t' '$4 != "true" { print "down:", $2 }'
kern-cli list --format plain | awk -F'\t' '$4 == "true" { n++ } END { print n " up" }'
```

## stop everything when you leave the house

one task per instance — or a single fleet command from a shortcut / phone automation:

```bash
kern-cli stop --tag minecraft --wait --timeout 2m
```

## crash loop breaker

watchdog with a low attempt count turns a broken plugin into five attempts and a notification instead of an all-night restart loop:

- **monitor → watchdog**: attempts `3`.
- **monitor → alerts**: ram threshold `0.85`, sustained `120s` — memory creep usually precedes the crash.

`kern-cli crash "Minecraft"` then shows the exit code and the last lines, no log spelunking.

## import an existing paper server

```bash
kern-cli inspect ./paper-1.21            # jars, world, eula, suggested runtime
kern-cli add ./paper-1.21 --import --name "Paper" --group minecraft
kern-cli start "Paper" --wait
```

`--import` adopts the folder as-is — kern never moves or rewrites files it didn't create.

## stream logs into your own alerting

```bash
kern-cli logs "Minecraft" --follow --grep "ERROR|FATAL" --format json \
  | jq -r '.line' \
  | while read -r line; do curl -s -X POST "$ALERT_URL" -d "$line"; done
```

offset-based following means no duplicate lines, even across rotations.
