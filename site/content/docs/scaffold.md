---
title: scaffold
group: Plugin development
slug: scaffold
order: 4
description: starter files written into a fresh instance directory.
---

# scaffold

the `scaffold` block declares starter files kern writes into a fresh instance directory. each entry has a `path`, `content`, and an optional `when` condition. content supports `{{userOverrides.*}}` templating.

```jsonc
"scaffold": {
  "env":    { "path": ".env",   "content": "PORT={{userOverrides.port}}\nLOG_LEVEL={{userOverrides.log_level}}\n" },
  "readme": { "path": "README.md", "content": "Web API ({{userOverrides.port}})…" },
  "entry":  { "path": "app.js", "content": "…", "when": "{{userOverrides.runtime}} == 'node'" }
}
```

## when conditions

`when` gates whether a file is written. this lets runtime-conditional scaffolding generate only the right starter files — the discord bot plugin uses this to emit package.json only for node/bun/deno runtimes, and a cargo manifest only for rust.

> **note** scaffold runs once when the instance is created (or on explicit `install`). it does not clobber existing files on subsequent starts.
