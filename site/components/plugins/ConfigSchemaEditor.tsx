"use client";

import type { ConfigField, Category } from "@/lib/registry";

/*
  Inline editor for a plugin's config_schema array.
  Each field: key, label, type (text | select), default, options (select only).
  Supports add / remove / reorder.
*/

export function ConfigSchemaEditor({
  fields,
  onChange,
}: {
  fields: ConfigField[];
  onChange: (fields: ConfigField[]) => void;
}) {
  const updateField = (index: number, patch: Partial<ConfigField>) => {
    const next = fields.map((f, i) => (i === index ? { ...f, ...patch } : f));
    onChange(next);
  };

  const removeField = (index: number) => {
    onChange(fields.filter((_, i) => i !== index));
  };

  const addField = () => {
    onChange([
      ...fields,
      { key: "", label: "", type: "text", default: "", options: undefined },
    ]);
  };

  const moveField = (from: number, to: number) => {
    if (to < 0 || to >= fields.length) return;
    const next = [...fields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {fields.length === 0 && (
        <p className="font-mono text-xs lowercase text-signal-low">
          no config fields defined.
        </p>
      )}

      {fields.map((f, i) => (
        <div
          key={i}
          className="bg-bg-surface/40 p-4 ring-1 ring-grid-bounds"
          style={{ boxShadow: "inset 0 0 0 1px rgba(22,25,32,0.9)" }}
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[11px] lowercase text-signal-low">
              field {i + 1}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => moveField(i, i - 1)}
                disabled={i === 0}
                className="font-mono text-[11px] text-signal-low transition hover:text-zinc-300 disabled:opacity-30"
                title="move up"
              >
                ↑
              </button>
              <button
                onClick={() => moveField(i, i + 1)}
                disabled={i === fields.length - 1}
                className="font-mono text-[11px] text-signal-low transition hover:text-zinc-300 disabled:opacity-30"
                title="move down"
              >
                ↓
              </button>
              <button
                onClick={() => removeField(i)}
                className="font-mono text-[11px] text-fault-vector transition hover:brightness-125"
                title="remove field"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* Key */}
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] lowercase text-signal-low">
                key
              </label>
              <input
                value={f.key}
                onChange={(e) => updateField(i, { key: e.target.value })}
                placeholder="e.g. port"
                className="w-full bg-bg-core px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </div>

            {/* Label */}
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] lowercase text-signal-low">
                label
              </label>
              <input
                value={f.label}
                onChange={(e) => updateField(i, { label: e.target.value })}
                placeholder="e.g. Port Number"
                className="w-full bg-bg-core px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </div>

            {/* Type */}
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] lowercase text-signal-low">
                type
              </label>
              <select
                value={f.type}
                onChange={(e) =>
                  updateField(i, {
                    type: e.target.value as "text" | "select",
                    options:
                      e.target.value === "select"
                        ? f.options ?? []
                        : undefined,
                  })
                }
                className="w-full bg-bg-core px-2 py-1.5 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              >
                <option value="text">text</option>
                <option value="select">select</option>
              </select>
            </div>

            {/* Default */}
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] lowercase text-signal-low">
                default
              </label>
              {f.type === "select" ? (
                <select
                  value={f.default ?? ""}
                  onChange={(e) =>
                    updateField(i, { default: e.target.value || undefined })
                  }
                  className="w-full bg-bg-core px-2 py-1.5 font-mono text-xs text-zinc-200 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
                >
                  <option value="">(none)</option>
                  {(f.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={f.default ?? ""}
                  onChange={(e) =>
                    updateField(i, {
                      default: e.target.value || undefined,
                    })
                  }
                  placeholder="default value"
                  className="w-full bg-bg-core px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
                />
              )}
            </div>
          </div>

          {/* Options (select only) */}
          {f.type === "select" && (
            <div className="mt-3 flex flex-col gap-1">
              <label className="font-mono text-[10px] lowercase text-signal-low">
                options (comma-separated)
              </label>
              <input
                value={(f.options ?? []).join(", ")}
                onChange={(e) =>
                  updateField(i, {
                    options: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="option1, option2, option3"
                className="w-full bg-bg-core px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-signal-low/60 ring-1 ring-grid-bounds focus:outline-none focus-visible:ring-signal-high"
              />
            </div>
          )}
        </div>
      ))}

      <button
        onClick={addField}
        className="flex w-full items-center justify-center gap-2 bg-bg-surface/40 px-4 py-3 font-mono text-xs lowercase text-signal-low ring-1 ring-grid-bounds transition hover:text-signal-high"
      >
        + add config field
      </button>
    </div>
  );
}
