#!/usr/bin/env node
/**
 * End-to-end CLI verification (isolated).
 *
 * Boots the debug kern binary against a temporary APPDATA directory (so the
 * real registry is never touched), then drives `kern-cli` through a full
 * lifecycle: status → list → show → start --wait → wait healthy → logs →
 * events → stop --wait → doctor. Asserts exit codes and key output, including
 * the not-found (3) and unreachable (4) paths.
 *
 * Usage:
 *   node scripts/e2e-cli.mjs        (or: bun scripts/e2e-cli.mjs)
 *
 * Exit codes: 0 = pass, 1 = fail, 2 = inconclusive (binary missing or another
 * kern instance owns the test port).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const EXE =
  process.platform === "win32"
    ? join(ROOT, "src-tauri", "target", "debug", "kern.exe")
    : join(ROOT, "src-tauri", "target", "debug", "kern");
const CLI =
  process.platform === "win32"
    ? join(ROOT, "src-tauri", "target", "debug", "kern-cli.exe")
    : join(ROOT, "src-tauri", "target", "debug", "kern-cli");

if (process.platform !== "win32") {
  console.log("inconclusive: this harness currently automates Windows only");
  process.exit(2);
}
if (!existsSync(EXE) || !existsSync(CLI)) {
  console.log("inconclusive: build first with `cargo build` in src-tauri/");
  process.exit(2);
}

const APP_DATA = join(tmpdir(), `kern-e2e-cli-${Date.now()}`);
const EMPTY_DATA = join(tmpdir(), `kern-e2e-cli-empty-${Date.now()}`);
const SERVER_DIR = join(APP_DATA, "server");
const PORT = 7444;

let app = null;
let failures = 0;

function fail(label, detail) {
  failures += 1;
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

function runCli(args, envExtra = {}) {
  const result = spawnSync(CLI, args, {
    encoding: "utf8",
    env: { ...process.env, KERN_APP_DATA_DIR: APP_DATA, ...envExtra },
    timeout: 60_000,
  });
  return {
    code: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function expect(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    fail(label, detail);
  }
}

async function main() {
  mkdirSync(SERVER_DIR, { recursive: true });
  mkdirSync(EMPTY_DATA, { recursive: true });
  writeFileSync(join(SERVER_DIR, "latest.log"), "seed line one\nseed line two\n");

  const config = {
    version: "2.0.0",
    settings: {
      defaultSandboxPath: SERVER_DIR,
      launchOnLogin: false,
      closeToTray: false,
      startHiddenInTray: false,
      automationEnabled: true,
      automationPort: PORT,
      webRemoteEnabled: false,
      trayRadar: false,
    },
    servers: {
      srv_cli: {
        id: "srv_cli",
        name: "CLI E2E",
        serverType: "custom",
        path: SERVER_DIR,
        status: "stopped",
        isOrphaned: false,
        userOverrides: { start_command: "ping -n 300 127.0.0.1" },
        autoStart: false,
        tags: ["e2e"],
        group: "ci",
        stopCommand: "",
        stopTimeoutSecs: 3,
      },
    },
  };
  writeFileSync(join(APP_DATA, "config.json"), JSON.stringify(config, null, 2));

  app = spawn(EXE, [], {
    env: { ...process.env, KERN_APP_DATA_DIR: APP_DATA, KERN_E2E_ISOLATED: "1" },
    stdio: "ignore",
  });

  const endpoint = join(APP_DATA, "automation.json");
  const deadline = Date.now() + 25_000;
  while (!existsSync(endpoint) && Date.now() < deadline) await sleep(250);
  if (!existsSync(endpoint)) {
    app.kill();
    fail("app boot", "automation.json never appeared");
    return;
  }
  await sleep(1000);

  let r = runCli(["--version"]);
  expect("--version", r.code === 0 && r.out.includes("kern-cli"), r.out);

  r = runCli(["status"]);
  expect("status", r.code === 0 && r.out.includes("api v2"), r.out);

  r = runCli(["list"]);
  expect("list", r.code === 0 && r.out.includes("CLI E2E"), r.out);

  r = runCli(["list", "--format", "plain"]);
  expect(
    "list --format plain",
    r.code === 0 && r.out.startsWith("srv_cli\tCLI E2E"),
    r.out,
  );

  r = runCli(["show", "CLI E2E"]);
  expect("show by name", r.code === 0 && r.out.includes("srv_cli"), r.out);

  r = runCli(["show", "does-not-exist"]);
  expect("show missing exits 3", r.code === 3, `exit=${r.code} ${r.out}`);

  r = runCli(["inspect", SERVER_DIR]);
  expect("inspect", r.code === 0 && r.out.includes("suggested name"), r.out);

  r = runCli(["doctor"]);
  expect("doctor", r.code === 0 && r.out.includes("app reachable"), r.out);

  r = runCli(["start", "srv_cli", "--wait", "--timeout", "20s"]);
  expect("start --wait", r.code === 0, `exit=${r.code} ${r.out}`);

  r = runCli(["list", "--running", "--format", "plain"]);
  expect("list --running", r.code === 0 && r.out.includes("CLI E2E"), r.out);

  r = runCli(["wait", "srv_cli", "--for", "healthy", "--timeout", "15s"]);
  expect("wait healthy", r.code === 0, `exit=${r.code} ${r.out}`);

  r = runCli(["logs", "srv_cli", "--lines", "10"]);
  expect("logs", r.code === 0 && r.out.includes("Pinging"), r.out);

  r = runCli(["send", "srv_cli", "hello"]);
  expect("send", r.code === 0, `exit=${r.code} ${r.out}`);

  r = runCli(["events"]);
  expect("events include start", r.code === 0 && r.out.includes("start"), r.out);

  r = runCli(["stop", "srv_cli", "--wait", "--timeout", "30s"]);
  expect("stop --wait", r.code === 0, `exit=${r.code} ${r.out}`);

  r = runCli(["list", "--running", "--format", "plain"]);
  expect("stopped after stop", r.code === 0 && !r.out.includes("CLI E2E"), r.out);

  r = runCli(["status"], { KERN_APP_DATA_DIR: EMPTY_DATA });
  expect("unreachable exits 4", r.code === 4, `exit=${r.code} ${r.out}`);
}

main()
  .catch((e) => fail("harness", e?.stack ?? String(e)))
  .finally(async () => {
    try {
      if (app && app.pid) {
        spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
      }
    } catch {}
    // Best-effort cleanup; the app detaches children on exit, but the CLI
    // stop above already terminated the ping tree.
    try {
      rmSync(APP_DATA, { recursive: true, force: true });
      rmSync(EMPTY_DATA, { recursive: true, force: true });
    } catch {}
    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: kern-cli end-to-end verification");
  });
