/**
 * Instance create/edit form (panel). Create picks a plugin, validates the
 * folder with /inspect, and fills the plugin's configSchema; edit patches the
 * same fields plus stop behavior. Admin-only (enforced server-side too).
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../lib/toast";
import type {
  ConfigField,
  FolderInspection,
  PluginManifest,
  ServerDetail,
} from "../../lib/types";

export function InstanceForm({
  serverId,
  onDone,
  onCancel,
}: {
  serverId?: string;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const create = !serverId;
  const { push } = useToast();

  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [name, setName] = useState("");
  const [serverType, setServerType] = useState("");
  const [path, setPath] = useState("");
  const [group, setGroup] = useState("");
  const [tags, setTags] = useState("");
  const [autoStart, setAutoStart] = useState(false);
  const [stopCommand, setStopCommand] = useState("");
  const [stopTimeout, setStopTimeout] = useState("15");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [inspect, setInspect] = useState<FolderInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ plugins: PluginManifest[] }>("/plugins")
      .then((data) => {
        setPlugins(data.plugins ?? []);
        if (create && !serverType && data.plugins?.length) {
          setServerType(data.plugins[0].id);
        }
      })
      .catch(() => setPlugins([]));

    if (!create && serverId) {
      void api<ServerDetail>(`/servers/${encodeURIComponent(serverId)}`)
        .then((detail) => {
          setName(detail.name);
          setServerType(detail.type);
          setPath(detail.path);
          setGroup(detail.group ?? "");
          setTags((detail.tags ?? []).join(", "));
          setAutoStart(!!detail.autoStart);
          setStopCommand(detail.stopCommand ?? "");
          setStopTimeout(String(detail.stopTimeoutSecs ?? 15));
          setOverrides(detail.userOverrides ?? {});
        })
        .catch((err) => setError(err instanceof Error ? err.message : "load failed"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const schema: ConfigField[] = useMemo(() => {
    const plugin = plugins.find((entry) => entry.id === serverType);
    return plugin?.configSchema ?? [];
  }, [plugins, serverType]);

  async function runInspect() {
    if (!path.trim()) return;
    try {
      const result = await api<FolderInspection>(
        `/inspect?path=${encodeURIComponent(path.trim())}`,
      );
      setInspect(result);
      if (!name.trim() && result.suggestedName) setName(result.suggestedName);
      if (result.suggestedOverrides) {
        setOverrides((prev) => ({ ...prev, ...result.suggestedOverrides }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "inspect failed");
    }
  }

  async function submit() {
    if (!name.trim() || !serverType || (create && !path.trim())) {
      setError("name, plugin, and path are required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        serverType,
        path: path.trim(),
        group: group.trim() || null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
        autoStart,
        userOverrides: overrides,
        ...(create ? {} : { stopCommand: stopCommand.trim() || null, stopTimeoutSecs: Number(stopTimeout) || 15 }),
      };
      if (create) {
        const instance = await api<{ id: string }>("/servers", { json: payload });
        push(`created ${instance.id}`, "success");
        onDone(instance.id);
      } else {
        await api(`/servers/${encodeURIComponent(serverId!)}`, { method: "PATCH", json: payload });
        push("saved", "success");
        onDone(serverId!);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!serverId) return;
    const folder = confirm(
      "delete this instance?\n\nOK = also delete its folder and every file in it.\nCancel = keep the folder on disk.",
    );
    if (!confirm(`really delete ${name}? this cannot be undone.`)) return;
    try {
      await api(`/servers/${encodeURIComponent(serverId)}?folder=${folder ? 1 : 0}`, {
        method: "DELETE",
      });
      push("instance deleted", "warn");
      onDone("");
    } catch (err) {
      push(err instanceof Error ? err.message : "delete failed", "error");
    }
  }

  return (
    <div className="max-w-2xl">
      <h2 className="font-mono text-sm lowercase text-zinc-100">
        {create ? "new instance" : `settings · ${name || serverId}`}
      </h2>
      <p className="mt-1 font-mono text-[11px] text-zinc-600">
        {create
          ? "pick a plugin, point at a folder, and fill the plugin's config."
          : "rename, regroup, tune stop behavior, and edit plugin config."}
      </p>

      {error && (
        <p className="mt-3 border border-fault-vector/40 bg-fault-vector/5 px-2 py-1 font-mono text-[11px] text-fault-vector">
          {error}
        </p>
      )}

      <div className="mt-4 space-y-3">
        <Field label="name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="input"
            placeholder="My Server"
          />
        </Field>

        {create && (
          <>
            <Field label="folder (absolute path on the host)">
              <div className="flex gap-2">
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  className="input flex-1"
                  placeholder="C:\\servers\\my-server"
                />
                <button onClick={() => void runInspect()} className="btn">
                  inspect
                </button>
              </div>
            </Field>
            {inspect && (
              <div className="border border-grid-bounds bg-bg-surface p-3 font-mono text-[11px] text-zinc-400">
                <p>
                  {inspect.jars.length ? `jars: ${inspect.jars.join(", ")}` : "no server jar found"}
                  {inspect.startScripts.length
                    ? ` · scripts: ${inspect.startScripts.join(", ")}`
                    : ""}
                </p>
                <p className="mt-1 text-zinc-600">
                  {inspect.hasWorld ? "world present · " : ""}
                  {inspect.hasServerProperties ? "server.properties present · " : ""}
                  {inspect.eulaDeclined ? "eula pending" : ""}
                </p>
              </div>
            )}
            <Field label="plugin (server type)">
              <select
                value={serverType}
                onChange={(event) => setServerType(event.target.value)}
                className="input"
              >
                {plugins.map((plugin) => (
                  <option key={plugin.id} value={plugin.id}>
                    {plugin.displayName ?? plugin.id} · v{plugin.version ?? "?"}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="group (optional)">
            <input
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              className="input"
              placeholder="production"
            />
          </Field>
          <Field label="tags (comma separated)">
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              className="input"
              placeholder="minecraft, public"
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(event) => setAutoStart(event.target.checked)}
          />
          start automatically when kern launches
        </label>

        {!create && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="stop command (stdin, empty = default)">
              <input
                value={stopCommand}
                onChange={(event) => setStopCommand(event.target.value)}
                className="input"
                placeholder="stop"
              />
            </Field>
            <Field label="graceful stop timeout (seconds)">
              <input
                value={stopTimeout}
                onChange={(event) => setStopTimeout(event.target.value)}
                className="input"
                inputMode="numeric"
              />
            </Field>
          </div>
        )}

        {schema.length > 0 && (
          <div className="border border-grid-bounds bg-bg-surface p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
              plugin config
            </p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {schema.map((field) => (
                <Field key={field.key} label={field.label || field.key}>
                  {field.type === "select" ? (
                    <select
                      value={overrides[field.key] ?? field.default ?? ""}
                      onChange={(event) =>
                        setOverrides((prev) => ({ ...prev, [field.key]: event.target.value }))
                      }
                      className="input"
                    >
                      {(field.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={overrides[field.key] ?? field.default ?? ""}
                      onChange={(event) =>
                        setOverrides((prev) => ({ ...prev, [field.key]: event.target.value }))
                      }
                      className="input"
                    />
                  )}
                </Field>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="border border-signal-high/40 px-4 py-1.5 font-mono text-[11px] lowercase text-signal-high disabled:opacity-40"
          >
            {busy ? "saving…" : create ? "create instance" : "save changes"}
          </button>
          <button
            onClick={onCancel}
            className="border border-grid-bounds px-4 py-1.5 font-mono text-[11px] lowercase text-zinc-400"
          >
            cancel
          </button>
          {!create && (
            <button
              onClick={() => void remove()}
              className="ml-auto border border-fault-vector/40 px-4 py-1.5 font-mono text-[11px] lowercase text-fault-vector"
            >
              delete instance
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
        {label}
      </span>
      {children}
    </label>
  );
}
