---
title: packaging
group: Plugin development
slug: packaging
order: 7
description: building a .kern file and seeding it for development.
---

# packaging

a `.kern` file is a **zip archive** with a specific layout. you build it from your plugin source.

## layout

```
my-plugin.kern  (a zip)
├─ manifest.json     (required)
├─ dist/
│  ├─ index.js       (optional — the esm ui bundle)
│  └─ index.css      (optional — injected into the shadow root)
└─ …any other assets your bundle references
```

## building

build your ui bundle to `dist/index.js` (esm, exporting `mount`), then zip the manifest + `dist/` (+ assets) into a `.kern` file. the kern app has a `create_plugin_package` helper that does the zipping for you against a validated manifest.

## dev seeding

for local development you can drop a `.kern` into kern&rsquo;s plugin directory (or double-click it to trigger `kern://install`) and the host will pick it up. this lets you iterate on a plugin without going through the registry.

> **note** validate your `manifest.json` before zipping. the registry&rsquo;s ci (phase a) unzips, parses the manifest, checks `id`/`version`/schema, and rejects malformed packages on the pr.
