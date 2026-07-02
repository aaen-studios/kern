---
title: lifecycle
group: Plugin development
slug: lifecycle
order: 3
description: start, stop, restart, install — commands and templating.
---

# lifecycle

the `lifecycle` block declares named steps. each step has a `command`, an `args` array, and an optional `useShell` flag. commands are resolved at launch by rust.

## templating

commands and args support `{{userOverrides.*}}` templating, resolved from the config form the host rendered (see `config-schema`):

```jsonc
"lifecycle": {
  "start": {
    "command": "{{userOverrides.java_path}}",
    "args": ["{{userOverrides.jvm_args}}", "-jar", "{{userOverrides.server_jar}}", "--nogui"]
  }
}
```

## runtime-qualified keys

some plugins need different commands per runtime. **runtime-qualified keys** win when an override matches. the dotted form `start.<runtime>` overrides the base `start`:

```jsonc
"lifecycle": {
  "start":       { "command": "node", "args": ["{{userOverrides.entry}}"] },
  "start.bun":   { "command": "bun",  "args": ["{{userOverrides.entry}}"] },
  "start.deno":  { "command": "deno", "args": ["run", "--allow-net", "{{userOverrides.entry}}"] },
  "start.rust":  { "command": "{{userOverrides.binary}}", "useShell": true }
}
```

the discord bot plugin uses exactly this pattern across its four runtimes (`node`, `bun`, `deno`, `rust`).

## useShell

set `useShell: true` to run the command through a shell. needed for some installers (forge) that expect shell semantics.

## graceful shutdown

`stop` triggers a **graceful shutdown with a 15-second timeout** before hard-kill. this is deliberately tuned so minecraft world saves complete — chunk flush plus `level.dat` — before teardown.

> **warn** don&rsquo;t put destructive commands in `stop`. the host will hard-kill after 15s if your command hasn&rsquo;t returned, but you should design `stop` to return promptly (e.g. send a `stop` to the server stdin, not a `kill -9`).
