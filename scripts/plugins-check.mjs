#!/usr/bin/env node
/**
 * Verifies the committed sample plugin archives (`plugins/<id>/<id>.kern`):
 *
 *   - the archive contains `manifest.json` + `dist/` and nothing else
 *     (no `src/`, `node_modules/`, package.json, stray dotfiles)
 *   - the packed manifest byte-matches the source `manifest.json`
 *     (modulo CRLF, which a Windows checkout introduces)
 *   - `author` is "ellipog" and `kernCompat` looks like semver
 *   - when `plugins/<id>/dist/` exists locally (it is gitignored, so CI won't
 *     have it), every packed dist file byte-matches the built one
 *
 * Zero dependencies: central-directory zip reader + zlib inflateRaw.
 *
 * Usage: node scripts/plugins-check.mjs   (or: bun scripts/plugins-check.mjs)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PLUGINS = ["minecraft_java", "discord_bot"];

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

let failures = 0;

function fail(plugin, message) {
  failures += 1;
  console.error(`FAIL ${plugin}: ${message}`);
}

function ok(plugin, message) {
  console.log(`ok   ${plugin}: ${message}`);
}

/** Minimal zip reader → [{ name, data }]. */
function readZip(buffer) {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory)");

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported by this checker");
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`malformed central directory entry at offset ${p}`);
    }
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (buffer.readUInt32LE(localOffset) !== LFH_SIG) {
      throw new Error(`malformed local header for '${name}'`);
    }
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === METHOD_STORE) data = Buffer.from(raw);
    else if (method === METHOD_DEFLATE) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method} for '${name}'`);

    if (uncompSize !== 0 && data.length !== uncompSize) {
      throw new Error(`size mismatch for '${name}'`);
    }
    entries.push({ name, data });
  }
  return entries;
}

const isText = (name) => /\.(json|js|css|txt|md)$/i.test(name);

/** CRLF-insensitive comparison for text files, exact for anything else. */
function sameContent(a, b, name) {
  if (isText(name)) {
    return (
      a.toString("utf8").replace(/\r\n/g, "\n") ===
      b.toString("utf8").replace(/\r\n/g, "\n")
    );
  }
  return a.equals(b);
}

/** Recursively lists `dir` as relative, forward-slash paths. */
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

function checkPlugin(id) {
  const before = failures;
  const dir = join(ROOT, "plugins", id);
  const sourceManifestPath = join(dir, "manifest.json");
  const archivePath = join(dir, `${id}.kern`);
  const distDir = join(dir, "dist");

  if (!existsSync(sourceManifestPath)) {
    fail(id, "missing source manifest.json");
    return;
  }
  if (!existsSync(archivePath)) {
    fail(id, `${id}.kern is missing — run: bun run plugins:pack`);
    return;
  }

  let entries;
  try {
    entries = readZip(readFileSync(archivePath));
  } catch (e) {
    fail(id, `unreadable archive: ${e.message}`);
    return;
  }

  const byName = new Map(entries.map((e) => [e.name, e.data]));

  // 1. Structure: manifest + dist/* only.
  const manifestData = byName.get("manifest.json");
  if (!manifestData) {
    fail(id, "archive is missing manifest.json");
    return;
  }
  const unexpected = entries
    .map((e) => e.name)
    .filter((name) => name !== "manifest.json" && !name.startsWith("dist/"));
  if (unexpected.length > 0) {
    fail(id, `unexpected files inside the archive: ${unexpected.join(", ")}`);
  }
  for (const required of ["dist/index.js"]) {
    if (!byName.has(required)) fail(id, `archive is missing ${required}`);
  }

  // 2. Manifest parity + author + compat.
  let manifest;
  try {
    manifest = JSON.parse(manifestData.toString("utf8"));
  } catch (e) {
    fail(id, `packed manifest is not valid JSON: ${e.message}`);
    return;
  }
  const sourceManifest = readFileSync(sourceManifestPath);
  if (!sameContent(manifestData, sourceManifest, "manifest.json")) {
    fail(id, "packed manifest.json differs from the source — run: bun run plugins:pack");
  }
  if (manifest.author !== "ellipog") {
    fail(id, `author must be "ellipog", found ${JSON.stringify(manifest.author)}`);
  }
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.kernCompat ?? ""))) {
    fail(id, `kernCompat must be semver, found ${JSON.stringify(manifest.kernCompat)}`);
  }

  // 3. Deep dist parity when this checkout has a build (dist/ is gitignored).
  if (existsSync(distDir)) {
    const distFiles = walk(distDir);
    let compared = 0;
    for (const rel of distFiles) {
      const packed = byName.get(`dist/${rel}`);
      if (!packed) {
        fail(id, `packed archive is missing dist/${rel} — run: bun run plugins:pack`);
        continue;
      }
      const built = readFileSync(join(distDir, ...rel.split(sep)));
      if (!sameContent(packed, built, rel)) {
        fail(id, `packed dist/${rel} differs from the local build`);
      } else {
        compared += 1;
      }
    }
    const packedDist = [...byName.keys()].filter((n) => n.startsWith("dist/"));
    for (const name of packedDist) {
      if (!distFiles.includes(name.slice("dist/".length))) {
        fail(id, `packed ${name} has no local source — stale build?`);
      }
    }
    if (failures === before) {
      ok(id, `archive verified (manifest + ${compared} dist files)`);
    }
  } else if (failures === before) {
    ok(id, "archive verified (manifest; dist not built locally — skipped byte compare)");
  }
}

for (const id of PLUGINS) checkPlugin(id);

if (failures > 0) {
  console.error(`\nplugins-check: ${failures} problem(s)`);
  process.exit(1);
}
console.log("\nplugins-check: all sample plugin archives are in sync");
