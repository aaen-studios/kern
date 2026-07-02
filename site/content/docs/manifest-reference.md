---
title: manifest reference
group: Plugin development
slug: manifest-reference
order: 2
description: the full manifest.json schema as a reference.
---

# manifest reference

a `.kern` file is a **zip archive** containing `manifest.json` (required), an optional `dist/index.js` esm ui bundle, an optional `dist/index.css`, and any other assets the bundle references.

the manifest declares metadata, a dynamic config form, lifecycle commands, starter files, and ui tabs.

## full example

```jsonc
{
  "id": "web_api",
  "displayName": "Web API Server",
  "version": "1.0.0",
  "author": "kern/official",
  "description": "Run a Node.js/Express web API with env-based config, health checks, and pm2 or nodemon for hot reload.",
  "uiEntry": "dist/index.js",

  "configSchema": [
    { "key": "port", "label": "Port", "type": "text", "default": "3000" },
    { "key": "log_level", "label": "Log Level", "type": "select",
      "options": ["debug","info","warn","error"], "default": "info" }
  ],

  "lifecycle": {
    "start": { "command": "node", "args": ["{{userOverrides.entry}}"] },
    "start.nodemon": { "command": "nodemon", "args": ["{{userOverrides.entry}}"], "useShell": true }
  },

  "scaffold": {
    "env": { "path": ".env", "content": "PORT={{userOverrides.port}}\nLOG_LEVEL={{userOverrides.log_level}}\n" },
    "readme": { "path": "README.md", "content": "Web API ({{userOverrides.port}})…" }
  },

  "tabs": [ { "id": "setup", "label": "Setup" }, { "id": "logs", "label": "Logs" } ]
}
```

## field reference

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | unique, lowercase, underscores. the registry key. |
| `displayName` | string | yes | human name. |
| `version` | string | yes | semver. |
| `author` | string | yes | `kern/sample`, `kern/official`, or a github handle. |
| `description` | string | yes | one-liner for cards/detail. |
| `uiEntry` | path | no | `dist/index.js` — the esm bundle exposing `mount(hostApi)`. |
| `configSchema` | field[] | no | the dynamic config form (see `config-schema`). |
| `lifecycle` | object | no | named lifecycle steps (see `lifecycle`). |
| `scaffold` | object | no | starter files written into a fresh instance (see `scaffold`). |
| `tabs` | tab[] | no | declarative tabs the plugin registers in the detail view. |

> **warn** `id` must be lowercase with underscores only. `web_api` is valid; `Web-API` is not.
