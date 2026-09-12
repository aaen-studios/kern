/**
 * PluginBoot — invisible bootstrap container for community plugin UIs.
 *
 * Replaces the old PluginWrapper (which rendered a visible collapsible panel).
 * Now the plugin is mounted into a hidden element and contributes to the host
 * UI exclusively through extension points (registerTab, registerToolbarAction,
 * registerSidebarItem, etc.).
 *
 * ── DOM architecture ──
 *
 *   <div style="display:none">            ← Invisible container
 *     <div ref={shadowHostRef} />         ← Shadow host (CSS + JS loaded here)
 *   </div>
 *   {status !== "ready" && (
 *     <div>...status overlay...</div>     ← Inline status, hidden when ready
 *   )}
 */

import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ServerInstance } from "../../types/server";
import type { Manifest } from "../../types/manifest";
import type { HostAPI, PluginTab, ToolbarAction, SidebarItem } from "../../types/plugin";
import { usePluginTabs } from "../../hooks/usePluginTabs";
import { useToolbarActions } from "../../hooks/useToolbarActions";
import { useSidebarItems } from "../../hooks/useSidebarItems";
import { useToast } from "../../hooks/useToast";
import { useNotifications } from "../../hooks/useNotifications";
import { PLUGIN_EVENTS } from "../../types/plugin-events";
import { createPluginInvoke, hasPermission } from "./permissions";

/* ─── Manifest / permission cache ────────────────────────────────────────
 *
 * The plugin's manifest is the source of truth for its capability grants.
 * Cache it per plugin id so mounting a plugin is one extra IPC at most, and
 * expose a clear hook so installs/uninstalls take effect immediately.
 */

const manifestCache = new Map<string, Manifest | null>();

async function getPluginPermissions(pluginId: string): Promise<string[]> {
  if (manifestCache.has(pluginId)) {
    return manifestCache.get(pluginId)?.permissions ?? [];
  }
  try {
    const manifest = await invoke<Manifest>("get_plugin", { id: pluginId });
    manifestCache.set(pluginId, manifest);
    return manifest.permissions ?? [];
  } catch {
    manifestCache.set(pluginId, null);
    return [];
  }
}

/** Clears the cached manifest and preloaded assets — call after install/uninstall/upgrade. */
export function clearPluginManifestCache(pluginId?: string): void {
  if (pluginId) {
    manifestCache.delete(pluginId);
    preloadCache.delete(pluginId);
    preloadPromises.delete(pluginId);
    return;
  }
  manifestCache.clear();
  preloadCache.clear();
  preloadPromises.clear();
}

/* ─── Preload cache ──────────────────────────────────────────────────────
 *
 * Preloading starts the expensive async work (IPC path resolution, CSS fetch,
 * dynamic module import) as soon as we know the plugin id — before the
 * PluginBoot component even mounts. The cache hands the result to boot()
 * so it can skip those steps and jump straight to mounting.
 */

interface PreloadedAssets {
  cssUrl: string;
  scriptUrl: string;
  mount: (mountPoint: HTMLElement, serverData: ServerInstance, hostAPI: HostAPI) => void | Promise<void>;
  unmount?: () => void;
}

const preloadCache = new Map<string, PreloadedAssets>();
const preloadPromises = new Map<string, Promise<void>>();

/**
 * Kick off preloading of a plugin's assets in the background. Safe to call
 * multiple times for the same plugin id — the work only runs once.
 *
 * Call this as early as possible (e.g. when the plugin manifest is resolved)
 * so the IPC call, CSS fetch, and dynamic import finish before PluginBoot
 * mounts. The result is cached and consumed internally.
 */
