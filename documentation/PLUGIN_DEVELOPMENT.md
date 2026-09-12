# Plugin Development Guide

This guide covers how to create and package plugins for kern using the `.kern` file format.

## Table of Contents

1. [Plugin Structure](#plugin-structure)
2. [Manifest Specification](#manifest-specification)
3. [Lifecycle Commands](#lifecycle-commands)
4. [Packaging as .kern Files](#packaging-as-kern-files)
5. [Distribution](#distribution)

---

## Plugin Structure

A kern plugin is a directory containing a `manifest.json` file and optional assets:

```
my_plugin/
├── manifest.json          # Plugin metadata and configuration
├── dist/                  # Compiled frontend bundle (optional)
│   ├── index.js          # UI entry point
│   └── index.css         # Styles
├── src/                   # Plugin source code
└── README.md             # Optional documentation
```

---

## Manifest Specification

The `manifest.json` file defines your plugin's behavior:

```json
{
  "id": "my_plugin",
  "displayName": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "A brief description of what this plugin does",
  "uiEntry": "dist/index.js",
  "configSchema": [
    {
      "key": "port",
      "label": "Server Port",
      "type": "text",
      "default": "3000"
    },
    {
      "key": "runtime",
      "label": "Runtime",
      "type": "select",
      "options": ["node", "bun", "deno"],
      "default": "node"
    }
  ],
  "lifecycle": {
    "start": {
      "command": "{{userOverrides.runtime}}",
      "args": ["index.js"]
    },
    "install": {
      "command": "{{userOverrides.runtime}}",
      "args": ["install"]
    }
  },
  "scaffold": {
    "readme": {
      "path": "README.txt",
      "content": "Server powered by kern\n"
    }
  },
  "tabs": [
    {
      "id": "plugin-tab",
      "label": "Plugin Tab"
    }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique plugin identifier (kebab-case recommended) |
| `displayName` | string | Yes | Human-readable plugin name |
| `version` | string | Yes | Semantic version (e.g., "1.0.0") |
| `author` | string | No | Plugin author name |
| `description` | string | No | Brief description shown during install preview |
| `uiEntry` | string | No | Path to frontend bundle (relative to manifest) |
| `configSchema` | array | No | Form fields for server configuration |
| `lifecycle` | object | Yes | Commands for `start`, `install`, etc. |
| `scaffold` | object | No | Template files copied to new instances |
| `tabs` | array | No | Plugin-defined UI tabs |

### Schema Field Types

- `text` - Simple text input
- `select` - Dropdown with predefined options

---

## Lifecycle Commands

Lifecycle commands are executed during server operations. Each command supports:

- `command` - The executable to run (can use `{{userOverrides.*}}` templates)
- `args` - Array of arguments (also templateable)
- `useShell` - Set to `true` for shell scripts (Forge/NeoForge)

### Common Lifecycle Steps

| Step | Description |
|------|-------------|
| `start` | Launch the server |
| `install` | Install dependencies |
| `stop` | Stop the server gracefully |

### Runtime-Specific Overrides

You can provide runtime-qualified steps that override the default:

```json
{
  "lifecycle": {
    "start": { ... },
    "start.node": { ... },
    "start.rust": { ... }
  }
}
```

When a server instance has `runtime=node` in its overrides, the `start.node` command will be used instead of `start`.

---

## Packaging as .kern Files

### Using the CLI

Package a plugin directory:

```bash
# From kern (when running)
kern://install?path=/path/to/plugin.kern
```

Or use the `create_plugin_package` command programmatically:

```javascript
const outputPath = await invoke("create_plugin_package", {
  sourcePath: "/path/to/plugin/directory",
  outputPath: "/output/plugin.kern" // optional
});
```

### Manual Packaging

A `.kern` file is just a zip archive. You can create one manually:

```bash
cd my_plugin
zip -r ../my_plugin.kern .
```

### Naming Convention

- Use the plugin ID as the filename: `my_plugin.kern`
- No version in the filename (versions are in `manifest.json`)

---

## Distribution

### Installing Plugins

Users can install plugins by:

1. Double-clicking a `.kern` file in their file manager
2. Using the Plugin Manager's "browse…" button and selecting a `.kern` file
3. Dropping a `.kern` file onto the app window

### Security Notes

- `.kern` files are zip archives, but plugins **do contain executable code**:
  the `uiEntry` bundle runs in the host webview, and lifecycle steps spawn
  processes. Install only plugins you trust.
- The host validates the manifest (id, permissions, host compatibility) before
  installation, verifies registry-provided SHA-256 checksums, and shows the
  requested permissions in the install dialog.
- Plugins declare a `permissions` array (e.g. `files:read`, `process`,
  `downloads`); the HostAPI only forwards commands covered by the granted
  permissions.
- No package signature is verified — the trust model is "install consent plus
  a checked checksum", not publisher signing.
- Publishing checksums alongside downloads is still recommended.

### Packaging a Release Bundle

Include only `manifest.json` and `dist/` in the archive (never `node_modules`,
`src/`, or editor config). The bundled sample plugins are packed by:

```bash
bun run plugins:pack
```

### Best Practices

1. **Test your plugin** - Use the directory-based install during development
2. **Provide clear descriptions** - Users see this during install preview
3. **Handle errors gracefully** - Lifecycle commands should provide helpful error messages
4. **Document config fields** - Each field should have a clear label and sensible defaults