#!/usr/bin/env node
/**
 * Packages each sample plugin into `plugins/<name>/<name>.kern` containing only
 * the runtime files (`manifest.json` + `dist/`) — never `node_modules`, `src/`,
 * or TypeScript config, which are development-only.
 *
 * Uses a small built-in zip writer (zlib deflate, forward-slash entry names,
 * fixed timestamps) instead of `Compress-Archive` / `zip`, because:
 *   - PowerShell's Compress-Archive writes `dist\index.js` on Windows, which
 *     is not a valid zip path separator;
 *   - fixed timestamps make repacking byte-identical when nothing changed, so
 *     `git status` stays clean and `scripts/plugins-check.mjs` can rely on
 *     exact contents.
 *
 * Run after changing a bundled plugin's manifest or rebuilding its UI bundle:
 *   bun run plugins:pack        (or: node scripts/pack-plugins.mjs)
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLUGINS = ["minecraft_java", "discord_bot"];

/* ── tiny zip writer ─────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed DOS date/time (1980-01-01 00:00:00) keeps archives reproducible.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names, no data descriptor
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ── packing ─────────────────────────────────────────────────────── */

/** `manifest.json` + every file under `dist/`, sorted for determinism. */
function collectFiles(dir) {
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.push({ name: rel, data: readFileSync(full) });
    }
  };
  files.push({ name: "manifest.json", data: readFileSync(join(dir, "manifest.json")) });
  walk(join(dir, "dist"), "dist");
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

let failed = false;

for (const name of PLUGINS) {
  const dir = join(ROOT, "plugins", name);
  const manifest = join(dir, "manifest.json");
  const dist = join(dir, "dist");

  if (!existsSync(manifest) || !existsSync(dist)) {
    console.error(`✗ ${name}: manifest.json or dist/ is missing`);
    failed = true;
    continue;
  }

  const archive = zipFiles(collectFiles(dir));
  writeFileSync(join(dir, `${name}.kern`), archive);
  console.log(`✓ packed plugins/${name}/${name}.kern (${archive.length} bytes)`);
}

process.exit(failed ? 1 : 0);
