import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import fs from "fs";

/**
 * Vite library mode inlines CSS into the JS bundle. PluginBoot
 * expects a separate `dist/index.css` file alongside the JS entry.
 * This plugin copies the source CSS after the build so the host can
 * load it via `<link>` in the shadow DOM.
 */
function emitCssPlugin(): Plugin {
  return {
    name: "emit-css",
    writeBundle() {
      const src = resolve(__dirname, "src/style.css");
      const dest = resolve(__dirname, "dist/index.css");
      try {
        fs.copyFileSync(src, dest);
        console.log(`[emit-css] copied ${src} → ${dest}`);
      } catch (e) {
        console.warn(`[emit-css] failed to copy CSS: ${e}`);
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist",
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [/^@tauri-apps\//],
      output: {
        inlineDynamicImports: true,
      },
    },
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
  },
  plugins: [emitCssPlugin()],
});
