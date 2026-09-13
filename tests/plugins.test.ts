import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  COMMAND_PERMISSIONS,
  KNOWN_PERMISSIONS,
} from "../src/components/plugins/permissions";

/*
  Official sample plugins. These are the reference implementations users copy,
  so the tests here guard the things that drift silently:
    - official author/version metadata
    - permissions actually covering every host command the source calls
    - declared manifest tabs matching the tabs the UI registers
    - the discord install lifecycle staying runtime-qualified
*/

const ROOT = resolve(import.meta.dir, "..");
const PLUGINS = ["minecraft_java", "discord_bot"] as const;

interface SampleManifest {
  id: string;
  author: string;
  version: string;
  kernCompat?: string;
  permissions?: string[];
  tabs?: Array<{ id: string; label: string }>;
  lifecycle?: Record<string, unknown>;
  scaffold?: Record<string, { path: string }>;
}

function manifest(id: string): SampleManifest {
  return JSON.parse(
    readFileSync(join(ROOT, "plugins", id, "manifest.json"), "utf8"),
  ) as SampleManifest;
}

/** All .ts files under a plugin's src/, concatenated. */
function pluginSource(id: string): string {
  const dir = join(ROOT, "plugins", id, "src");
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(readFileSync(full, "utf8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.join("\n");
}

describe("official plugin manifests", () => {
  test("author is ellipog and versions are current", () => {
    for (const id of PLUGINS) {
      const m = manifest(id);
      expect(m.author).toBe("ellipog");
      expect(m.version).toBe("1.3.0");
      expect(m.kernCompat).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  test("every declared permission is known to the host", () => {
    for (const id of PLUGINS) {
      for (const permission of manifest(id).permissions ?? []) {
        expect(KNOWN_PERMISSIONS).toContain(permission);
      }
    }
  });

  test("every host command used in source is covered by a declared permission", () => {
    for (const id of PLUGINS) {
      const declared = new Set(manifest(id).permissions ?? []);
      const source = pluginSource(id);
      const used = new Set(
        [...source.matchAll(/invoke\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
      );
      expect(used.size).toBeGreaterThan(0);
      for (const command of used) {
        const required = COMMAND_PERMISSIONS[command];
        expect(required, `${id} calls '${command}' which is not exposed to plugins`).toBeTruthy();
        expect(
          declared.has(required),
          `${id} calls '${command}' but does not declare '${required}'`,
        ).toBe(true);
      }
    }
  });

  test("declared tabs match the tabs the UI registers", () => {
    for (const id of PLUGINS) {
      const declared = (manifest(id).tabs ?? []).map((t) => t.id).sort();
      const source = pluginSource(id);
      const registered = [
        ...source.matchAll(/registerTab\(\{[\s\S]*?\bid:\s*"([^"]+)"/g),
      ]
        .map((m) => m[1])
        .sort();
      expect(registered.length).toBeGreaterThan(0);
      expect(declared).toEqual(registered);
    }
  });
});

describe("discord_bot specifics", () => {
  test("install lifecycle is runtime-qualified (node install is not a command)", () => {
    const lifecycle = manifest("discord_bot").lifecycle ?? {};
    expect(lifecycle["install"]).toBeUndefined();
    const qualified = Object.keys(lifecycle).filter((k) =>
      k.startsWith("install."),
    );
    expect(qualified.sort()).toEqual([
      "install.bun",
      "install.deno",
      "install.node",
      "install.rust",
    ]);
  });

  test("scaffolds the token env example and ignores it in git", () => {
    const paths = Object.values(manifest("discord_bot").scaffold ?? {}).map(
      (file) => file.path,
    );
    expect(paths).toContain(".env.example");
    expect(paths).toContain(".gitignore");
  });

  test("token handling goes through the vault and .env, never plaintext state", () => {
    const source = pluginSource("discord_bot");
    expect(source).toContain("plugin_secret_set");
    expect(source).toContain("write_server_file");
    // The UI must not render the stored token back.
    expect(source).toContain("plugin_secret_get");
    expect(source).not.toMatch(/tokenConfigured\s*=\s*value\s*;/);
  });
});
