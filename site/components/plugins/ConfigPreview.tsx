import type { ConfigField } from "@/lib/registry";

/*
  §7.2 — render the plugin's configSchema as a READ-ONLY form so visitors see
  exactly what fields they'll configure. Reuses the app's DynamicForm concept
  as a static mock.
*/
export function ConfigPreview({ fields }: { fields: ConfigField[] }) {
  if (!fields || fields.length === 0) return null;

  return (
    <div className="space-y-4">
      {fields.map((f) => (
        <div key={f.key} className="flex flex-col gap-1.5">
          <label className="font-mono text-[11px] lowercase text-signal-low">
            {f.label}{" "}
            <span className="text-signal-low/60">· {f.key}</span>
          </label>
          {f.type === "select" ? (
            <div className="flex flex-wrap gap-1.5">
              {f.options?.map((opt) => (
                <span
                  key={opt}
                  className={`rounded-sm px-2 py-1 font-mono text-[11px] ring-1 ${
                    opt === f.default
                      ? "bg-signal-high/10 text-signal-high ring-signal-high/40"
                      : "bg-bg-surface text-signal-low ring-grid-bounds"
                  }`}
                >
                  {opt}
                </span>
              ))}
            </div>
          ) : (
            <div className="bg-bg-core px-3 py-2 font-mono text-[12px] text-zinc-300 ring-1 ring-grid-bounds">
              {f.default || <span className="text-signal-low/60">(empty)</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
