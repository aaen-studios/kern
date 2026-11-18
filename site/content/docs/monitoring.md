---
title: monitoring & alerts
group: Using kern
slug: monitoring
order: 14
description: telemetry, metric history, health alerts, crash reports, energy.
updated: 2026-09-12
---

# monitoring & alerts

## live telemetry

kern samples **process-tree** cpu and ram — a server's children count toward it (node workers, `cargo`/`rustc`, a jar's threads). the detail header draws this as the reactor channel: cpu shimmers along the top row, ram fills from the left, both turn amber past 90% and red on fault.

the fleet dashboard shows the same numbers for every instance at once. first sample after a start reads ~0% — `sysinfo` reports cpu as a delta between reads, so the spin-up settles over the first second.

```bash
kern-cli host                       # host cpu/ram
kern-cli top                        # live fleet view
kern-cli metrics "My Server" --spark
```

## history

a background worker records one sample per instance every 30 seconds into a rolling in-memory ring (about 7 days). the monitor tab graphs 24h / 7d cpu and ram. history is not persisted across restarts — it's telemetry, not a database.

```bash
kern-cli metrics "My Server" --window 86400 --spark
```

## health alerts

per-instance rules fire when a metric stays above a threshold for a sustained window:

| field | meaning |
|---|---|
| `cpuThreshold` | cpu fraction (`0.9` = 90%). `null` disables |
| `ramThreshold` | ram fraction of the whole machine |
| `sustainedSecs` | how long the threshold must hold before firing |

configure under **monitor → alerts**. a fired alert goes to the [notification center](/docs/notifications) (and your webhook) once, then re-arms after the value recovers. the alert state is also visible in the tray icon: amber sweep/blips and a tooltip marker.

## crash reports

when a process exits unexpectedly, kern writes the exit code plus the last log lines to `<app_data>/crashes/<id>.json` and shows a **last crash** card on the monitor tab.

```bash
kern-cli crash "My Server"
```

if the [watchdog](/docs/tasks) is enabled, the restart attempt is recorded too, and a crash-loop backs off exponentially instead of thrashing.

## listening ports

kern matches the instance's process tree against the os socket table and surfaces the ports it actually bound, with a copy-ready connect string.

```bash
kern-cli port "Minecraft"           # :25565 → localhost:25565
```

preflight uses the last-observed ports to warn before a start:

```bash
kern-cli preflight "Minecraft"
# ! port 25565 held by javaw.exe (pid 8123)
# ! minecraft eula is pending (edit eula.txt)
```

## energy & cost

with a power price and machine wattage set in settings, kern estimates each instance's running cost (draw scales between an idle baseline and full load):

```bash
kern-cli energy "My Server"
```

> **note** it's an estimate for "what does this habit cost me", not a meter. plug a real meter into the wall if the number matters.
