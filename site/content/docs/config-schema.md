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
  { "key": "runtime", "label": "Server Software", "type": "select",
    "options": ["vanilla","paper","purpur","fabric","forge","neoforge","quilt"], "default": "purpur" },
  { "key": "mc_version", "label": "Minecraft Version", "type": "text", "default": "1.21" },
  { "key": "jvm_args",   "label": "JVM Arguments", "type": "text", "default": "-Xms2G -Xmx2G" }
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

fields may declare `dependsOn` to cascade defaults when another field changes. the minecraft plugin uses this so that picking `fabric` adjusts the suggested installer and `server_jar`.

> **note** keep config fields minimal. every field is one more decision a user has to make to get a server running. ship sensible `default`s.
