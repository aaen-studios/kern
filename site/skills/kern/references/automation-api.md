<!-- generated from content/docs/automation-api.md - edit the source in kern-web, then run: npm run skill:build -->

# automation api

kern exposes a plain-http JSON api bound to **`127.0.0.1` only** (never the lan). `kern-cli` is a client of this api; anything else — scripts, editors, ci — can be too.

enable it under **settings → automation & cli**. the endpoint and bearer token are published to `automation.json` in the app data directory:

```json
{
  "version": 2,
  "port": 7442,
  "token": "…64 hex chars…",
  "pid": 12345,
  "started_at": 1789237726
}
```

| platform | app data directory |
|---|---|
| windows | `%APPDATA%\com.ellio.kern` |
| macos | `~/Library/Application Support/com.ellio.kern` |
| linux | `$XDG_DATA_HOME/com.ellio.kern` (or `~/.local/share/com.ellio.kern`) |

every request needs `Authorization: Bearer <token>`:

```bash
TOKEN=$(jq -r .token "$APPDATA/com.ellio.kern/automation.json")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7442/status
```

```powershell
$ep = Get-Content "$env:APPDATA\com.ellio.kern\automation.json" | ConvertFrom-Json
Invoke-RestMethod -Uri "http://127.0.0.1:$($ep.port)/status" -Headers @{ Authorization = "Bearer $($ep.token)" }
```

> **note** `GET /status` reports `apiVersion`. this docs page describes **api v2** (kern v0.3.0+). v1 clients (`/status`, `/servers`, `/servers/{id}/log`, lifecycle, stdin) keep working — v2 only adds endpoints and fields.

## conventions

- all requests and responses are JSON (`content-type: application/json`).
- errors are `{ "error": "message" }` with a `4xx`/`5xx` status.
- `start`/`install` answer `200` once the action is underway. `stop`/`restart`/`backup`/`restore` answer `202 accepted` and finish in the background — poll the resource to observe completion.
- path segments are percent-encoded (`backups/world%202026.zip/restore`).
- request bodies are capped at 64 KiB; log reads at 2 MiB.

## endpoints

### app

| method | path | returns |
|---|---|---|
| `GET` | `/status` (alias `/health`) | `{ status, version, apiVersion, pid, host: { cpu, ram } }` |
| `GET` | `/host/metrics` | `{ cpu, ram, status: "host" }` |
| `GET` | `/audit?limit=100&since=<epoch>` | `{ entries: [...], now }` |
| `GET` | `/events?since=<epoch>&wait=30` | `{ entries, statuses: { id: status }, now }` |

### servers

| method | path | notes |
|---|---|---|
| `GET` | `/servers` | list; add `?ports=1` for a live port scan per running instance |
| `POST` | `/servers` | create; body `{ name, serverType, path, group?, tags?, autoStart?, imported?, userOverrides? }` → `201` |
| `GET` | `/servers/{id}` | detail: config + `pid`, `uptimeSecs`, `metrics`, `ports`, `lastCrash` |
| `PATCH` | `/servers/{id}` | sparse update: `name`, `group` (`null` clears), `tags`, `autoStart`, `stopCommand`, `stopTimeoutSecs`, `userOverrides` |
| `DELETE` | `/servers/{id}?folder=1` | remove the record; `folder=1` also deletes the working directory |
| `POST` | `/servers/{id}/start` | `200 { action: "started" }` |
| `POST` | `/servers/{id}/stop` | `202` — graceful stdin → timeout → force-kill |
| `POST` | `/servers/{id}/restart` | `202` |
| `POST` | `/servers/{id}/install` | `200` — runs the plugin's install step |
| `POST` | `/servers/{id}/stdin` | body `{ "line": "say hi" }` (raw text also accepted) |
| `GET` | `/servers/{id}/log?lines=200&offset=<bytes>` | `{ lines, nextOffset, size, reset, running }` |
| `GET` | `/servers/{id}/metrics?window=3600` | `{ windowSecs, samples: [{ at, cpu, ram }] }` |
| `GET` | `/servers/{id}/energy` | `{ id, hours, estWatts, cost, currencyNote }` |
| `GET` | `/servers/{id}/preflight` | `{ conflicts: [{ port, pid, process }], eulaPending, lowDisk, freeMb }` |
| `GET` | `/servers/{id}/crash` | `{ crash: null \| { at, exitCode, forced, tail } }` |
| `GET` | `/servers/{id}/tasks` | `{ tasks: [...] }` |
| `POST` | `/servers/{id}/tasks/{taskId}/run` | `{ ok: true }` |
| `GET` | `/servers/{id}/backups` | `{ backups: [{ name, size }] }` |
| `POST` | `/servers/{id}/backup` | `202` — snapshot now |
| `POST` | `/servers/{id}/backups/{name}/restore` | `202` — world is snapshotted before the overwrite |
| `DELETE` | `/servers/{id}/backups/{name}` | `{ ok: true }` |
| `GET` | `/inspect?path=<dir>` | import inspection: jars, start scripts, world/eula flags, suggested runtime/name |

