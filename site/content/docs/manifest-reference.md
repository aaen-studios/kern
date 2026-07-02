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
  "id": "minecraft_java",
  "displayName": "Minecraft Java Server",
  "version": "1.2.0",
  "author": "kern/sample",
  "description": "Run and manage Minecraft Java Edition servers…",
  "uiEntry": "dist/index.js",

  "configSchema": [
    { "key": "runtime", "label": "Server Software", "type": "select",
      "options": ["vanilla","paper","purpur","fabric","forge","neoforge","quilt"], "default": "purpur" },
    { "key": "mc_version", "label": "Minecraft Version", "type": "text", "default": "1.21" },
    { "key": "jvm_args",   "label": "JVM Arguments", "type": "text", "default": "-Xms2G -Xmx2G" }
  ],

  "lifecycle": {
    "start":        { "command": "{{userOverrides.java_path}}",
                      "args": ["{{userOverrides.jvm_args}}", "-jar", "{{userOverrides.server_jar}}", "--nogui"] },
    "start.forge":  { "command": "{{userOverrides.server_jar}}", "args": ["nogui"], "useShell": true }
  },

  "scaffold": {
    "eula":   { "path": "eula.txt",   "content": "eula={{userOverrides.accept_eula}}\n" },
    "readme": { "path": "README.txt", "content": "Minecraft Server ({{userOverrides.mc_version}})…" }
  },

  "tabs": [ { "id": "mc-setup", "label": "Setup" }, { "id": "mc-chat", "label": "Chat" } ]
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

> **warn** `id` must be lowercase with underscores only. `minecraft_java` is valid; `Minecraft-Java` is not.
