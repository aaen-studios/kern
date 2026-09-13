<!-- generated from content/docs/plugin-security.md - edit the source in kern-web, then run: npm run skill:build -->

# plugin security

plugins are how kern learns new server types, which means third-party code runs inside the app. the model is honest about what it is: a **capability boundary**, not a sandbox.

## the boundary

- plugin ui runs in a shadow root for **style** isolation, but shares the host webview realm — it is not a js sandbox.
- every call to the host goes through `HostAPI.invoke`, which checks the plugin's manifest permissions against a command → permission map. a command whose permission is absent **fails closed** — it isn't callable at all.
- unknown permission names in a manifest are rejected at install time; there is no way to smuggle a capability in.

## permission catalogue

| permission | grants |
|---|---|
| `servers:read` | read the server list and configuration |
| `servers:write` | create, edit, and delete servers; app settings |
| `files:read` | read files inside server directories |
| `files:write` | write, rename, delete files inside server directories |
| `process` | start/stop/control processes; run commands |
| `downloads` | download files and java runtimes |
| `backups` | create, restore, delete world backups |
| `metrics` | read cpu / ram / network metrics |
| `plugins:manage` | install and remove other plugins |
| `plugin:kv` | store plugin state in its private data store |
| `plugin:secrets` | store/read secrets in the os credential vault |
| `rcon` | connect to the server's rcon console |
| `sync` | export/import configuration to git |
| `ui` | read and write ui state |

declare only what you use. the install dialog shows the human-readable list — a plugin asking for `process` + `files:write` to "display weather" is a red flag you can see before installing.

## install consent & integrity

1. the `.kern` archive is inspected (`manifest.json` validated, path traversal rejected — zip-slip would otherwise be remote code execution).
2. required permissions are shown; installation proceeds only on explicit consent.
3. a sha256 checksum of the package is recorded. registry installs verify the checksum of the downloaded artifact; a mismatch aborts the install.

there is **no publisher signing** — the trust model is "consent + checksum", not verified identity. treat community plugins like browser extensions: install ones you trust.

## what a malicious plugin could do

honestly: with `process` and `files:write`, a plugin can run code as you. the boundary limits *silent* capability escalation (no undeclared filesystem walks, no plugin-manager calls it didn't ask for), and it makes capabilities visible at install time. it does not contain a determined attacker. if that matters for your threat model, audit the plugin's bundle before installing.

## writing safe plugins

- request the narrowest permissions that work; `plugin:kv` for state, `plugin:secrets` for tokens (never hardcode).
- validate `serverData` paths before use — the host gives you the instance path, not a promise the file exists.
- don't reach out of your shadow root to style or mutate the host.
- keep the install step idempotent and non-destructive.
