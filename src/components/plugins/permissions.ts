/**
 * Plugin permission model.
 *
 * Community plugins run in the host webview and call host commands through
 * the `HostAPI.invoke` wrapper. That wrapper is the allowlist: a plugin can
 * only call commands whose required permission is declared in its manifest
 * and granted at install time. Commands not listed here are unavailable to
 * plugins entirely (fail closed).
 *
 * Note: this is a capability boundary for well-behaved plugins, not a
 * security sandbox — plugin JS shares the host realm (see docs). The Rust
 * side validates manifests and rejects unknown permission names.
 */

import { invoke } from "@tauri-apps/api/core";

/** Human-readable labels shown in the install-consent UI. */
export const PERMISSION_LABELS: Record<string, string> = {
  "servers:read": "Read the server list and configuration",
  "servers:write": "Create, edit, and delete servers",
  "files:read": "Read files inside server directories",
  "files:write": "Write, rename, and delete files inside server directories",
  process: "Start, stop, and control server processes; run commands",
  downloads: "Download files and Java runtimes",
  backups: "Create, restore, and delete world backups",
  metrics: "Read CPU / RAM / network metrics",
  "plugins:manage": "Install and remove other plugins",
  "plugin:kv": "Store plugin settings and state in its private data store",
  "plugin:secrets": "Store and read secrets in the OS credential vault",
  rcon: "Connect to the server's RCON console and query players",
  sync: "Export and import configuration to git",
  ui: "Read and write UI state",
};

/** Every permission the host understands (must match manifest.rs). */
export const KNOWN_PERMISSIONS: string[] = Object.keys(PERMISSION_LABELS);

/**
 * Command → required permission. Anything absent is not callable by plugins.
 */
export const COMMAND_PERMISSIONS: Record<string, string> = {
  // Server registry
  get_config: "servers:read",
  get_servers: "servers:read",
  refresh_orphaned_status: "servers:read",
  is_server_running: "servers:read",
  list_running_servers: "servers:read",
  is_autostart_enabled: "servers:read",
  list_plugins: "servers:read",
  get_plugin: "servers:read",
  get_plugin_ui_path: "servers:read",
  create_server: "servers:write",
  update_server: "servers:write",
  delete_server: "servers:write",
  delete_server_folder: "servers:write",
  update_server_status: "servers:write",
  update_app_settings: "servers:write",
  enable_autostart: "servers:write",
  disable_autostart: "servers:write",
  update_backup_schedule: "servers:write",
  update_alert_rules: "servers:write",
  update_server_tasks: "servers:write",
  update_command_snippets: "servers:write",

  // Process control
  launch_server_instance: "process",
  stop_server_instance: "process",
  restart_server_instance: "process",
  install_server_instance: "process",
  run_lifecycle_step: "process",
  write_stdin_to_instance: "process",
  run_instance_command: "process",
  run_terminal_command: "process",

  // Files
  read_server_file: "files:read",
  list_server_directory: "files:read",
  read_file_bytes: "files:read",
  read_env_file: "files:read",
  server_file_exists: "files:read",
  search_files: "files:read",
  get_log_tail: "files:read",
  detect_server_jar: "files:read",
  watch_server_directory: "files:read",
  unwatch_server_directory: "files:read",
  write_server_file: "files:write",
  create_server_directory: "files:write",
  delete_server_path: "files:write",
  delete_server_path_recursive: "files:write",
  rename_server_path: "files:write",
  copy_files_to_server: "files:write",
  find_replace_in_files: "files:write",
  open_server_path: "files:write",
  open_folder: "files:write",
  snapshot_file: "files:write",
  restore_file_snapshot: "files:write",
  delete_file_snapshot: "files:write",
  list_file_snapshots: "files:read",
  read_file_snapshot: "files:read",

  // Downloads / Java
  download_url: "downloads",
  download_java: "downloads",
  fetch_mc_versions: "downloads",
  resolve_forge_version: "downloads",
  detect_java: "downloads",
  check_java_version: "downloads",

  // Backups
  backup_world: "backups",
  list_backups: "backups",
  restore_world: "backups",
  delete_backup: "backups",
  get_file_from_backup: "backups",

  // Metrics
  get_instance_metrics: "metrics",
  get_host_metrics: "metrics",
  get_metrics_history: "metrics",
  get_instance_energy: "metrics",
  get_instance_ports: "metrics",

  // Plugin management
  install_plugin: "plugins:manage",
  install_plugin_from_kern: "plugins:manage",
  validate_kern_file: "plugins:manage",
  create_plugin_package: "plugins:manage",
  uninstall_plugin: "plugins:manage",
  registry_list_plugins: "plugins:manage",
  registry_get_plugin: "plugins:manage",
  registry_install_plugin: "plugins:manage",

  // Plugin platform
  plugin_kv_get: "plugin:kv",
  plugin_kv_set: "plugin:kv",
  plugin_kv_delete: "plugin:kv",
  plugin_kv_list: "plugin:kv",
  plugin_secret_get: "plugin:secrets",
  plugin_secret_set: "plugin:secrets",
  plugin_secret_delete: "plugin:secrets",

  // RCON
  rcon_get_status: "rcon",
  rcon_set_config: "rcon",
  rcon_test: "rcon",
  rcon_execute: "rcon",
  rcon_players: "rcon",

  // Sync
  sync_export: "sync",
  sync_import: "sync",

  // UI state
  get_ui_state: "ui",
  set_ui_state: "ui",
};

/**
 * Builds the `invoke` function handed to a plugin. Throws for commands
 * outside the plugin API or missing a declared permission, so misuse fails
 * loudly at the call site rather than silently reaching the backend.
 */
export function createPluginInvoke(
  pluginId: string,
  permissions: readonly string[],
): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
  const granted = new Set(permissions);
  return (cmd: string, args?: Record<string, unknown>) => {
    const required = COMMAND_PERMISSIONS[cmd];
    if (!required) {
      throw new Error(
        `plugin '${pluginId}': command '${cmd}' is not exposed to plugins`,
      );
    }
    if (!granted.has(required)) {
      throw new Error(
        `plugin '${pluginId}': missing permission '${required}' for '${cmd}'`,
      );
    }
    return invoke(cmd, args);
  };
}

/** True when all required permissions are declared by the plugin. */
export function hasPermission(
  permissions: readonly string[],
  permission: string,
): boolean {
  return permissions.includes(permission);
}