### plugins

| method | path | notes |
|---|---|---|
| `GET` | `/plugins` | installed manifests |
| `POST` | `/plugins/install` | body `{ path, force? }` — path to a local `.kern` → `201` manifest |
| `POST` | `/plugins/validate` | body `{ path }` → `{ valid, manifest \| error }` (never errors on a bad package) |
| `DELETE` | `/plugins/{id}` | uninstall |

### streaming logs without re-reading

`/servers/{id}/log` is offset-based. start with `offset=0` to get the tail, then keep the returned `nextOffset`:

```bash
OFFSET=0
while true; do
  BODY=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:7442/servers/srv_123/log?lines=200&offset=$OFFSET")
  echo "$BODY" | jq -r '.lines[]'
  OFFSET=$(echo "$BODY" | jq -r .nextOffset)
  sleep 1
done
```

`reset: true` means the log rotated or shrank; the response contains a fresh tail — clear your buffer and continue from `nextOffset`. a trailing partial line is held back until it completes, so no output is ever split mid-line.

### long-poll events

`/events` merges audit entries with the current status map. with `wait=30` it blocks until something new arrives or the wait elapses, which makes it a cheap push feed:

```bash
SINCE=$(date +%s)
while true; do
  BODY=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:7442/events?since=$SINCE&wait=30")
  echo "$BODY" | jq -r '.entries[] | "\(.at) \(.action) \(.detail)"'
  echo "$BODY" | jq -r '.statuses | to_entries[] | "\(.key): \(.value)"'
  SINCE=$(echo "$BODY" | jq -r .now)
done
```

`entries` are oldest-first (`{ at, action, detail, serverId? }`). `statuses` is the full `id → status` map; diff consecutive responses to catch crash/restart transitions that don't produce an audit entry.

`wait` is capped at 30 seconds; keep your http timeout above it.

### creating an instance end-to-end

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Prod API","serverType":"custom","path":"/srv/api","group":"prod","tags":["live"]}' \
  http://127.0.0.1:7442/servers
# → 201 { "id": "srv_a1b2c3", ... }

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:7442/servers/srv_a1b2c3/start
```

## status codes

| code | when |
|---|---|
| `200` | success |
| `201` | created (server, plugin install) |
| `202` | accepted — stop/restart/backup/restore run in the background |
| `400` | invalid body, missing parameter, or a failed validation |
| `401` | missing/incorrect bearer token |
| `404` | unknown server/plugin/backup, or unknown route |
| `413` / `431` | body / headers too large |
| `500` | internal error |

> **warn** the api cannot create or delete users (there are none) and never binds beyond `127.0.0.1`. for phone control over the lan see [web remote](./web-remote.md) — a separate, token-paired https server.

## clients

`kern-cli` wraps every endpoint with typed output. for anything it doesn't cover, `kern-cli api` is a raw passthrough:

```bash
kern-cli api GET /servers
kern-cli api PATCH /servers/srv_a1b2c3 --body '{"group":"staging"}'
```
