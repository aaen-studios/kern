/**
 * Monaco Editor wrapper with kern's custom dark theme, custom Monarch
 * language definitions, format-on-save, and bracket-pair colorization.
 *
 * The custom languages (env, properties, ignore, ini, log) are registered
 * with Monaco at module level — before any Editor component mounts. This is
 * required because Monaco only tokenizes a language after its Monarch
 * provider is registered.
 */

import { useRef, useCallback, useEffect } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
import type { editor } from "monaco-editor";
import { KERN_THEME } from "./editorTheme";
import { registerCustomLanguages } from "./monarchLanguages";

/**
 * Tracks whether the Monaco editor currently has keyboard focus.
 *
 * Shared module-level singleton — the CodeEditor updates it via Monaco's own
 * onDidFocusEditorText / onDidBlurEditorText events (more reliable than DOM
 * activeElement checks inside Tauri's webview), and the FileEditorPanel reads
 * it in its window-level keydown handler so it can leave Ctrl+F and Escape
 * alone when the user is actually editing.
 */
export const editorFocus = { focused: false };

// Configure Monaco to bundle inline (avoids web worker CORS issues in Tauri).
// The `loader.config({ monaco })` call tells the React wrapper to use
// the local bundle instead of fetching from CDN.
loader.config({ monaco: monacoEditor });

// Register the kern theme and all custom Monarch languages at module level.
// This must happen before any Editor component mounts.
function initializeMonaco() {
  monacoEditor.editor.defineTheme("kern-dark", KERN_THEME);
  registerCustomLanguages(monacoEditor);

  // ── Register simple formatters for config file languages ──────────────
  // These sort keys alphabetically and normalize spacing.

  /** Creates a formatter that sorts key=value lines within a document. */
  function createConfigFormatter() {
    return {
      provideDocumentFormattingEdits: (
        model: monacoEditor.editor.ITextModel,
      ) => {
        const fullRange = model.getFullModelRange();
        const lines = model.getValue().split("\n");
        const result: string[] = [];
        let sectionBuffer: { key: string; line: string }[] = [];

        function flushBuffer() {
          if (sectionBuffer.length === 0) return;
          sectionBuffer.sort((a, b) => a.key.localeCompare(b.key));
          for (const item of sectionBuffer) {
            result.push(item.line);
          }
          sectionBuffer = [];
        }

        for (const raw of lines) {
          const trimmed = raw.trim();

          // Preserve blank lines and comments (with their original indentation).
          if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("!")) {
            flushBuffer();
            result.push(raw);
            continue;
          }

          // Section headers in ini: [section]
          if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            flushBuffer();
            result.push(raw);
            continue;
          }

          // Key=value line — buffer and sort later.
          const eqIdx = trimmed.indexOf("=");
          const colonIdx = trimmed.indexOf(":");
          const sepIdx = eqIdx > 0 ? eqIdx : colonIdx > 0 ? colonIdx : -1;
          if (sepIdx > 0) {
            const key = trimmed.slice(0, sepIdx).trim();
            const value = trimmed.slice(sepIdx + 1).trim();
            const sep = eqIdx > 0 ? " = " : ": ";
            // Preserve leading whitespace for indentation context.
            const indent = raw.match(/^\s*/)?.[0] ?? "";
            sectionBuffer.push({ key, line: `${indent}${key}${sep}${value}` });
          } else {
            flushBuffer();
            result.push(raw);
          }
        }
        flushBuffer();

        const newText = result.join("\n");
        if (newText === model.getValue()) return [];
        return [{ range: fullRange, text: newText }];
      },
    };
  }

  const configLanguages = ["env", "properties", "ini"];
  for (const langId of configLanguages) {
    try {
      monacoEditor.languages.registerDocumentFormattingEditProvider(
        langId,
        createConfigFormatter(),
      );
    } catch {
      // Language might not be registered yet — skip gracefully.
    }
  }
}
initializeMonaco();

interface CodeEditorProps {
  language: string;
  value: string;
  onChange: (value: string | undefined) => void;
  onSave: () => void;
  onCursorPosition?: (line: number, column: number) => void;
  path?: string;
  readOnly?: boolean;
  /** When set/changed, reveal and focus this 1-based line. */
  gotoLine?: number | null;
}

/**
 * Formats a Monaco cursor position event into line/column numbers.
 */
function extractPosition(e: editor.ICursorPositionChangedEvent) {
  return {
    line: e.position.lineNumber,
    column: e.position.column,
  };
}