export function preloadPluginAssets(pluginId: string): void {
  if (preloadPromises.has(pluginId)) return;

  const promise = (async () => {
    try {
      const absPath = await invoke<string | null>("get_plugin_ui_path", { id: pluginId });
      if (!absPath) return;

      const cssUrl = convertFileSrc(absPath.replace(/\.js$/, ".css"));
      const scriptUrl = convertFileSrc(absPath);

      // Preload CSS by injecting a <link> into document.head — the browser
      // caches it so PluginBoot's Shadow DOM link load resolves instantly.
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = cssUrl;
      await new Promise<void>((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`preload: failed to load plugin CSS: ${cssUrl}`));
        document.head.appendChild(link);
      });

      // Preload the JS module — the dynamic import in boot() will resolve
      // from the module cache and skip the network/filesystem entirely.
      const plugin = await import(/* @vite-ignore */ scriptUrl);
      if (typeof plugin.mount !== "function") return;

      preloadCache.set(pluginId, {
        cssUrl,
        scriptUrl,
        mount: plugin.mount,
        unmount: plugin.unmount,
      });
    } catch {
      // Non-fatal — PluginBoot falls back to its normal boot sequence.
    }
  })();

  preloadPromises.set(pluginId, promise);
}

interface PluginBootProps {
  /** Plugin id backing the instance. */
  pluginId: string;
  /** Server data handed to the plugin's mount() function. */
  serverData: ServerInstance;
}

