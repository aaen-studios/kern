#!/usr/bin/env node
/**
 * Packages each sample plugin into `plugins/<name>/<name>.kern` containing only
 * the runtime files (`manifest.json` + `dist/`) — never `node_modules`, `src/`,
 * or TypeScript config, which are development-only.
 *
 * Run after changing a bundled plugin's manifest or rebuilding its UI bundle:
 *   bun run plugins:pack        (or: node scripts/pack-plugins.mjs)
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLUGINS = ["minecraft_java", "discord_bot"];

let failed = false;

for (const name of PLUGINS) {
  const dir = join(ROOT, "plugins", name);
  const manifest = join(dir, "manifest.json");
  const dist = join(dir, "dist");
  const dest = join(dir, `${name}.kern`);

  if (!existsSync(manifest) || !existsSync(dist)) {
    console.error(`✗ ${name}: manifest.json or dist/ is missing`);
    failed = true;
    continue;
  }

  rmSync(dest, { force: true });

  if (process.platform === "win32") {
    // Compress-Archive only accepts .zip; write then rename. .NET normalizes
    // entry separators to '/', matching the zip spec.
    const zipPath = `${dest}.zip`;
    rmSync(zipPath, { force: true });
    const res = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${manifest}','${dist}' -DestinationPath '${zipPath}' -Force`,
      ],
      { stdio: "inherit" },
    );
    if (res.status !== 0) {
      failed = true;
      continue;
    }
    renameSync(zipPath, dest);
  } else {
    const res = spawnSync("zip", ["-r", dest, "manifest.json", "dist"], {
      cwd: dir,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      failed = true;
      continue;
    }
  }

  console.log(`✓ packed plugins/${name}/${name}.kern`);
}

process.exit(failed ? 1 : 0);
