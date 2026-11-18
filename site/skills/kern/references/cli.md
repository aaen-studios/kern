<!-- generated from content/docs/cli.md - edit the source in kern-web, then run: npm run skill:build -->

# kern-cli

`kern-cli` controls a **running** kern app from the terminal or a script. it talks to the loopback [automation api](./automation-api.md) on `127.0.0.1` with a bearer token the app publishes for it — you never configure an address.

it installs alongside the app on windows (`%localappdata%\kern\kern-cli.exe`) and ships as a release asset (`kern-cli`, `kern-cli.exe`) on every platform.

```bash
kern-cli status
kern-cli list
kern-cli start "My Server" --wait
kern-cli logs "My Server" --follow --grep ERROR
```

run bare `kern-cli` on a terminal for the **dashboard** (below). `kern-cli help` lists everything; every command has `--help`.

## commands

### observe

| command | what it does |
|---|---|
| `status` | app version, api version, host cpu/ram, running count |
| `list` | fleet table: status, cpu, ram, uptime, group |
| `show <server>` | one instance in detail, including ports and last crash |
| `top` | live fleet view (`--once` for a single snapshot) |
| `host` | host-wide cpu/ram |
| `metrics <server>` | metric history (`--spark` for sparklines, `--window 86400`) |
| `energy <server>` | estimated running cost from your power price |
| `port <server>` | listening ports + quick-connect strings |
| `events` | audit feed with status transitions (`--follow` to stream) |
| `audit` | the audit log (`--limit`, `--server`) |

### control

| command | what it does |
|---|---|
| `start <server…>` | start one or many |
| `stop <server…>` | graceful stop (stdin → timeout → force-kill) |
| `restart <server…>` | stop then start |
| `install <server…>` | run the plugin's install lifecycle step |
| `wait <server> --for running\|stopped\|healthy` | block until a state |
| `send <server> <line…>` | write to the server's stdin (`say` is an alias) |

`start/stop/restart/install` accept fleet selectors instead of names:

```bash
kern-cli stop --tag prod --wait --timeout 2m
kern-cli restart --group minecraft
kern-cli start --all
```

`--wait` blocks until the action reaches its target state. `healthy` means running, clear of a fault status, and below 95% cpu/ram.

### logs

```bash
kern-cli logs "My Server" --lines 200
kern-cli logs "My Server" --follow
kern-cli logs "My Server" --follow --grep "OutOfMemory|FATAL" --exclude "at java"
kern-cli logs "My Server" --format json          # ndjson when following
```

`--follow` is offset-based: it streams only new lines, survives log rotation, and never re-reads the tail. `--grep` / `--exclude` take rust regex syntax.

### backups and tasks

```bash
kern-cli backup list "My Server"
kern-cli backup create "My Server" --wait
kern-cli backup restore "My Server" world-2026-09-12.zip --yes
kern-cli backup delete  "My Server" old-backup.zip --yes

kern-cli task list "My Server"
kern-cli task run  "My Server" nightly-restart
```

restore and delete require `--yes`; both are destructive.

### registry

```bash
kern-cli add ./my-api --name "Prod API" --type custom --group prod --tag live
kern-cli add ./paper-server --import            # adopt an existing folder
kern-cli inspect ./paper-server                 # see what import would detect
kern-cli edit "Prod API" --group staging --tag blue --auto-start
kern-cli rm "Prod API"
kern-cli rm "Prod API" --folder --yes           # also delete the directory
```

### plugins

```bash
kern-cli plugin list
kern-cli plugin validate ./my-plugin.kern
kern-cli plugin install ./my-plugin.kern
kern-cli plugin remove discord_bot
```

### diagnostics

```bash
kern-cli doctor          # endpoint file, connectivity, version alignment
kern-cli endpoint        # print the api url (--show-token, --format json)
kern-cli api GET /servers   # raw request against any endpoint
```

## global flags

| flag | effect |
|---|---|
| `--format table\|plain\|json` | table (default), tab-separated rows, or raw JSON |
| `--color auto\|always\|never` | ansi colors; `NO_COLOR` is respected |
| `-q, --quiet` | suppress informational output |
| `--version` | cli version |
| `-h, --help` | help for any command |

`--format json` prints the raw api response, so the cli doubles as a JSON client. `--format plain` is one record per line — friendly to `awk`/`cut`.

## exit codes

| code | meaning |
|---|---|
| `0` | success |
| `1` | runtime or api error |
| `2` | usage error (bad flags, unknown command) |
| `3` | server / plugin / backup / task not found |
| `4` | app unreachable (not running, automation off, stale token) |
| `5` | `--wait` timeout |

```bash
kern-cli wait "My Server" --for healthy --timeout 90s && echo "shipping"
```

## naming

targets resolve in this order: exact id → exact name (case-insensitive) → unique id/name prefix → unique substring. an ambiguous match lists the candidates and exits `3`, so `kern-cli stop api` can never quietly stop the wrong server when both `api-prod` and `api-staging` exist.

## environment

| variable | effect |
|---|---|
| `KERN_APP_DATA_DIR` | override the app data directory (endpoint discovery) |
| `KERN_AUTOMATION_URL` + `KERN_AUTOMATION_TOKEN` | talk to a different endpoint (tunnel / CI) |
| `NO_COLOR` | disable ansi colors |

## the dashboard

bare `kern-cli` (or `kern-cli dash`) opens a full-screen dashboard: fleet table, live log tail for the selected server, and an event ticker. it polls the same api, so it works over `KERN_AUTOMATION_URL` too.

```
 q quit · ↑↓ select · s start · x stop · r restart · b backup · i install · / filter · : command · ? help · PgUp/PgDn logs
```

| key | action |
|---|---|
| `↑` `↓` / `j` `k` | select a server |
| `s` `x` `r` `i` | start / stop (confirm) / restart (confirm) / install |
| `b` | back up the selected server |
| `PgUp` `PgDn` | scroll the log pane |
| `Home` `End` | log top / follow |
| `/` | filter the fleet |
| `:` | command bar — `start|stop|restart <name\|all>`, `backup <name>`, `filter <text>`, `clear`, `quit` |
| `?` | help |
| `q` / `ctrl+c` | quit |

## shell completions

```bash
kern-cli completions bash  > ~/.local/share/bash-completion/completions/kern-cli
kern-cli completions zsh   > "${fpath[1]}/_kern-cli"
kern-cli completions fish  > ~/.config/fish/completions/kern-cli.fish
kern-cli completions powershell | Out-String | Invoke-Expression
```

> **note** create an alias when the hyphen gets old: `alias kern=kern-cli`.

## common workflows

**deploy then restart, from a script**

```bash
kern-cli wait "Prod API" --for stopped --timeout 1m \
  && rsync -a ./build/ server:/srv/api/ \
  && kern-cli start "Prod API" --wait --timeout 2m
```

**watch for OOM across the fleet**

```bash
kern-cli logs "Minecraft" --follow --grep "OutOfMemoryError" | while read -r line; do
  echo "[oom] $line"
done
```

**morning fleet check**

```bash
kern-cli list --format plain | awk -F'\t' '$4 != "true" { print "down:", $2 }'
```

see [recipes](./recipes.md) for more.
