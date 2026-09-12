#!/usr/bin/env node
/**
 * Builds the standalone kern installer (`kern-setup.exe`).
 *
 * Steps:
 *   1. build the frontend bundle (embedded into kern.exe)
 *   2. build kern itself (`cargo build [--release]` in src-tauri)
 *   3. build the installer with KERN_PAYLOAD_EXE pointing at that binary
 *
 * Usage:
 *   node scripts/build-installer.mjs            # release installer
 *   node scripts/build-installer.mjs --debug    # debug installer (faster)
 */
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DEBUG = process.argv.includes("--debug");
const PROFILE_FLAG = DEBUG ? [] : ["--release"];
const PROFILE_DIR = DEBUG ? "debug" : "release";

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    console.error(`\n✗ command failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

// 1. Frontend bundle — kern embeds it at compile time.
run("bun", ["run", "build"], { cwd: ROOT });

// 2. Kern application binary.
//
// `tauri/custom-protocol` is what makes the binary embed the frontend and load
// it from disk. `tauri build` enables this feature automatically; a plain
// `cargo build --release` does NOT, and produces a binary that tries to reach
// the dev server (http://localhost:1420) — which is broken on any machine
// without `tauri dev` running.
run(
  "cargo",
  ["build", ...PROFILE_FLAG, "--features", "tauri/custom-protocol"],
  { cwd: join(ROOT, "src-tauri") },
);
const payload = join(ROOT, "src-tauri", "target", PROFILE_DIR, "kern.exe");
if (!existsSync(payload)) {
  console.error(`✗ expected kern binary not found: ${payload}`);
  process.exit(1);
}

// 3. Installer with the payload embedded.
run("cargo", ["build", ...PROFILE_FLAG], {
  cwd: join(ROOT, "installer"),
  env: { ...process.env, KERN_PAYLOAD_EXE: payload },
});

const output = join(
  ROOT,
  "installer",
  "target",
  PROFILE_DIR,
  "kern-setup.exe",
);
if (!existsSync(output)) {
  console.error(`✗ expected installer not found: ${output}`);
  process.exit(1);
}

const mb = (statSync(output).size / (1024 * 1024)).toFixed(1);
console.log(`\n✓ installer ready: ${output} (${mb} MB, ${PROFILE_DIR})`);
console.log("  GUI:    run it directly");
console.log("  silent: kern-setup.exe /S [/D=C:\\path] [/R]");
console.log("  update: kern-setup.exe /P /R   (used by the in-app updater)");
