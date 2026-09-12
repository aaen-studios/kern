---
title: cli & automation
group: Using kern
slug: cli
order: 20
description: control kern from the terminal or your own scripts.
---

# cli & automation

kern ships a command line tool, `kern-cli`, and a loopback-only json api for scripts. both talk to the **running app** — start kern first.

## kern-cli

`kern-cli` installs alongside the app on windows (`%localappdata%\kern\kern-cli.exe`) and ships as a release asset on every platform. it finds the app's endpoint automatically.

```
kern-cli status                        # app version + endpoint health
kern-cli list                          # id, status, name for every instance
kern-cli list --json                   # machine-readable
kern-cli start "My Server"             # by exact name, or by id (srv_…)
kern-cli stop "My Server"
kern-cli restart "My Server"
kern-cli logs "My Server" --lines 200
kern-cli logs "My Server" --follow     # poll and append new lines
kern-cli say "My Server" say hello     # write a line to the server's stdin
```

## automation api

the same actions are exposed as a json api bound to `127.0.0.1` only — it is never reachable from the lan. the port and bearer token are published to `automation.json` in the app data folder; `kern-cli` reads them for you. enable or disable it and copy the endpoint + token under **settings → automation & cli**.

```
GET  /status                        → { status, version }
GET  /servers                       → { servers: [{ id, name, status, running, metrics }] }
GET  /servers/{id}/log?lines=200    → { lines: [...] }
POST /servers/{id}/start            → starts the instance
POST /servers/{id}/stop             → graceful stop (accepted, runs async)
POST /servers/{id}/restart          → restart (accepted, runs async)
POST /servers/{id}/stdin            → body { "line": "say hi" } or raw text
```

every request needs `Authorization: Bearer <token>`.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7442/servers
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:7442/servers/srv_123/restart
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"line":"say hello"}' http://127.0.0.1:7442/servers/srv_123/stdin
```

> the automation api is for local scripts. for phone control over the lan, use the separate **web remote** (https + qr pairing) in settings.
