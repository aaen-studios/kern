import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Build for the embedded web-remote panel.
 *
 * A separate Vite pass keeps the panel's chunks independent from the desktop
 * app's build, while sharing dependencies (React, Tailwind, Monaco) and the
 * desktop's editor components. Output lands in `src-tauri/remote-dist/`, where
 * `build.rs` embeds it into the binary.
 *
 * `bun run remote:dev` serves it on :1421 and proxies `/api` to the running
 * app's https listener, so the panel can be developed (and tested from a
 * phone on the LAN) without rebuilding the Rust side.
 */
export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: resolve(root, "src/remote"),
  base: "/",
  build: {
    outDir: resolve(root, "src-tauri/remote-dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          monaco: ["monaco-editor", "@monaco-editor/react"],
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: true,
    proxy: {
      "/api": {
        target: "https://localhost:7440",
        secure: false,
        changeOrigin: false,
      },
    },
    fs: {
      allow: [root],
    },
  },
});
