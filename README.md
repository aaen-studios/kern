# kern

A desktop server manager for Windows, macOS, and Linux. Register any project as a server instance, configure it via plugins, and control its lifecycle from a clean custom UI.

**Manage any server instance — Minecraft, bots, APIs — with a live terminal, plugin extensibility, and graceful lifecycle control.**

## Features

- **Server Registry**: Register, edit, and remove server instances with custom paths and configuration
- **Lifecycle Controls**: Start / stop / restart / install with graceful shutdown and guaranteed process-tree termination (Windows Job Objects / Unix process groups)
- **Live Terminal**: Stream process output with ANSI colors, send stdin commands
- **Per-instance Settings**: Graceful-stop command/timeout, a feature visibility catalogue, crash watchdog policy, and scheduled tasks
- **Plugin System**: Extend kern with `.kern` packages defining custom launch commands, config forms, and UI panels — with manifest permissions, install consent, and checksum verification
- **File Editor**: Browse and edit files within instance directories, with snapshots and rollback
- **Monitoring**: Real-time CPU/RAM telemetry, fleet dashboard, health alerts, port detection
- **Preflight Checks**: Warns about port conflicts (with owning PID), pending Minecraft EULA, and low disk space before a start
- **World Backups**: Scheduled snapshots with restore/delete and on-stop hooks; refuses backups that won't fit on disk
- **Crash Watchdog**: Auto-restart with exponential backoff and notifications, with a "last crash" report (exit code + log tail)
- **RCON/Query**: Console, player list, and status for RCON-capable servers (password in the OS keyring)
- **Live Tray Radar**: The tray icon animates as a mini radar — sweep speed follows CPU load, one pulsing blip per running server, colors show health, and a fault blinks crimson
- **Notification Center**: Persistent history with jump-to-server, native OS toasts when unfocused, and outbound Discord/Slack webhooks
- **Log Alerts**: User-defined regex rules matched against streamed logs (e.g. `OutOfMemoryError`)
- **Import Existing Servers**: Adopt an existing server folder — jar/script detection suggests the runtime automatically
- **Automation API + `kern-cli`**: Versioned loopback-only JSON API (v2) and a scriptable CLI with a full-screen dashboard, fleet selectors, log filtering, backups/tasks, and shell completions
- **Audit Log**: Local history of lifecycle actions, config changes, plugin installs, backups, and task runs (exportable)
- **Scheduled Tasks**: Interval/daily/cron tasks with pre-restart console announcements and run-now
- **Web Remote**: Self-signed HTTPS mobile control panel paired by QR code, with an optional Cloudflare quick tunnel for access from anywhere
- **Auto-Updater**: Signed in-app updates via GitHub Releases

## Quick Start

```bash
# Install dependencies
bun install

# Run development build
bun tauri dev
```

Navigate to the Plugins page to install server type plugins, then register instances pointing to your server directories.

## Plugin System

Plugins extend kern's capabilities through `.kern` zip archives containing:

- **`manifest.json`** — defines lifecycle commands (`install/start/stop`), configuration schema, and scaffold files
- **`ui.js`** (optional) — custom React component for UI panels, tabs, and toolbar actions

Plugins can be installed via:

- The Plugin Manager UI (drag-and-drop or file picker)
- Double-clicking `.kern` files in the OS file manager (deep link support)

Plugins live in `<app_data>/plugins/` and may declaratively:

- Generate server forms with dropdowns, text fields, and cascading defaults
- Provide starter files via the scaffold system
- Register custom tabs, toolbar actions, and sidebar items
- Override default lifecycle steps (e.g., custom start commands for Rust bots)

## Automation & CLI

