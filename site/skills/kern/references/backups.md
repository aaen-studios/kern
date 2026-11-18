<!-- generated from content/docs/backups.md - edit the source in kern-web, then run: npm run skill:build -->

# backups

kern snapshots an instance's `world/` directory into a zip under `<instance>/backups/`:

```
<instance>/
├─ world/
└─ backups/
   ├─ world-2026-09-12T04-00-02.zip
   ├─ world-2026-09-11T04-00-01.zip
   └─ pre-restore-1789237801.zip
```

names are timestamped, so listing is sorting. a restore always snapshots the current world as `pre-restore-<epoch>.zip` before touching anything.

## manual snapshots

**ui** — the monitor tab has **snapshot now**.
**cli** — `kern-cli backup create "My Server" --wait`.
**api** — `POST /servers/{id}/backup` (answers `202` and runs in the background).

kern refuses a backup that wouldn't fit on disk rather than filling the drive half-way through.

## schedules

each instance has a backup schedule:

| field | meaning |
|---|---|
| `intervalSecs` | snapshot every n seconds. `0` disables the interval. `7200` = every 2h |
| `keep` | rolling retention — oldest archives beyond this count are pruned |
| `onStop` | also snapshot whenever the instance stops cleanly |
| `lastBackupSecs` | host-managed; the scheduler writes it after each run |

set it in the instance's **monitor → backups** panel or via `PATCH`-ing the config. the scheduler runs on the same 30-second worker as alerts and task runs, so an interval is approximate to within a tick.

> **note** retention pruning runs after every snapshot. if you snapshot into a folder that also holds one-off archives, keep `keep` generous.

## restore

**cli** — `kern-cli backup restore "My Server" world-2026-09-12T04-00-02.zip --yes`
**api** — `POST /servers/{id}/backups/{name}/restore`

the restore:

1. zips the current `world/` to a `pre-restore` archive (your undo),
2. deletes `world/`,
3. extracts the chosen archive into a fresh `world/`.

archive entries are path-checked; an entry pointing outside `world/` aborts the restore.

> **warn** stop the instance first. restore replaces files on disk while a running server may still be writing them — `kern-cli stop "My Server" --wait` then restore, then `start`.

## deleting

**cli** — `kern-cli backup delete "My Server" old.zip --yes`
deletion is immediate and cannot be undone; the `pre-restore` archives are ordinary backups and can be deleted the same way (do it knowingly — that's your undo).

## what isn't backed up

only `world/`. plugins, configs, and jars are code — keep those in git. a backup restore won't resurrect `server.properties` or plugin data.

## automation recipes

nightly backup + restart, with the backup running before the restart:

```
04:00 daily → backup → broadcast "restarting" → stop → start
```

see [tasks](./tasks.md) for the schedule grammar and [recipes](./recipes.md) for webhook notifications on backup failure.
