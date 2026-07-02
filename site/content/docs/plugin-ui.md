---
title: plugin ui
group: Plugin development
slug: plugin-ui
order: 6
description: shadow dom isolation, mount(), and the host api.
---

# plugin ui

a plugin&rsquo;s `dist/index.js` is an esm bundle that exports `mount(mountPoint, serverData, hostApi)`. kern mounts it inside an **isolated shadow dom** so plugin tailwind never bleeds into the host shell, and injects `dist/index.css` into that shadow root.

## mount

```ts
export function mount(
  mountPoint: ShadowRoot,
  serverData: ServerData,
  hostApi: HostApi,
) {
  // render your ui into mountPoint
}
```

## the host api

`hostApi` is the bridge to tauri and the shell:

- `invoke(command, args)` — call tauri/rust commands.
- `serverPath` — the instance directory.
- `listen(event, cb)` — subscribe to tauri events.
- **extension registrars:**
  - `registerTab({ id, label })` — add a tab to the server detail view.
  - `registerToolbarAction(...)` — add a toolbar button.
  - `registerSidebarItem(...)` — add a sidebar entry.

the minecraft plugin uses `registerTab` to add its **Setup** and **Chat** tabs.

## isolation

because your ui runs in a shadow root:

- your tailwind/css only affects your own dom.
- the host&rsquo;s styles never leak in either (except via css custom properties the host explicitly exposes).
- you can bundle whatever styling approach you want — plain css, tailwind, css-in-js.

> **warn** don&rsquo;t reach out of the shadow root to style the host. that breaks isolation and will break on updates.
