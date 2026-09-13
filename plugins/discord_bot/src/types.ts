/** Mirrors InstanceMetrics (camelCase on the wire) from metrics.rs */
export interface InstanceMetrics {
  cpu: number;
  ram: number;
  status: string;
}

/** Status event payload emitted on `status:<id>`. */
export interface StatusPayload {
  state: "running" | "stopping" | "exited";
  code?: number | null;
  forced?: boolean;
}

/** Unsubscribe function returned by hostAPI.listen(). */
export type UnlistenFn = () => void;

/** The server instance data passed to the plugin mount function. */
export interface ServerInstance {
  id: string;
  name: string;
  serverType: string;
  path: string;
  status: string;
  isOrphaned: boolean;
  userOverrides: Record<string, string>;
}

/** A tab the plugin can register in the server detail view. */
export interface PluginTab {
  id: string;
  label: string;
  mount: (mountPoint: HTMLElement) => void | Promise<void>;
  unmount?: () => void;
}

/** A toolbar action — a button rendered in the header toolbar area. */
export interface ToolbarAction {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void | Promise<void>;
  order?: number;
  disabled?: boolean;
}

/** Minimal shape of the hostAPI object passed to mount(). */
export interface HostAPI {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  serverPath: string;
  notify: (kind: "info" | "success" | "warn" | "error", title: string, message?: string) => void;
  listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
  registerTab: (tab: PluginTab) => void;
  unregisterTab: (tabId: string) => void;
  registerToolbarAction: (action: ToolbarAction) => void;
  unregisterToolbarAction: (actionId: string) => void;
}
