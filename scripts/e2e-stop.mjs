#!/usr/bin/env node
/**
 * End-to-end stop verification (isolated).
 *
 * Boots the debug kern binary against a temporary APPDATA directory (so the
 * real registry, servers, and keyring-backed app data are never touched),
 * registers a fake "custom" instance whose start command spawns a
 * `cmd.exe /C ping` process tree, then drives start + stop through the real
 * HTTPS web-remote API and asserts no process survives the stop.
 *
 * Usage:
 *   node scripts/e2e-stop.mjs        (or: bun scripts/e2e-stop.mjs)
 *
 * Exit codes: 0 = pass, 1 = fail, 2 = inconclusive (e.g. another kern instance
 * is already running, or the binary hasn't been built).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const EXE =
  process.platform === "win32"
    ? join(ROOT, "src-tauri", "target", "debug", "kern.exe")
    : join(ROOT, "src-tauri", "target", "debug", "kern");

if (process.platform !== "win32") {
  console.log("inconclusive: this harness currently automates Windows only");
  process.exit(2);
}
if (!existsSync(EXE)) {
  console.log(`inconclusive: ${EXE} not found — run 'cargo build' in src-tauri first`);
  process.exit(2);
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = 7441;
const APP_DATA = join(tmpdir(), `kern-e2e-${Date.now()}`);
const SERVER_DIR = join(APP_DATA, "server");
const CONFIG_PATH = join(APP_DATA, "config.json");

mkdirSync(SERVER_DIR, { recursive: true });
// A console process that exits cleanly when it reads "stop" on stdin. A batch
// loop with `set /p` reacts per line (PowerShell buffers stdin until EOF).
writeFileSync(
  join(SERVER_DIR, "e2e_console.bat"),
  [
    "@echo off",
    ":loop",
    "set /p line=",
    "if /i \"%line%\"==\"stop\" exit /b 0",
    "goto loop",
    "",
  ].join("\r\n"),
);

const settings = {
  defaultSandboxPath: SERVER_DIR,
  launchOnLogin: false,
  closeToTray: true,
  startHiddenInTray: true,
  powerPricePerKwh: 0,
  machineWatts: 120,
  registryUrl: "https://kern.aaenz.no",
  webRemoteEnabled: true,
  webRemotePort: PORT,
  webRemotePassphrase: "",
  syncRepoUrl: "",
};

const config = {
  version: "1",
  settings,
  servers: {
    srv_e2e: {
      id: "srv_e2e",
      name: "e2e tree",
      serverType: "custom",
      path: SERVER_DIR,
      status: "stopped",
      isOrphaned: false,
      userOverrides: { start_command: "ping -n 300 127.0.0.1" },
      autoStart: false,
      // Skip the stdin phase and force-kill after 3s so the test is quick but
      // still exercises the full staged pipeline.
      stopCommand: "",
      stopTimeoutSecs: 3,
    },
    srv_e2e_grace: {
      id: "srv_e2e_grace",
      name: "e2e graceful",
      serverType: "custom",
      path: SERVER_DIR,
      status: "stopped",
      isOrphaned: false,
      // A console process that exits cleanly when it receives "stop" on stdin.
      userOverrides: {
        start_command: "e2e_console.bat",
      },
      autoStart: false,
      stopCommand: "stop",
      stopTimeoutSecs: 10,
    },
  },
};

writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

function readToken() {
  const res = spawnSync(
    "cargo",
    ["run", "--quiet", "--example", "web_token", "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml")],
    { encoding: "utf8", env: { ...process.env } },
  );
  const token = (res.stdout ?? "").trim().split(/\r?\n/).pop()?.trim();
  if (!token) {
    console.error("failed to read web-remote token:", res.stderr);
    process.exit(2);
  }
  return token;
}

function tokenExists() {
  const res = spawnSync(
    "cargo",
    ["run", "--quiet", "--example", "web_token", "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml")],
    { encoding: "utf8", stdio: "pipe" },
  );
  return res.status === 0;
}

// Remember whether the vault already had a token, so cleanup only removes one
// this harness created.
const hadToken = tokenExists();

let token = "";

function probePort(timeoutMs = 1000) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    const done = (ok) => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function api(path, method = "GET") {
  const res = await fetch(`https://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function pidsOf(image) {
  const res = spawnSync(
    "tasklist",
    ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8" },
  );
  const pids = new Set();
  const pattern = new RegExp(`^"${image.replace(".", "\\.")}","(\\d+)"`, "i");
  for (const line of (res.stdout ?? "").split(/\r?\n/)) {
    const m = line.match(pattern);
    if (m) pids.add(Number(m[1]));
  }
  return pids;
}

const pingPids = () => pidsOf("PING.EXE");
const powershellPids = () => pidsOf("powershell.exe");

async function waitFor(condition, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(intervalMs);
  }
  return false;
}

const app = spawn(EXE, [], {
  // Debug-only overrides: a dedicated app-data dir plus a single-instance
  // bypass, so this isolated instance can run alongside the developer's real
  // app without touching its registry, servers, or windows.
  env: {
    ...process.env,
    KERN_APP_DATA_DIR: APP_DATA,
    KERN_E2E_ISOLATED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

app.stdout?.on("data", (d) => process.stdout.write(`[kern] ${d}`));
app.stderr?.on("data", (d) => process.stderr.write(`[kern] ${d}`));

let exitCode = 1;
let appExited = false;
app.on("exit", () => {
  appExited = true;
});

try {
  // The HTTPS listener only opens once the app has generated/loaded its token.
  const healthy = await waitFor(async () => {
    if (appExited) return false;
    return probePort();
  }, 25000);

  if (!healthy) {
    if (appExited) {
      console.log(
        "inconclusive: kern exited early — is another kern instance already running? (single-instance forwards to it)",
      );
      process.exitCode = 2;
    } else {
      console.error("FAIL: web remote never came up");
    }
    throw new Error("abort");
  }

  token = readToken();
  const before = pingPids();

  const started = await api("/api/servers/srv_e2e/start", "POST");
  if (started.status !== 200) {
    console.error("FAIL: start rejected:", started.status, started.body);
    throw new Error("abort");
  }

  const spawned = await waitFor(async () => pingPids().size > before.size, 10000);
  const during = pingPids();
  if (!spawned) {
    console.error("FAIL: start did not spawn the ping tree");
    throw new Error("abort");
  }
  console.log(`✓ process tree up (ping pids: ${[...during].join(", ")})`);

  const running = (await api("/api/servers")).body?.servers?.find(
    (s) => s.id === "srv_e2e",
  );
  if (!running?.running) {
    console.error("FAIL: registry does not report the instance as running");
    throw new Error("abort");
  }

  const stopRes = await api("/api/servers/srv_e2e/stop", "POST");
  if (stopRes.status !== 202 && stopRes.status !== 200) {
    console.error("FAIL: stop rejected:", stopRes.status, stopRes.body);
    throw new Error("abort");
  }

  const drained = await waitFor(() => pingPids().size === before.size, 20000);
  const after = pingPids();
  if (!drained) {
    console.error(
      `FAIL: orphan processes survived the stop (remaining pids: ${[...after].join(", ")})`,
    );
    throw new Error("abort");
  }
  console.log("✓ stop terminated the whole tree (no orphans)");

  const stopped = await waitFor(async () => {
    const list = (await api("/api/servers")).body?.servers ?? [];
    const server = list.find((s) => s.id === "srv_e2e");
    return server && !server.running;
  }, 10000);
  if (!stopped) {
    console.error("FAIL: registry still reports the instance as running");
    throw new Error("abort");
  }
  console.log("✓ registry reports stopped");

  // ── Graceful stop: stdin "stop" reaches a console process ─────────────
  const startGrace = await api("/api/servers/srv_e2e_grace/start", "POST");
  if (startGrace.status !== 200) {
    console.error("FAIL: graceful start rejected:", startGrace.status, startGrace.body);
    throw new Error("abort");
  }
  const graceUp = await waitFor(async () => {
    const list = (await api("/api/servers")).body?.servers ?? [];
    return list.find((s) => s.id === "srv_e2e_grace")?.running === true;
  }, 10000);
  if (!graceUp) {
    console.error("FAIL: graceful start did not register a running process");
    throw new Error("abort");
  }
  console.log("✓ graceful target process up");

  const graceStart = Date.now();
  const stopGrace = await api("/api/servers/srv_e2e_grace/stop", "POST");
  if (stopGrace.status !== 202 && stopGrace.status !== 200) {
    console.error("FAIL: graceful stop rejected:", stopGrace.status, stopGrace.body);
    throw new Error("abort");
  }
  const graceStopped = await waitFor(async () => {
    const list = (await api("/api/servers")).body?.servers ?? [];
    const server = list.find((s) => s.id === "srv_e2e_grace");
    return server && !server.running && server.status === "stopped";
  }, 15000);
  const graceElapsed = Date.now() - graceStart;
  if (!graceStopped) {
    console.error("FAIL: graceful stop did not reach the plain 'stopped' status");
    throw new Error("abort");
  }
  if (graceElapsed >= 9000) {
    console.error(
      `FAIL: graceful stop took ${graceElapsed}ms — it fell through to the forced timeout`,
    );
    throw new Error("abort");
  }
  console.log(`✓ graceful stop via stdin completed in ${graceElapsed}ms (status: stopped)`);

  exitCode = 0;
  console.log("\nPASS: end-to-end stop verification (forced + graceful)");
} catch {
  // Individual assertions already printed the reason.
} finally {
  try {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(app.pid)], { stdio: "ignore" });
  } catch {
    // Best-effort.
  }
  await sleep(500);
  try {
    rmSync(APP_DATA, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
  // Remove the throwaway token the harness created, so the developer's first
  // real enable generates a fresh one. A pre-existing token is left untouched.
  if (token && !hadToken) {
    spawnSync(
      "cargo",
      [
        "run",
        "--quiet",
        "--manifest-path",
        join(ROOT, "src-tauri", "Cargo.toml"),
        "--example",
        "web_token",
        "--",
        "delete",
      ],
      { stdio: "ignore" },
    );
  }
  process.exitCode = exitCode;
}