kern serves a **loopback-only** JSON API on `127.0.0.1:7442` (never exposed to
the network) with a Bearer token published in `<app_data>/automation.json`.
The bundled `kern-cli` reads it automatically (installed alongside the app as
`%LOCALAPPDATA%\kern\kern-cli.exe`, or built at
`src-tauri/target/<profile>/kern-cli.exe`). Full references:
[docs/cli](https://kern.aaenz.no/docs/cli) · [docs/automation-api](https://kern.aaenz.no/docs/automation-api).

Run `kern-cli` with no arguments for the interactive dashboard (fleet table,
live log tail, event ticker). Everything is scriptable:

```bash
kern-cli status                              # app + host, api version
kern-cli list --running --tag prod           # fleet queries
kern-cli start "My Server" --wait --timeout 2m
kern-cli stop --group minecraft --wait       # fleet actions
kern-cli logs "My Server" --follow --grep ERROR
kern-cli backup create "My Server" --wait
kern-cli task run "My Server" nightly-restart
kern-cli events --follow                     # audit + status transitions
kern-cli doctor                              # diagnose setup problems
kern-cli completions zsh > ~/.zfunc/_kern-cli
```

Exit codes are scriptable: `0` ok · `1` error · `2` usage · `3` not found ·
`4` app unreachable · `5` timeout. `--format json|plain|table` and `--color`
control output; `--json` still works.

The same API is scriptable directly — URL and token are shown under
Settings → automation & CLI:

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7442/servers
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7442/servers/srv_123/restart
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -d '{"line":"say hello"}' http://127.0.0.1:7442/servers/srv_123/stdin
```

Endpoints (v2): `GET /status`, `GET /servers[?ports=1]`, `GET|POST|PATCH|DELETE /servers[/{id}]`,
`POST /servers/{id}/{start|stop|restart|install|stdin|backup}`,
`GET /servers/{id}/{log|metrics|energy|preflight|crash|tasks|backups}`,
`POST /servers/{id}/tasks/{taskId}/run`, `POST|DELETE /servers/{id}/backups/…`,
`GET /host/metrics`, `GET /inspect?path=`, `GET|POST|DELETE /plugins…`,
`GET /audit`, `GET /events?since=&wait=` (long-poll).

## Notifications, webhooks & log alerts

- **Native toasts**: in-app notifications are mirrored to OS notifications when
  the window isn't focused. Turn off in Settings for Do Not Disturb.
- **Webhooks**: every notification can be POSTed as
  `{"content": …, "text": …}` — compatible with Discord and Slack incoming
  webhooks. Configure the URL under Settings → notifications & alerts.
- **Log alerts**: regex rules (Rust syntax) matched against every streamed log
  line, e.g. `OutOfMemoryError` or `(?i)can't keep up`, throttled to one
  notification per minute per rule.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Development

```bash
bun install
bun tauri dev
```

## Testing

```bash
bun test                                      # frontend unit tests (bun's runner)
bun run typecheck                             # TypeScript
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
```

CI runs the frontend build + tests on Ubuntu and the Rust tests + clippy on
Windows and Ubuntu (`.github/workflows/ci.yml`).

### End-to-end stop verification (Windows)

```bash
bun run e2e:stop
```

Boots the debug binary against a temporary app-data directory (debug-only
`KERN_APP_DATA_DIR` / `KERN_E2E_ISOLATED` overrides) and drives a real
graceful-stop and force-kill through the HTTPS web-remote API, asserting no
orphan processes survive.

## Building & Releasing

Releases are built locally and distributed through GitHub Releases; the in-app updater polls `releases/latest/download/update.json` for new versions.

### First-time setup

Generate a signing keypair (the public key is embedded in `tauri.conf.json`, the private key is gitignored at `src-tauri/updater.key`). Use a real password — an unencrypted private key is a universal backdoor if it ever leaks:

```bash
bun x tauri signer generate -w src-tauri/updater.key -p "choose-a-strong-password"
```

Copy `src-tauri/.env.example` to `src-tauri/.env` and set `UPDATER_PRIVATE_KEY_PASSWORD` to that password (deploy.sh exports it to the Tauri CLI). Keep a backup of the key in a password manager; losing it means existing installs can only be updated by restoring the same key.

### Cutting a release

Releases are automated by `.github/workflows/release.yml`. **Push a version
tag** and CI does the rest — builds Windows, Linux, and macOS, signs the
updater archives, merges the per-platform manifests into `update.json`, and
publishes the GitHub release that the in-app updater points at
(`releases/latest/download/update.json`):

```bash
# 1. Bump the version in package.json, src-tauri/tauri.conf.json, and
#    src-tauri/Cargo.toml (./deploy.sh <version> does this as part of a local
#    build), then commit.
git add -A && git commit -m "release: v0.3.0"

# 2. Tag and push — this triggers the Release workflow.
git tag v0.3.0
git push origin main --tags
```

One-time repository setup (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `src-tauri/updater.key` (the private key file, whole text) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password (or omit if none) |

You can also run the workflow from the Actions tab (`Release` →
*Run workflow*) for a version already committed; it creates the tag itself.

#### Manual / offline releases

`deploy.sh` still works standalone. It builds, signs, and stages everything a
release needs into `release-assets/`:

```bash
./deploy.sh [new_version]      # e.g. ./deploy.sh 0.2.0
```

- installer (`.exe` / `.AppImage` / `.dmg`)
- signed archive (`.exe.zip` / `.AppImage.tar.gz` / `.dmg.gz`) — the updater artifact
- `update-<platform>.json` — that platform's manifest fragment

Run it on each platform, then merge the fragments and upload:

```bash
node scripts/merge-update-json.mjs release-assets update.json
```

Attach `update.json` plus every installer/archive to the `v{version}` GitHub
release. The `update.json` **must** be on the release whose `/latest/download/`
URL the app checks.

### Unsigned builds

The installers are **not** OS-code-signed (no Authenticode / Developer ID
certificate), which is a deliberate cost decision. Consequences and workarounds:

- **Windows**: SmartScreen shows "Windows protected your PC — Unknown
  publisher". Users click *More info → Run anyway*. Installed copies update
  normally via the in-app updater.
- **macOS**: Gatekeeper may refuse the first launch. Right-click → *Open*, or
  `xattr -dr com.apple.quarantine kern.app`.
- **Linux**: no OS gate; the AppImage just runs.

Update integrity is still protected regardless: every update archive is
minisign-verified against the pubkey embedded in `tauri.conf.json` before
install. Only the initial download lacks OS trust.

### Standalone installer (optional)

`installer/` is a self-contained Windows installer app that can replace the
NSIS bundle:

- embeds the built `kern.exe` at compile time, producing one self-contained
  `kern-setup.exe`
- custom frameless titlebar matching the app shell: logo + wordmark, live
  status, minimize/close controls, a matrix progress lane with a signal-trail
  fill, a scanline sweep while working, a pulsing signal dot, and a glitch on
  failure (all motion respects `prefers-reduced-motion`)
- concise step list plus a slim grayed line showing the current action; success
  shows "signal acquired" and auto-closes after a short countdown when the app
  will be launched
- installs per-user to `%LOCALAPPDATA%\kern` (no admin/UAC), creates Start Menu
  and optional desktop shortcuts, registers an uninstaller, and writes the
  Windows "Apps & features" entry
- registers the `.kern` file association and `kern://` URL protocol under HKCU
  (removed on uninstall), so double-clicking a package works whether kern is
  already running or not
- every subprocess is spawned hidden (`CREATE_NO_WINDOW`) and all child stdio is
  discarded — the installer never opens a terminal window
- detects a missing WebView2 runtime and offers the download page
- understands the in-app updater flags: `/P` (passive) and `/R` (relaunch),
  ignores `/UPDATE`, and forwards the original app arguments sent after
  `/ARGS` to the relaunched app — so it can be shipped as the update artifact
- uninstalls cleanly through the installed `uninstall.exe`
  (or `kern-setup.exe /uninstall`, `/uninstall /S` for silent)

```bash
bun run installer:build                     # release
node scripts/build-installer.mjs --debug    # faster debug build
kern-setup.exe /demo                        # play the install UI, write nothing
```

To use it as the release installer (same archive + minisign shape as NSIS):

```bash
KERN_CUSTOM_INSTALLER=1 ./deploy.sh 0.3.0
```

### Custom Windows installer skin

The NSIS installer uses a custom frameless skin (the `nsNiuniuSkin` DirectUI engine) styled in the kern palette — near-black with a signal-green accent and the Signal Radar logo. The skin lives under `src-tauri/windows/nsis-skin/`:

- `skin/` — XML page layouts + PNG assets (buttons, checkboxes, caption controls, progress bar, logo, backgrounds). Committed.
- `skin.zip` — the zipped skin loaded at install time. **Gitignored**; regenerated by `bun run installer:skin`.
- `installer.nsi` — the Tauri NSIS template (install/uninstall lifecycle, shortcuts, registry, WebView2, updater `/P`/`/R` handling).
- The four `nsNiuniuSkin*.dll` engine plugins.

The PNGs are generated from inline SVG via `@resvg/resvg-js` (no Python/Pillow needed), sourcing the kern palette from `src/styles/global.css`. `bun tauri build` runs `scripts/prepare-nsis.mjs` automatically (via `beforeBuildCommand`) to stage `skin.zip`; only re-run the asset generator when the palette or logo changes:

```bash
bun run installer:assets   # regenerate all skin PNGs + skin.zip
bun run installer:skin     # re-zip skin/ only (after editing XML)
```

### No terminal windows, ever

kern is a GUI app and every subprocess it spawns — servers, Java probes, `git`
sync, `netstat`/`ss`/`lsof` port scans, lifecycle helpers, `taskkill` — is
started through `process::silent_command`, which applies Windows'
`CREATE_NO_WINDOW`. The installer's helpers use the same discipline. Two
guardrails keep it that way:

- `scripts/check-silent-spawns.mjs` (run in CI) fails on any raw
  `Command::new` that isn't suppression-safe;
- the Windows test `silent_command_child_owns_no_window` enumerates top-level
  windows and proves a hidden child owns none.

Shell commands that begin with `start` are rewritten to `start /B` so they run
in the hidden console. The one case kern cannot intercept is a `start` buried
inside a user-authored `.bat`/`.cmd` script — that script's own `start` will
still open the console window it explicitly asks for.

### Web remote firewall prompt

The first time the web remote binds to the LAN (`0.0.0.0`), Windows Firewall
shows its standard "allow access" dialog. This is an OS prompt, not a terminal.
Allow it for **Private networks** only; access is token-authenticated either
way. Binding the remote to `127.0.0.1` (Settings → web remote → bind address)
avoids the prompt entirely — the panel is then only reachable through the
cloudflare tunnel or your own reverse proxy. Full docs: `docs/web-remote.md`
(kern-web).