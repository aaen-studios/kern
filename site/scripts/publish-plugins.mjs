#!/usr/bin/env node
/**
 * Publishes official plugin releases to the live registry (Supabase).
 *
 * Consumes the upload bundle produced by the kern repo:
 *
 *   kern/release-assets/plugins/
 *   ├─ meta.json                          (sha256/size/version — generated from the packed bytes)
 *   └─ supabase-storage/
 *      └─ <id>/<version>/plugin.kern      (exact storage layout)
 *
 * For every plugin in meta.json:
 *   1. verifies the file matches the advertised sha256 + size,
 *   2. uploads it to the `plugin-kern` bucket (upsert),
 *   3. replaces the `plugin_versions` row (delete + insert — the schema has no
 *      unique (plugin_id, version) constraint),
 *   4. with --update-meta, refreshes the `plugins` row from the seed
 *      (description / readme_md / config_schema / tags / category).
 *
 * Usage:
 *   node scripts/publish-plugins.mjs [bundle-dir] [--dry-run] [--update-meta]
 *
 *   bundle-dir defaults to ../kern/release-assets/plugins
 *   --dry-run verifies the bundle locally and prints the plan; no network, no
 *   credentials needed.
 *
 * Env (from .env.local; NEVER commit the service key):
 *   NEXT_PUBLIC_SUPABASE_URL        supabase project url
 *   SUPABASE_SERVICE_ROLE_KEY       service-role key (bypasses RLS)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Node + Bun portable script directory. */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const updateMeta = args.includes("--update-meta");
const bundleArg = args.find((a) => !a.startsWith("--"));
const BUNDLE = resolve(
  bundleArg ?? join(SCRIPT_DIR, "..", "..", "kern", "release-assets", "plugins"),
);

// Tiny .env.local reader so `node scripts/...` works without extra deps.
function loadEnvLocal() {
  const path = resolve(SCRIPT_DIR, "..", ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const metaPath = join(BUNDLE, "meta.json");
if (!existsSync(metaPath)) {
  console.error(`no meta.json at ${BUNDLE} — point at the kern upload bundle (release-assets/plugins)`);
  process.exit(1);
}
const meta = JSON.parse(readFileSync(metaPath, "utf8"));

// The seed is the authored home for changelogs / readmes / categories; the
// kern-side meta.json only carries what can be derived from the packed bytes.
const seedPath = resolve(SCRIPT_DIR, "..", "content", "plugins", "seed.json");
const seed = existsSync(seedPath)
  ? JSON.parse(readFileSync(seedPath, "utf8"))
  : { plugins: [] };

function seedEntry(id, version) {
  const plugin = seed.plugins.find((p) => p.id === id);
  const entry = plugin?.versions?.find((v) => v.version === version);
  return { plugin, entry };
}

/* ── 1. verify every file against the advertised hash + size ─────── */

const jobs = [];
let failures = 0;

for (const plugin of meta.plugins) {
  const { id, version, sha256, size_bytes: sizeBytes } = plugin;
  const filePath = join(BUNDLE, "supabase-storage", id, version, "plugin.kern");
  const storagePath = `${id}/${version}/plugin.kern`;

  if (!existsSync(filePath)) {
    console.error(`FAIL ${id}: missing ${filePath}`);
    failures += 1;
    continue;
  }
  const bytes = readFileSync(filePath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256 || bytes.length !== sizeBytes) {
    console.error(
      `FAIL ${id}: bundle file does not match meta (sha ${actual.slice(0, 12)} vs ${String(sha256).slice(0, 12)}, size ${bytes.length} vs ${sizeBytes})`,
    );
    failures += 1;
    continue;
  }
  jobs.push({ plugin, bytes, storagePath });
}

if (failures > 0) {
  console.error(`\npublish-plugins: ${failures} bundle problem(s)`);
  process.exit(1);
}

if (dryRun) {
  for (const { plugin, bytes, storagePath } of jobs) {
    console.log(
      `dry  ${plugin.id}@${plugin.version}: upload ${storagePath} (${bytes.length} B) + replace plugin_versions row${updateMeta ? " + refresh plugins metadata from seed" : ""}`,
    );
  }
  console.log("\npublish-plugins: dry run complete (bundle verified, nothing sent)");
  process.exit(0);
}

if (!url || !serviceKey) {
  console.error(
    "missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (add the service-role key to .env.local — never commit it)",
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ── 2. upload + db writes ───────────────────────────────────────── */

for (const { plugin, bytes, storagePath } of jobs) {
  const { id, version, sha256, size_bytes: sizeBytes, kern_compat: kernCompat } = plugin;

  // Resolve the plugin row up front — both writes need its UUID.
  const { data: row, error: lookupError } = await supabase
    .from("plugins")
    .select("id")
    .eq("slug", id)
    .single();
  if (lookupError || !row) {
    console.error(`FAIL ${id}: no plugins row with slug '${id}' (${lookupError?.message ?? "not found"})`);
    failures += 1;
    continue;
  }

  const { error: uploadError } = await supabase.storage
    .from("plugin-kern")
    .upload(storagePath, bytes, { contentType: "application/zip", upsert: true });
  if (uploadError) {
    console.error(`FAIL ${id}: storage upload failed: ${uploadError.message}`);
    failures += 1;
    continue;
  }

  // Delete + insert: the schema has no unique (plugin_id, version) constraint.
  const { error: deleteError } = await supabase
    .from("plugin_versions")
    .delete()
    .eq("plugin_id", row.id)
    .eq("version", version);
  if (deleteError) {
    console.error(`FAIL ${id}: could not clear existing ${version} row: ${deleteError.message}`);
    failures += 1;
    continue;
  }

  const { error: insertError } = await supabase.from("plugin_versions").insert({
    plugin_id: row.id,
    version,
    kern_compat: kernCompat ?? null,
    storage_path: storagePath,
    sha256,
    size_bytes: sizeBytes,
    changelog: plugin.changelog ?? seedEntry(id, version).entry?.changelog ?? null,
  });
  if (insertError) {
    console.error(`FAIL ${id}: version row insert failed: ${insertError.message}`);
    failures += 1;
    continue;
  }

  if (updateMeta) {
    const { plugin: seedPlugin } = seedEntry(id, version);
    const patch = {
      updated_at: new Date().toISOString(),
      ...(plugin.description || seedPlugin?.description
        ? { description: plugin.description ?? seedPlugin?.description }
        : {}),
      ...(seedPlugin?.readme_md ? { readme_md: seedPlugin.readme_md } : {}),
      ...(seedPlugin?.config_schema ? { config_schema: seedPlugin.config_schema } : {}),
      ...(seedPlugin?.tags ? { tags: seedPlugin.tags } : {}),
      ...(seedPlugin?.category ? { category: seedPlugin.category } : {}),
    };
    const { error: metaError } = await supabase
      .from("plugins")
      .update(patch)
      .eq("id", row.id);
    if (metaError) {
      console.error(`WARN ${id}: plugins metadata update failed: ${metaError.message}`);
    }
  }

  console.log(`ok   ${id}@${version}: uploaded ${storagePath} + version row (latest by created_at)`);
}

if (failures > 0) {
  console.error(`\npublish-plugins: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\npublish-plugins: published. verify /api/download?id=<slug>&v=<version> returns a 302.");
