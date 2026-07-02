---
title: config schema
group: Plugin development
slug: config-schema
order: 5
description: dynamic config forms the host renders for each instance.
---

# config schema

`configSchema` is an array of fields. the **host renders this as a dynamic form** when creating or editing a server instance — plugins never build their own config ui for the basics. the resolved values become `userOverrides`, available to `lifecycle` and `scaffold` via `{{userOverrides.*}}`.

## field types

```jsonc
"configSchema": [
  { "key": "port", "label": "Port", "type": "text", "default": "3000" },
  { "key": "log_level", "label": "Log Level", "type": "select",
    "options": ["debug","info","warn","error"], "default": "info" },
  { "key": "max_connections", "label": "Max Connections", "type": "text", "default": "100" }
]
```

| field | type | notes |
|---|---|---|
| `key` | string | the userOverrides key. |
| `label` | string | shown in the form. |
| `type` | `"text"` \| `"select"` | the two supported types today. |
| `default` | string | used on fresh instances. |
| `options` | string[] | only for `select`. |

## dependsOn — cascading defaults

fields may declare `dependsOn` to cascade defaults when another field changes. for example, a plugin can use this so that picking a runtime adjusts the suggested entry file and build command.

> **note** keep config fields minimal. every field is one more decision a user has to make to get a server running. ship sensible `default`s.
