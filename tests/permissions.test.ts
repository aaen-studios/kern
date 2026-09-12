import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMAND_PERMISSIONS,
  KNOWN_PERMISSIONS,
  PERMISSION_LABELS,
  createPluginInvoke,
} from "../src/components/plugins/permissions";

describe("plugin permission catalogue", () => {
  test("every command maps to a known permission", () => {
    for (const [command, permission] of Object.entries(COMMAND_PERMISSIONS)) {
      expect(KNOWN_PERMISSIONS).toContain(permission);
      // Silence the unused-variable lint while asserting presence.
      expect(command.length).toBeGreaterThan(0);
    }
  });

  test("every permission has a human-readable label", () => {
    for (const permission of KNOWN_PERMISSIONS) {
      expect(PERMISSION_LABELS[permission]).toBeTruthy();
    }
  });

  test("the TS and Rust permission catalogues match", () => {
    const rust = readFileSync(
      resolve(import.meta.dir, "../src-tauri/src/manifest.rs"),
      "utf8",
    );
    const block = rust.split("pub const KNOWN_PERMISSIONS")[1]?.split("];")[0] ?? "";
    const rustPermissions = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rustPermissions.length).toBeGreaterThan(0);
    expect(rustPermissions.sort()).toEqual([...KNOWN_PERMISSIONS].sort());
  });
});

describe("createPluginInvoke allowlist", () => {
  test("rejects commands outside the plugin API", () => {
    const invoke = createPluginInvoke("test", []);
    expect(() => invoke("not_a_real_command")).toThrow(/not exposed to plugins/);
  });

  test("rejects commands the plugin lacks permission for", () => {
    const invoke = createPluginInvoke("test", ["files:read"]);
    expect(() => invoke("write_server_file")).toThrow(/missing permission 'files:write'/);
  });
});
