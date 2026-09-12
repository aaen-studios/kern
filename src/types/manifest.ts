/**
 * Plugin manifest types.
 * Spec: documentation/ArchitecturePlan.md §3 (Plugin Manifest Specification).
 * Mirrors the Rust structs in src-tauri/src/manifest.rs (camelCase on wire).
 */

/** One configurable field in the manifest's configSchema. */
export interface SchemaField {
  key: string;
  label: string;
  /** "text" | "select" | (future) others. */
  type: "text" | "select";
  options?: string[];
  default: string;
  /** Optional: this field's default is derived from another field's value. */
  dependsOn?: DependsOn;
}

/** Declares that a field's default follows the value of another field. */
export interface DependsOn {
  /** The key of the field this one depends on (e.g. "runtime"). */
  field: string;
  /** Map of the dependency's value → this field's default. */
  defaults: Record<string, string>;
}

/** A single starter file the host writes into a fresh instance directory. */
export interface ScaffoldFile {
  /** Relative path inside the instance dir. May use {{userOverrides.*}}. */
  path: string;
  /** File contents. May use {{userOverrides.*}} templates. */
  content: string;
  /** Only write when the override `field` equals one of `values`. */
  when?: { field: string; values: string[] };
}

/** A single lifecycle step: command + args, possibly templated. */
export interface LifecycleStep {
  command: string;
  args: string[];
  /** Run through the OS shell (sh -c / cmd.exe /C) instead of spawning directly. */
  useShell?: boolean;
}

/** Map of lifecycle step name → step (install / start / stop ...). */
export type LifecycleMap = Record<string, LifecycleStep>;

/** A static tab declaration in the manifest. */
export interface PluginTabDescriptor {
  id: string;
  label: string;
}

/** A plugin manifest.json document. */
export interface Manifest {
  id: string;
  displayName: string;
  version: string;
  author: string;
  /** Optional description shown during plugin install preview. */
  description?: string;
  /** Path to the compiled ESM frontend bundle, relative to the manifest. */
  uiEntry?: string;
  /** Capability grants required by the plugin (see permissions.ts). */
  permissions?: string[];
  /** Minimum host (kern) version required, e.g. "0.2.0". */
  kernCompat?: string;
  /** Configuration fields surfaced to the host for dynamic form generation. */
  configSchema: SchemaField[];
  /** Named lifecycle commands. */
  lifecycle: LifecycleMap;
  /** Starter files written into a fresh instance directory, keyed by label. */
  scaffold: Record<string, ScaffoldFile>;
  /**
   * Optional static tab declarations.
   * These describe tabs the plugin may register dynamically at runtime.
   * The actual mount functions are provided via the JS bundle.
   */
  tabs?: PluginTabDescriptor[];
}
