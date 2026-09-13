#!/usr/bin/env node
/**
 * Emits registry metadata for the packed official plugins, ready to paste into
 * kern-web's `content/plugins/seed.json` (and Supabase when publishing).
 *
 *   node scripts/plugin-registry-meta.mjs            # JSON to stdout
 *   node scripts/plugin-registry-meta.mjs > meta.json
 *
 * The hash + size come from the actual `.kern` bytes, so the registry can
 * advertise a checksum the desktop app verifies at install time. Run
 * `plugins:pack` first.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLUGINS = ["minecraft_java", "discord_bot"];

const out = { plugins: [] };

for (const id of PLUGINS) {
  const dir = join(ROOT, "plugins", id);
  const archive = join(dir, `${id}.kern`);
  if (!existsSync(archive)) {
    console.error(`missing ${archive} — run: bun run plugins:pack`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const bytes = readFileSync(archive);
  out.plugins.push({
    id: manifest.id,
    display_name: manifest.displayName,
    author: manifest.author,
    version: manifest.version,
    kern_compat: manifest.kernCompat,
    description: manifest.description,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.length,
    config_schema: manifest.configSchema,
  });
}

console.log(JSON.stringify(out, null, 2));