export function CodeEditor({
  language,
  value,
  onChange,
  onSave,
  onCursorPosition,
  path,
  readOnly = false,
  gotoLine,
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);

  const handleMount: OnMount = useCallback(
    (ed, monaco) => {
      editorRef.current = ed;

      // Re-register theme and languages (idempotent — safe to call again).
      monaco.editor.defineTheme("kern-dark", KERN_THEME);
      registerCustomLanguages(monaco);
      monaco.editor.setTheme("kern-dark");

      // Store model ref for proper disposal on unmount.
      modelRef.current = ed.getModel() ?? null;

	      // Register Ctrl/Cmd+S save action — format then save.
	      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
	        await ed.getAction("editor.action.formatDocument")?.run();
	        onSave();
	      });

	      // Register Alt+Shift+F as "Format Document".
	      ed.addCommand(
	        monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
	        () => {
	          ed.getAction("editor.action.formatDocument")?.run();
	        },
	      );

      // Report cursor position changes to the parent.
      if (onCursorPosition) {
        ed.onDidChangeCursorPosition((e) => {
          const { line, column } = extractPosition(e);
          onCursorPosition(line, column);
        });
      }

      // Track editor focus so the FileEditorPanel keyboard handler knows when
      // to defer Ctrl+F / Escape to Monaco. Monaco's own events are far more
      // reliable than inspecting document.activeElement in Tauri's webview.
      ed.onDidFocusEditorText(() => {
        editorFocus.focused = true;
      });
      ed.onDidBlurEditorText(() => {
        editorFocus.focused = false;
      });

      // Focus the editor on mount so the user can start typing immediately.
      if (!readOnly) {
        ed.focus();
      }
    },
    [onSave, onCursorPosition, readOnly],
  );

  // Cleanup: dispose the editor model when the component unmounts.
  useEffect(() => {
    return () => {
      // Dispose the model to prevent memory leaks.
      if (modelRef.current) {
        modelRef.current.dispose();
        modelRef.current = null;
      }
      editorRef.current = null;
    };
  }, []);

  // Jump to a requested line (search result / go-to-line). Also runs after
  // mount, so opening a file directly at a match works on the first paint.
  useEffect(() => {
    if (gotoLine == null) return;
    const ed = editorRef.current;
    if (!ed) return;
    const line = Math.max(1, gotoLine);
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }, [gotoLine]);

  return (
    <Editor
      key={path ?? language}
      language={language}
      value={value}
      onChange={onChange}
      onMount={handleMount}
      path={path}
      theme="kern-dark"
      options={{
        // Kern monospace aesthetic.
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", monospace',
        fontSize: 13,
        fontLigatures: true,
        lineHeight: 1.6,
        readOnly,

        // Layout
        minimap: { enabled: true, maxColumn: 60, scale: 1 },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        renderWhitespace: "selection",
        renderLineHighlight: "line",
        lineNumbersMinChars: 3,
        folding: true,
        foldingHighlight: true,
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: true,
        stickyScroll: { enabled: true },

        // Formatting — format on paste and type.
        // (formatOnSave is a VS Code concept; Monaco handles this via the
        // save keybinding which calls our onSave handler.)
        formatOnPaste: true,
        formatOnType: true,

        // Bracket pair colorization
        bracketPairColorization: { enabled: true },
        guides: { indentation: true, bracketPairs: true },

        // Scrolling
        smoothScrolling: true,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
          alwaysConsumeMouseWheel: false,
        },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,

        // Selection/cursor
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        cursorStyle: "line",
        selectionHighlight: true,
        matchBrackets: "always",
        autoClosingBrackets: "always",
        autoClosingQuotes: "always",
        autoIndent: "full",

        // Widgets/completion
        suggestOnTriggerCharacters: true,
        quickSuggestions: true,
        parameterHints: { enabled: true },
        codeLens: false,
        accessibilitySupport: "on",

        // Misc
        renderValidationDecorations: "on",
        padding: { top: 8, bottom: 8 },
        autoDetectHighContrast: true,
      }}
    />
  );
}

/**
 * Ensures the kern Monaco theme is registered. Safe to call multiple times
 * since defineTheme is idempotent.
 */
export function configureMonaco() {
  monacoEditor.editor.defineTheme("kern-dark", KERN_THEME);
  registerCustomLanguages(monacoEditor);
}
