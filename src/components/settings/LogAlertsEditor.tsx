/**
 * Log-pattern alert rules editor.
 *
 * Each rule is a Rust-syntax regex matched against every streamed server log
 * line; a match raises a notification (native toast when hidden, webhook when
 * configured). Rules are persisted through `update_app_settings`, which also
 * recompiles the backend's regex cache immediately.
 */

import type { LogAlertRule } from "../../types/server";

interface LogAlertsEditorProps {
  rules: LogAlertRule[];
  onChange: (rules: LogAlertRule[]) => void;
}

function newRule(): LogAlertRule {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `rule-${Date.now()}`;
  return { id, name: "", pattern: "", enabled: true };
}

export function LogAlertsEditor({ rules, onChange }: LogAlertsEditorProps) {
  const patch = (id: string, partial: Partial<LogAlertRule>) => {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...partial } : rule)));
  };

  return (
    <div className="px-3 py-3 bg-bg-surface space-y-3">
      <div className="text-[11px] text-zinc-500 leading-snug">
        Regex rules matched against every log line (Rust syntax). A match raises
        a notification and fires the webhook, at most once per minute per rule.
        Examples: <code className="font-mono">OutOfMemoryError</code>,{" "}
        <code className="font-mono">(?i)can't keep up</code>,{" "}
        <code className="font-mono">\[Server thread/ERROR\]</code>
      </div>

      {rules.length === 0 && (
        <p className="text-[11px] text-zinc-600">No log alerts configured.</p>
      )}

      {rules.map((rule) => (
        <div
          key={rule.id}
          className="border border-grid-bounds bg-bg-core p-2 space-y-2"
        >
          <div className="flex items-center gap-2">
            <input
              value={rule.name}
              placeholder="name (e.g. Out of memory)"
              onChange={(e) => patch(rule.id, { name: e.target.value })}
              className="flex-1 bg-bg-surface border border-grid-bounds px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-signal-low"
            />
            <label className="flex items-center gap-1 text-[11px] text-zinc-500 select-none">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => patch(rule.id, { enabled: e.target.checked })}
                className="accent-signal-high"
              />
              on
            </label>
            <button
              onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
              className="text-[11px] text-fault-vector/80 hover:text-fault-vector"
            >
              remove
            </button>
          </div>
          <input
            value={rule.pattern}
            placeholder="regex pattern"
            spellCheck={false}
            onChange={(e) => patch(rule.id, { pattern: e.target.value })}
            className="w-full bg-bg-surface border border-grid-bounds px-2 py-1 text-[11px] font-mono text-zinc-100 outline-none focus:border-signal-low"
          />
        </div>
      ))}

      <button
        onClick={() => onChange([...rules, newRule()])}
        className="px-2 py-1 text-[11px] border border-grid-bounds text-zinc-400 hover:text-zinc-200"
      >
        + add rule
      </button>
    </div>
  );
}
