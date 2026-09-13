import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtAgo, fmtIn } from "../lib/format";
import { navigate } from "../lib/router";
import { can } from "../lib/roles";
import { disableNotifications, enableNotifications, notificationsEnabled } from "../lib/notify";
import { clearSession } from "../lib/session";
import { useToast } from "../lib/toast";
import type { AuthUser, Invite, People, RemoteStatus } from "../lib/types";

export function Settings({ user }: { user: AuthUser }) {
  const { push } = useToast();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [people, setPeople] = useState<People | null>(null);
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviteServers, setInviteServers] = useState("");
  const [created, setCreated] = useState<Invite | null>(null);
  const [notifyOn, setNotifyOn] = useState(notificationsEnabled());

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<RemoteStatus>("/remote/status"));
    } catch {
      /* ignore */
    }
    if (can(user, "admin")) {
      try {
        setPeople(await api<People>("/remote/people"));
      } catch {
        /* ignore */
      }
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tunnelLive = !!status?.tunnel.url;

  return (
    <div className="max-w-3xl">
      <h1 className="font-mono text-sm uppercase tracking-[0.2em] text-zinc-100">settings</h1>
      <p className="mt-1 font-mono text-[11px] text-zinc-600">this device and the remote service.</p>

      <section className="mt-6 border border-grid-bounds bg-bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-400">
            this device
          </h2>
          <span className="border border-grid-bounds px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-zinc-500">
            {user.role}
          </span>
        </div>
        <p className="mt-2 font-mono text-[11px] text-zinc-500">
          signed in as <span className="text-signal-high">{user.name}</span>
          {user.servers && user.servers.length
            ? ` · scoped to ${user.servers.join(", ")}`
            : " · all servers"}
          {user.device ? ` · ${user.device}` : ""}
        </p>
        <button
          onClick={() => {
            clearSession();
            window.dispatchEvent(new Event("kern:unauthorized"));
          }}
          className="mt-3 border border-grid-bounds px-3 py-1 font-mono text-[11px] lowercase text-zinc-400 hover:text-zinc-200"
        >
          sign out
        </button>
      </section>

      <section className="mt-4 border border-grid-bounds bg-bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-400">
            access
          </h2>
          <span
            className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] ${
              tunnelLive ? "border-signal-high/40 text-signal-high" : "border-grid-bounds text-zinc-500"
            }`}
          >
            {tunnelLive ? "tunnel up" : "local"}
          </span>
        </div>

        {status?.bindError && (
          <p className="mt-2 border border-fault-vector/40 bg-fault-vector/5 px-2 py-1 font-mono text-[11px] text-fault-vector">
            {status.bindError}
          </p>
        )}

        <p className="mt-2 font-mono text-[11px] text-zinc-500">
          listening on <span className="text-zinc-300">{status?.bind ?? "—"}:{status?.port ?? "—"}</span>
        </p>
        <ul className="mt-1 space-y-0.5">
          {(status?.urls ?? []).map((url) => (
            <li key={url} className="font-mono text-[11px] text-zinc-400">
              {url}
            </li>
          ))}
        </ul>
        {status?.tunnel.url && (
          <a
            href={status.tunnel.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block break-all font-mono text-[11px] text-signal-high underline underline-offset-2"
          >
            {status.tunnel.url}
          </a>
        )}

        {can(user, "admin") && (
          <button
            onClick={async () => {
              try {
                const enabled = !status?.tunnel.enabled;
                await api("/remote/tunnel", { json: { enabled } });
                push(enabled ? "tunnel starting…" : "tunnel disabled", enabled ? "success" : "warn");
                window.setTimeout(() => void refresh(), 1500);
              } catch (err) {
                push(err instanceof Error ? err.message : "tunnel toggle failed", "error");
              }
            }}
            className={`mt-3 border px-3 py-1 font-mono text-[11px] lowercase ${
              status?.tunnel.enabled
                ? "border-fault-vector/40 text-fault-vector"
                : "border-signal-high/40 text-signal-high"
            }`}
          >
            {status?.tunnel.enabled ? "disable tunnel" : "expose via cloudflare tunnel"}
          </button>
        )}
        {status?.tunnel.error && (
          <p className="mt-2 font-mono text-[11px] text-warn-vector">{status.tunnel.error}</p>
        )}

        <div className="mt-3 flex items-center gap-2 border-t border-grid-bounds pt-3">
          <span className="font-mono text-[11px] text-zinc-500">crash notifications</span>
          <span
            className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] ${
              notifyOn ? "border-signal-high/40 text-signal-high" : "border-grid-bounds text-zinc-600"
            }`}
          >
            {notifyOn ? "on" : "off"}
          </span>
          {!notifyOn ? (
            <button
              onClick={async () => {
                const granted = await enableNotifications();
                setNotifyOn(granted);
                push(
                  granted ? "notifications enabled" : "the browser denied notification permission",
                  granted ? "success" : "warn",
                );
              }}
              className="ml-auto border border-grid-bounds px-3 py-1 font-mono text-[11px] lowercase text-zinc-300"
            >
              enable
            </button>
          ) : (
            <button
              onClick={() => {
                disableNotifications();
                setNotifyOn(false);
              }}
              className="ml-auto border border-grid-bounds px-3 py-1 font-mono text-[11px] lowercase text-zinc-400"
            >
              disable
            </button>
          )}
        </div>
      </section>

      {can(user, "admin") && (
        <section className="mt-4 border border-grid-bounds bg-bg-surface p-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-400">
            people
          </h2>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-zinc-600">name</span>
              <input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="alex"
                className="border border-grid-bounds bg-bg-core px-2 py-1.5 font-mono text-[11px] text-zinc-200"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-zinc-600">role</span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="border border-grid-bounds bg-bg-core px-2 py-1.5 font-mono text-[11px] text-zinc-200"
              >
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label className="flex min-w-[160px] flex-1 flex-col gap-1">
              <span className="font-mono text-[10px] text-zinc-600">servers (blank = all)</span>
              <input
                value={inviteServers}
                onChange={(e) => setInviteServers(e.target.value)}
                placeholder="minecraft_java, discord_bot"
                className="border border-grid-bounds bg-bg-core px-2 py-1.5 font-mono text-[11px] text-zinc-200"
              />
            </label>
            <button
              onClick={async () => {
                try {
                  const invite = await api<Invite>("/remote/invites", {
                    json: {
                      name: inviteName.trim() || "guest",
                      role: inviteRole,
                      servers: inviteServers
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                  });
                  setCreated(invite);
                  setInviteName("");
                  setInviteServers("");
                  push(`invite created for ${invite.name}`, "success");
                  void refresh();
                } catch (err) {
                  push(err instanceof Error ? err.message : "invite failed", "error");
                }
              }}
              className="border border-signal-high/40 px-3 py-1.5 font-mono text-[11px] lowercase text-signal-high"
            >
              create invite
            </button>
          </div>

          {created && (
            <div className="mt-3 border border-signal-high/40 bg-signal-high/5 p-3">
              <p className="font-mono text-[11px] text-zinc-300">
                invite for <span className="text-signal-high">{created.name}</span> ({created.role})
                · expires in {fmtIn(created.expiresAt)}
              </p>
              <p className="mt-1 font-mono text-lg tracking-[0.3em] text-signal-high">
                {created.code}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">
                {location.origin}/#invite={created.code}
              </p>
              <button
                onClick={() => void navigator.clipboard.writeText(`${location.origin}/#invite=${created.code}`)}
                className="mt-2 border border-grid-bounds px-2 py-1 font-mono text-[10px] lowercase text-zinc-400"
              >
                copy link
              </button>
            </div>
          )}

          <div className="mt-4">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
              users
            </h3>
            {(people?.users ?? []).map((entry) => (
              <div key={entry.id} className="flex items-center gap-2 border-b border-grid-bounds/40 py-2">
                <span className="font-mono text-[11px] text-zinc-300">
                  {entry.name} <span className="text-zinc-600">· {entry.role}</span>
                </span>
                <button
                  onClick={async () => {
                    if (!confirm(`remove ${entry.name} and their devices?`)) return;
                    await api("/remote/users/remove", { json: { id: entry.id } });
                    void refresh();
                  }}
                  className="ml-auto font-mono text-[10px] text-fault-vector"
                >
                  remove
                </button>
              </div>
            ))}
            {(people?.users ?? []).length === 0 && (
              <p className="py-1 font-mono text-[11px] text-zinc-600">nobody paired yet.</p>
            )}
          </div>

          <div className="mt-4">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
              devices
            </h3>
            {(people?.devices ?? []).map((device) => (
              <div key={device.id} className="flex items-center gap-2 border-b border-grid-bounds/40 py-2">
                <span className="font-mono text-[11px] text-zinc-300">
                  {device.label || device.id}{" "}
                  <span className="text-zinc-600">
                    · {device.userName} · seen {fmtAgo(device.lastSeenAt)}
                  </span>
                </span>
                <button
                  onClick={async () => {
                    if (!confirm(`revoke ${device.label || device.id}?`)) return;
                    await api("/remote/devices/revoke", { json: { id: device.id } });
                    void refresh();
                  }}
                  className="ml-auto font-mono text-[10px] text-fault-vector"
                >
                  revoke
                </button>
              </div>
            ))}
            {(people?.devices ?? []).length === 0 && (
              <p className="py-1 font-mono text-[11px] text-zinc-600">no devices.</p>
            )}
          </div>

          <div className="mt-4">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">
              open invites
            </h3>
            {(people?.invites ?? [])
              .filter((invite) => !invite.usedAt && !invite.expired)
              .map((invite) => (
                <div key={invite.code} className="flex items-center gap-2 border-b border-grid-bounds/40 py-2">
                  <span className="font-mono text-[11px] text-zinc-300">
                    {invite.name} <span className="text-zinc-600">· {invite.role}</span>
                  </span>
                  <button
                    onClick={async () => {
                      await api("/remote/invites/revoke", { json: { code: invite.code } });
                      void refresh();
                    }}
                    className="ml-auto font-mono text-[10px] text-fault-vector"
                  >
                    revoke
                  </button>
                </div>
              ))}
            {(people?.invites ?? []).filter((invite) => !invite.usedAt && !invite.expired).length ===
              0 && <p className="py-1 font-mono text-[11px] text-zinc-600">no open invites.</p>}
          </div>
        </section>
      )}

      <button
        onClick={() => navigate("/overview")}
        className="mt-6 font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
      >
        ← back to overview
      </button>
    </div>
  );
}
