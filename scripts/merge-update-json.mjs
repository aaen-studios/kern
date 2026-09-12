#!/usr/bin/env node
/**
 * Merges per-platform `update-<platform>.json` fragments (staged by deploy.sh
 * into `release-assets/`) into the single `update.json` the updater fetches
 * from the latest GitHub release.
 *
 * Usage:
 *   node scripts/merge-update-json.mjs <input-dir> <output-file>
 *
 * Rules:
 *   - Every fragment must agree on `version`; a mismatch is a hard error
 *     (shipping a manifest whose version doesn't match its artifacts would
 *     break the updater for existing clients).
 *   - Each platform entry must carry both `signature` and `url`.
 *   - Platform maps are union-merged; the newest `pub_date` wins.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error("usage: node scripts/merge-update-json.mjs <input-dir> <output-file>");
  process.exit(1);
}

const inputDir = resolve(inputArg);
if (!existsSync(inputDir)) {
  console.error(`merge-update-json: input directory not found: ${inputDir}`);
  process.exit(1);
}

/** Recursively finds files matching `predicate`, sorted for determinism. */
function walk(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, predicate, out);
    else if (predicate(entry)) out.push(path);
  }
  return out.sort();
}

const fragments = walk(inputDir, (name) => /^update-.*\.json$/.test(name));
if (fragments.length === 0) {
  console.error(
    `merge-update-json: no update-*.json fragments found under ${inputDir}\n` +
      "Run deploy.sh on each platform first (it stages release-assets/).",
  );
  process.exit(1);
}

let version = null;
let notes = null;
let pubDate = null;
const platforms = {};

for (const fragment of fragments) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fragment, "utf8"));
  } catch (e) {
    console.error(`merge-update-json: invalid JSON in ${fragment}: ${e.message}`);
    process.exit(1);
  }
  if (!parsed.version || !parsed.platforms || typeof parsed.platforms !== "object") {
    console.error(`merge-update-json: ${fragment} is missing "version" or "platforms"`);
    process.exit(1);
  }
  if (version === null) version = parsed.version;
  if (parsed.version !== version) {
    console.error(
      `merge-update-json: version mismatch — ${fragment} is v${parsed.version}, expected v${version}`,
    );
    process.exit(1);
  }
  for (const [key, entry] of Object.entries(parsed.platforms)) {
    if (!entry || typeof entry !== "object" || !entry.signature || !entry.url) {
      console.error(
        `merge-update-json: ${fragment} platform "${key}" must have both "signature" and "url"`,
      );
      process.exit(1);
    }
    if (platforms[key]) {
      console.error(
        `merge-update-json: platform "${key}" appears in more than one fragment (${fragment})`,
      );
      process.exit(1);
    }
    platforms[key] = entry;
  }
  if (!notes && parsed.notes) notes = parsed.notes;
  if (!pubDate || (parsed.pub_date ?? "") > pubDate) pubDate = parsed.pub_date ?? pubDate;
}

if (Object.keys(platforms).length === 0) {
  console.error("merge-update-json: no platform entries found");
  process.exit(1);
}

const merged = {
  version,
  notes: notes ?? `See https://github.com/aaen-studios/kern/releases/tag/v${version}`,
  pub_date: pubDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};

writeFileSync(resolve(outputArg), JSON.stringify(merged, null, 2) + "\n");
console.log(
  `merge-update-json: v${version} with ${Object.keys(platforms).length} platform(s): ${Object.keys(
    platforms,
  ).join(", ")} → ${outputArg}`,
);
