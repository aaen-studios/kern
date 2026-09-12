import { describe, expect, test } from "bun:test";
import {
  INSTANCE_FEATURES,
  isFeatureEnabled,
  setFeature,
} from "../src/components/servers/instanceFeatures";
import type { ServerInstance } from "../src/types/server";

function server(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: "srv_test",
    name: "test",
    serverType: "custom",
    path: "C:\\srv",
    status: "stopped",
    isOrphaned: false,
    userOverrides: {},
    autoStart: false,
    ...overrides,
  };
}

describe("instance feature visibility", () => {
  test("feature keys are unique", () => {
    const keys = INSTANCE_FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("core ports are visible by default, advanced features hidden", () => {
    const s = server();
    expect(isFeatureEnabled(s, "ports")).toBe(true);
    expect(isFeatureEnabled(s, "snapshots")).toBe(false);
    expect(isFeatureEnabled(s, "rcon")).toBe(false);
    expect(isFeatureEnabled(s, "schedules")).toBe(false);
  });

  test("explicit overrides win over defaults", () => {
    const s = server({ features: { ports: false, rcon: true } });
    expect(isFeatureEnabled(s, "ports")).toBe(false);
    expect(isFeatureEnabled(s, "rcon")).toBe(true);
  });

  test("unknown features are hidden", () => {
    expect(isFeatureEnabled(server(), "not-a-feature")).toBe(false);
  });

  test("setFeature returns a new object without mutating the original", () => {
    const s = server({ features: { ports: true } });
    const next = setFeature(s, "rcon", true);
    expect(next).toEqual({ ports: true, rcon: true });
    expect(s.features).toEqual({ ports: true });
  });
});
