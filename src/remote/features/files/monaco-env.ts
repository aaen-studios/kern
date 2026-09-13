/**
 * Monaco worker wiring for the panel build.
 *
 * The desktop's CodeEditor configures the local ESM bundle (no CDN); this
 * module additionally routes language services to bundled workers, which Vite
 * emits next to the app. Import it before any editor mounts (the files
 * feature imports it at module level).
 */

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

interface MonacoEnvironmentLike {
  getWorker: (moduleId: string, label: string) => Worker;
}

(window as unknown as { MonacoEnvironment: MonacoEnvironmentLike }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};
