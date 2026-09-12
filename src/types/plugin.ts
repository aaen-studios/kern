/**
 * Plugin system type definitions.
 *
 * Shared types for the plugin extension-point API and the extended HostAPI
 * that plugins receive in their mount() function.
 */

import type { ServerInstance } from "./server";
import type { PLUGIN_EVENTS } from "./plugin-events";

/**
 * A tab contributed by a plugin to the server detail view.
 * Plugins create these and register them via hostAPI.registerTab().
 */
export interface PluginTab {
  /** Unique id for this tab (should be prefixed to avoid collisions, e.g. "mc-chat"). */
  id: string;
  /** Human-readable label shown in the tab bar. */
  label: string;
  /**
   * URL to the plugin's CSS stylesheet. Automatically set by PluginBoot when
   * the tab is registered — plugins should never set this manually.
   * Used by PluginTabContent to inject styles into the tab's Shadow Root.
   */
  cssUrl?: string;
  /** Owning plugin id — set automatically by PluginBoot. */
  pluginId?: string;
  /** Permissions granted to the owning plugin — set automatically by PluginBoot. */
  permissions?: readonly string[];
  /**
   * Render the tab's UI into the given mount point element.
   * The mount point is inside an open Shadow Root for style isolation.
   */
  mount: (
    mountPoint: HTMLElement,
    serverData: ServerInstance,
    hostAPI: HostAPI,
  ) => void | Promise<void>;
  /** Optional cleanup called when the tab is deactivated or the view unmounts. */
  unmount?: () => void;
}

/**
 * A toolbar action contributed by a plugin.
 * Rendered as a button in the server view's header toolbar area.
 */
export interface ToolbarAction {
  /** Unique id (should be prefixed, e.g. "mc-list"). */
  id: string;
  /** Short label shown on the button. */
  label: string;
  /** Optional emoji/icon prefix character. */
  icon?: string;
  /** Called when the button is clicked. */
  onClick: () => void | Promise<void>;
  /** Lower values sort first (default 100). */
  order?: number;
  /** Disable the button. */
  disabled?: boolean;
}

/**
 * A sidebar item contributed by a plugin.
 * Rendered as a clickable item in the app's left sidebar.
 */
export interface SidebarItem {
  /** Unique id (should be prefixed, e.g. "mc-console"). */
  id: string;
  /** Label shown in the sidebar. */
  label: string;
  /** Optional emoji/icon prefix. */
  icon?: string;
  /** Called when the item is clicked. */
  onClick: () => void;
  /** Lower values sort first (default 100). */
  order?: number;
}

/**
 * API object passed to every plugin's mount() function.
 * Provides Tauri command invocation, server path, event listening,
 * and the ability to register/unregister custom tabs, toolbar actions,
 * and sidebar items.
 */
export interface HostAPI {
  /**
   * Call a Tauri backend command. Only commands covered by the plugin's
   * declared manifest permissions are forwarded; anything else throws.
   */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Permissions granted to this plugin by its manifest. */
  permissions: readonly string[];
  /** True when the plugin declared the given permission. */
  hasPermission: (permission: string) => boolean;
  /** Absolute path to the server instance directory. */
  serverPath: string;
  /**
   * Show a toast and record the message in the notification center. Always
   * available (no permission required).
   */
  notify: (
    kind: "info" | "success" | "warn" | "error",
    title: string,
    message?: string,
  ) => void;
  /** Typed event-name helpers for `listen` (see plugin-events.ts). */
  events: typeof PLUGIN_EVENTS;
  /** Subscribe to a Tauri event. Returns an unlisten function. */
  listen: (
    event: string,
    handler: (payload: unknown) => void,
  ) => Promise<() => void>;
  /**
   * Register a custom tab in the server detail view.
   * The tab appears alongside the built-in "terminal" and "files" tabs.
   */
  registerTab: (tab: PluginTab) => void;
  /**
   * Unregister a previously-registered tab by its id.
   */
  unregisterTab: (tabId: string) => void;
  /**
   * Register a toolbar action — a button rendered in the header toolbar
   * area alongside lifecycle buttons (start/stop/restart).
   */
  registerToolbarAction: (action: ToolbarAction) => void;
  /**
   * Unregister a toolbar action by its id.
   */
  unregisterToolbarAction: (actionId: string) => void;
  /**
   * Register a sidebar item — a clickable entry in the app's left sidebar.
   */
  registerSidebarItem: (item: SidebarItem) => void;
  /**
   * Unregister a sidebar item by its id.
   */
  unregisterSidebarItem: (itemId: string) => void;
}

/**
 * Static tab descriptor that a plugin can declare in its manifest.json.
 * This is metadata only — the actual mount function is provided dynamically.
 */
export interface PluginTabDescriptor {
  id: string;
  label: string;
}
