<!-- generated from content/docs/lifecycle.md - edit the source in kern-web, then run: npm run skill:build -->

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

`stop` sends the graceful shutdown first (stdin command and/or your plugin's `stop` step) and waits the instance's timeout before hard-kill. the timeout defaults to **30 seconds** and is configurable per instance (`stopTimeoutSecs`); the whole process tree is terminated after that, and the instance is reported as `stopped-forced`.

> **warn** don&rsquo;t put destructive commands in `stop`. the host will hard-kill after the timeout if your command hasn&rsquo;t returned, but you should design `stop` to return promptly (e.g. send a `stop` to the server stdin, not a `kill -9`).
