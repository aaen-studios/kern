/**
 * People: invites, paired devices, and users for the web remote.
 *
 * Invites are single-use codes that pair a device as a named user with a role
 * and (optionally) a per-server scope. The QR/links are built against the
 * tunnel URL when one is up, otherwise the LAN URL.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../../hooks/useToast";

interface UserView {
  id: string;
  name: string;
  role: string;
  servers: string[] | null;
  createdAt: number;
  deviceCount: number;
}

interface DeviceView {
  id: string;
  userId: string;
  userName: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number | null;
}

interface InviteView {
  code: string;
  name: string;
  role: string;
  servers: string[] | null;
  createdAt: number;
  expiresAt: number;
  expired: boolean;
  usedAt: number | null;
}

interface PeopleView {
  users: UserView[];
  devices: DeviceView[];
  invites: InviteView[];
}

interface RemoteInfo {
  urls: string[];
  tunnel: { url: string | null };
}

interface Invite {
  code: string;
  name: string;
  role: string;
  expiresAt: number;
}

function fmtAgo(unixSecs: number): string {
  if (!unixSecs) return "—";
  const diff = Math.max(0, Date.now() / 1000 - unixSecs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function RemotePeople({ enabled }: { enabled: boolean }) {
  const { notify } = useToast();
  const [people, setPeople] = useState<PeopleView | null>(null);
  const [base, setBase] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("viewer");
  const [servers, setServers] = useState("");
  const [created, setCreated] = useState<Invite | null>(null);
  const [qrSvg, setQrSvg] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setPeople(await invoke<PeopleView>("remote_people"));
    } catch {
      setPeople(null);
    }
    try {
      const info = await invoke<RemoteInfo>("web_remote_info");
      setBase(info.tunnel.url || info.urls[0] || "");
    } catch {
      /* base stays empty; links render relative */
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createInvite() {
    setBusy(true);
    try {
      const invite = await invoke<Invite>("remote_invite_create", {
        name: name.trim() || "guest",
        role,
        servers: servers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ttlSecs: 15 * 60,
      });
      setCreated(invite);
      setName("");
      setServers("");
      const link = `${base}/#invite=${invite.code}`;
      try {
        setQrSvg(await invoke<string>("web_remote_qr", { text: link }));
      } catch {
        setQrSvg("");
      }
      notify({
        kind: "success",
        title: `invite ready for ${invite.name}`,
        message: "expires in 15 minutes — one use.",
      });
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "could not create invite", message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvite(code: string) {
    try {
      await invoke("remote_invite_revoke", { code });
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "revoke failed", message: String(e) });
    }
  }

  async function removeUser(id: string, userName: string) {
    if (!confirm(`remove ${userName} and revoke their devices?`)) return;
    try {
      await invoke("remote_user_remove", { id });
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "remove failed", message: String(e) });
    }
  }

  async function revokeDevice(id: string, label: string) {
    if (!confirm(`revoke ${label || id}?`)) return;
    try {
      await invoke("remote_device_revoke", { id });
      await refresh();
    } catch (e) {
      notify({ kind: "error", title: "revoke failed", message: String(e) });
    }
  }

  if (!enabled) return null;

  const link = created ? `${base}/#invite=${created.code}` : "";
  const openInvites = (people?.invites ?? []).filter((i) => !i.usedAt && !i.expired);

  return (
    <div className="px-3 py-3 bg-bg-surface space-y-4">
      <div className="text-[11px] text-zinc-500 leading-snug">
        invite people to the panel. they pair one device with the invite, and
        you can pick their role and which servers they see.
      </div>

      {/* create invite */}
      <div className="border border-grid-bounds p-3 space-y-2 bg-bg-core">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (e.g. alex)"
            className="flex-1 bg-bg-surface border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="bg-bg-surface border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100"
          >
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <input
          value={servers}
          onChange={(e) => setServers(e.target.value)}
          placeholder="servers (blank = all; comma-separated ids)"
          className="w-full bg-bg-surface border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void createInvite()}
          className="btn-mono disabled:opacity-40"
        >
          {busy ? "creating…" : "create invite"}
        </button>
      </div>

      {/* created invite with QR */}
      {created && (
        <div className="border border-signal-high/40 bg-signal-high/5 p-3 space-y-2">
          <p className="text-[11px] text-zinc-300">
            scan or share — <b className="text-signal-high">{created.name}</b> (
            {created.role})
          </p>
          {qrSvg && (
            <div
              className="w-[180px] h-[180px] bg-bg-core border border-grid-bounds"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          )}
          <p className="font-mono text-[10px] text-zinc-400 break-all">{link}</p>
        </div>
      )}

      {/* open invites */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600 mb-2">
          open invites
        </p>
        {openInvites.length === 0 ? (
          <p className="text-[11px] text-zinc-600">no open invites.</p>
        ) : (
          <ul className="divide-y divide-grid-bounds/50">
            {openInvites.map((i) => (
              <li key={i.code} className="flex items-center justify-between gap-2 py-2">
                <span className="text-[11px] text-zinc-300">
                  {i.name} <span className="text-zinc-600">· {i.role}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-zinc-600">
                    expires {fmtAgo(i.expiresAt).replace(" ago", "")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void revokeInvite(i.code)}
                    className="font-mono text-[10px] text-fault-vector hover:brightness-125"
                  >
                    revoke
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* users */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600 mb-2">
          users
        </p>
        {(people?.users ?? []).length === 0 ? (
          <p className="text-[11px] text-zinc-600">nobody paired yet.</p>
        ) : (
          <ul className="divide-y divide-grid-bounds/50">
            {(people?.users ?? []).map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-[11px] text-zinc-300">
                  {u.name}{" "}
                  <span className="text-zinc-600">
                    · {u.role}
                    {u.servers && u.servers.length ? ` · ${u.servers.join(", ")}` : " · all servers"}
                    {` · ${u.deviceCount} device${u.deviceCount === 1 ? "" : "s"}`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void removeUser(u.id, u.name)}
                  className="font-mono text-[10px] text-fault-vector hover:brightness-125"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* devices */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600 mb-2">
          devices
        </p>
        {(people?.devices ?? []).length === 0 ? (
          <p className="text-[11px] text-zinc-600">no paired devices.</p>
        ) : (
          <ul className="divide-y divide-grid-bounds/50">
            {(people?.devices ?? []).map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-[11px] text-zinc-300">
                  {d.label || d.id}{" "}
                  <span className="text-zinc-600">
                    · {d.userName} · seen {fmtAgo(d.lastSeenAt)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void revokeDevice(d.id, d.label)}
                  className="font-mono text-[10px] text-fault-vector hover:brightness-125"
                >
                  revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