export function PluginBoot({ pluginId, serverData }: PluginBootProps) {
  const shadowHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "none">("loading");

  const { registerTab, unregisterTab } = usePluginTabs();
  const { registerAction, unregisterAction } = useToolbarActions();
  const { registerItem, unregisterItem } = useSidebarItems();
  const { notify: toast } = useToast();
  const { push: pushNotification } = useNotifications();

  // Track what this plugin instance registered, so we can clean up on unmount.
  const registeredTabIdsRef = useRef<Set<string>>(new Set());
  const registeredActionIdsRef = useRef<Set<string>>(new Set());
  const registeredItemIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const host = shadowHostRef.current;
    if (!host) return;
    let loaded: { unmount?: () => void } | null = null;

    async function boot(host: HTMLDivElement) {
      try {
        // ── Check preload cache ──────────────────────────────────────
        // If preloadPluginAssets() was called early enough, all the
        // expensive async work is already done and we skip straight to
        // Shadow DOM creation + mounting.
        const cached = preloadCache.get(pluginId);

        // 1. Resolve the plugin's UI entry to an asset:// URL.
        //    (skip IPC call if preloaded)
        let absPath: string | null;
        let cssUrl: string;

        if (cached) {
          cssUrl = cached.cssUrl;
        } else {
          absPath = await invoke<string | null>("get_plugin_ui_path", { id: pluginId });
          if (cancelled) return;
          if (!absPath) {
            setStatus("none");
            return;
          }
          cssUrl = convertFileSrc(absPath.replace(/\.js$/, ".css"));
        }

        // 2. Create (or reuse) a Shadow Root on the host element.
        const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
        while (shadow.lastChild) shadow.removeChild(shadow.lastChild);
        const mountPoint = document.createElement("div");
        shadow.appendChild(mountPoint);

        // 3. Inject the plugin's stylesheet into the Shadow DOM.
        //    If preloaded, the CSS was already fetched into <head> so the
        //    browser cache makes this <link> resolve near-instantly.
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        await new Promise<void>((resolve, reject) => {
          link.onload = () => resolve();
          link.onerror = () => reject(new Error(`failed to load plugin CSS: ${cssUrl}`));
          shadow.appendChild(link);
        });
        if (cancelled) return;

        // 4. Runtime-import the plugin code and mount it.
        //    (skip dynamic import if preloaded — use cached mount function)
        let mountFn: ((mountPoint: HTMLElement, serverData: ServerInstance, hostAPI: HostAPI) => void | Promise<void>) | null = null;
        let unmountFn: (() => void) | undefined;

        if (cached) {
          mountFn = cached.mount;
          unmountFn = cached.unmount;
        } else {
          const scriptUrl = convertFileSrc(absPath!);
          const plugin = await import(/* @vite-ignore */ scriptUrl);
          if (cancelled) return;
          if (typeof plugin.mount === "function") {
            mountFn = plugin.mount;
            unmountFn = plugin.unmount;
          }
        }

        if (mountFn) {
          const permissions = await getPluginPermissions(pluginId);
          if (cancelled) return;

          const wrapperRegisterTab = (tab: PluginTab) => {
            // Enrich the tab with the plugin's CSS URL so PluginTabContent can
            // inject it into the tab's visible Shadow Root. The plugin's own
            // mount() doesn't need to know about CSS — PluginBoot handles it.
            // pluginId/permissions ride along so tab-content mounts get the
            // same permission-gated HostAPI as the plugin's main mount.
            const enriched = { ...tab, cssUrl, pluginId, permissions };
            registeredTabIdsRef.current.add(enriched.id);
            registerTab(enriched);
          };
          const wrapperUnregisterTab = (tabId: string) => {
            registeredTabIdsRef.current.delete(tabId);
            unregisterTab(tabId);
          };
          const wrapperRegisterAction = (action: ToolbarAction) => {
            registeredActionIdsRef.current.add(action.id);
            registerAction(action);
          };
          const wrapperUnregisterAction = (actionId: string) => {
            registeredActionIdsRef.current.delete(actionId);
            unregisterAction(actionId);
          };
          const wrapperRegisterItem = (item: SidebarItem) => {
            registeredItemIdsRef.current.add(item.id);
            registerItem(item);
          };
          const wrapperUnregisterItem = (itemId: string) => {
            registeredItemIdsRef.current.delete(itemId);
            unregisterItem(itemId);
          };

          const hostAPI: HostAPI = {
            invoke: createPluginInvoke(pluginId, permissions),
            permissions,
            hasPermission: (permission: string) => hasPermission(permissions, permission),
            serverPath: serverData.path,
            notify: (kind, title, message) => {
              toast({ kind, title, message });
              pushNotification({
                kind,
                title,
                message,
                serverId: serverData.id,
              });
            },
            events: PLUGIN_EVENTS,
            listen: (event: string, handler: (payload: unknown) => void) =>
              listen(event, (e) => handler(e.payload)),
            registerTab: wrapperRegisterTab,
            unregisterTab: wrapperUnregisterTab,
            registerToolbarAction: wrapperRegisterAction,
            unregisterToolbarAction: wrapperUnregisterAction,
            registerSidebarItem: wrapperRegisterItem,
            unregisterSidebarItem: wrapperUnregisterItem,
          };

          await mountFn(mountPoint, serverData, hostAPI);
          loaded = { unmount: unmountFn };
          setStatus("ready");
        } else {
          // Plugin has a JS bundle but no mount() — that's OK, it may be
          // a pure lifecycle-only plugin with no UI.
          setStatus("none");
        }
      } catch (err) {
        if (cancelled) return;
        // Surface the failure instead of silently contributing no UI.
        console.error(`[PluginBoot] plugin '${pluginId}' failed to boot:`, err);
        setStatus("error");
      }
    }

    void boot(host);

    return () => {
      cancelled = true;

      // Auto-unregister everything this plugin contributed.
      for (const id of registeredTabIdsRef.current) unregisterTab(id);
      registeredTabIdsRef.current.clear();
      for (const id of registeredActionIdsRef.current) unregisterAction(id);
      registeredActionIdsRef.current.clear();
      for (const id of registeredItemIdsRef.current) unregisterItem(id);
      registeredItemIdsRef.current.clear();

      try {
        loaded?.unmount?.();
      } catch {
        // Non-fatal.
      }
      if (host.shadowRoot) {
        while (host.shadowRoot.lastChild) {
          host.shadowRoot.removeChild(host.shadowRoot.lastChild);
        }
      }
    };
  }, [pluginId, serverData, registerTab, unregisterTab, registerAction, unregisterAction, registerItem, unregisterItem, toast, pushNotification]);

  // Invisible container — the plugin mounts here but renders nothing visible.
  // Failures are surfaced so a broken plugin isn't silently absent.
  return (
    <>
      <div style={{ display: "none" }} ref={shadowHostRef} />
      {status === "loading" && (
        <div className="sr-only">loading plugin {pluginId}…</div>
      )}
      {status === "error" && (
        <div className="m-2 border border-fault-vector/40 bg-fault-vector/5 px-2 py-1 text-[11px] text-fault-vector">
          plugin '{pluginId}' failed to load its UI — check the console for
          details
        </div>
      )}
    </>
  );
}
