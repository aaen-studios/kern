import { useEffect, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { setNativeNotificationsEnabled } from "../../lib/nativeNotifications";
import type { AppSettings, LogAlertRule } from "../../types/server";
import { UpdateCheckRow } from "./UpdateCheckRow";
import { SyncControls } from "./SyncControls";
import { WebRemotePairing } from "./WebRemotePairing";
import { RemoteTunnel } from "./RemoteTunnel";
import { RemoteAccess } from "./RemoteAccess";
import { RemotePeople } from "./RemotePeople";
import { AutomationPanel } from "./AutomationPanel";
import { LogAlertsEditor } from "./LogAlertsEditor";
import { AuditLogPanel } from "./AuditLogPanel";

interface SettingsViewProps {
  /** Called when the user wants to go back to the server list. */
  onBack: () => void;
}

/**
 * App-level settings view: OS-login autostart, tray/minimize behavior.
 *
 * Follows the same header + content layout as PluginManager / ServerDetailView.
 * Settings load via `useSettings` (which reads `get_config().settings`) and
 * persist via `update_app_settings`; the autostart toggle additionally
 * (de)registers the OS entry so it never drifts from the persisted flag.
 */
export function SettingsView({ onBack }: SettingsViewProps) {
  const { settings, loading, error, update, setLaunchOnLogin } = useSettings();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleAutostart(enabled: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await setLaunchOnLogin(enabled);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetting(
    key:
      | "closeToTray"
      | "startHiddenInTray"
      | "trayRadar"
      | "webRemoteEnabled"
      | "cfTunnelEnabled"
      | "nativeNotifications"
      | "webhookEnabled"
      | "automationEnabled",
    value: boolean,
  ) {
    if (!settings) return;
    setActionError(null);
    try {
      await update({ [key]: value } as Partial<typeof settings>);
    } catch (e) {
      setActionError(String(e));
    }
  }

  async function handleStringSetting(key: keyof AppSettings, value: string) {
    if (!settings) return;
    setActionError(null);
    try {
      await update({ [key]: value } as Partial<AppSettings>);
    } catch (e) {
      setActionError(String(e));
    }
  }

  async function handleNumberSetting(key: keyof AppSettings, value: number) {
    if (!settings) return;
    setActionError(null);
    try {
      await update({ [key]: value } as Partial<AppSettings>);
    } catch (e) {
      setActionError(String(e));
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="border-b border-grid-bounds p-4">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="text-[18px] text-zinc-500 hover:text-zinc-200 transition-colors mr-1"
          >
            ←
          </button>
          <div className="min-w-0">
            <h2 className="text-sm text-zinc-100">settings</h2>
            <p className="text-[11px] text-zinc-500 font-mono truncate">
              {loading ? "loading…" : "host + startup preferences"}
            </p>
          </div>
        </div>
      </div>

      {(error || actionError) && (
        <p className="m-4 text-[11px] text-fault-vector border border-fault-vector/40 bg-fault-vector/5 px-2 py-1">
          {actionError ?? error}
        </p>
      )}

      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[11px] text-zinc-600">loading settings…</p>
        </div>
      )}

      {!loading && settings && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl p-4 space-y-6">
            {/* ── Startup section ─────────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                startup
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <ToggleRow
                  label="Launch kern when my computer starts"
                  description="Register kern as an OS-login launch item. When it starts this way it can stay hidden in the tray (below)."
                  checked={settings.launchOnLogin}
                  disabled={busy}
                  onChange={handleAutostart}
                />
                <Divider />
                <ToggleRow
                  label="Start hidden in the tray on auto-launch"
                  description="When the OS starts kern at login, keep it in the tray without showing the window. Manual launches always restore the last window state."
                  checked={settings.startHiddenInTray}
                  onChange={(v) => void handleSetting("startHiddenInTray", v)}
                />
              </div>
            </section>

            {/* ── Tray section ───────────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                tray
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <ToggleRow
                  label="Keep kern running in the tray when closed"
                  description="Closing the window hides it to the tray instead of quitting; servers keep running. Use the tray menu's Quit to fully exit."
                  checked={settings.closeToTray}
                  onChange={(v) => void handleSetting("closeToTray", v)}
                />
                <Divider />
                <ToggleRow
                  label="Live radar tray icon"
                  description="Animate the tray icon as a mini radar: sweep speed follows CPU load, one pulsing blip per running server, colors show health, and a fault blinks crimson."
                  checked={settings.trayRadar !== false}
                  onChange={(v) => void handleSetting("trayRadar", v)}
                />
              </div>
              <p className="mt-2 text-[11px] text-zinc-600">
                The tray icon lists every active server so you can jump straight
                to one. Left-click toggles the window.
              </p>
            </section>

            {/* ── Notifications & alerts ──────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                notifications &amp; alerts
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <ToggleRow
                  label="Native OS notifications"
                  description="Mirror notifications (crashes, backups, health alerts) to system toasts when kern isn't focused. Turn off for Do Not Disturb."
                  checked={settings.nativeNotifications !== false}
                  onChange={(v) => {
                    setNativeNotificationsEnabled(v);
                    void handleSetting("nativeNotifications", v);
                  }}
                />
                <Divider />
                <ToggleRow
                  label="Send webhook events"
                  description="POST every notification as JSON to the URL below — compatible with Discord and Slack incoming webhooks."
                  checked={!!settings.webhookEnabled}
                  onChange={(v) => void handleSetting("webhookEnabled", v)}
                />
                <Divider />
                <InputRow
                  label="Webhook URL"
                  description="Discord/Slack/generic endpoint. Delivery is best-effort with a 10-second timeout."
                  value={settings.webhookUrl ?? ""}
                  onCommit={(v) => void handleStringSetting("webhookUrl", v)}
                  mono
                />
                <Divider />
                <LogAlertsEditor
                  rules={settings.logAlerts ?? []}
                  onChange={(rules: LogAlertRule[]) => void update({ logAlerts: rules })}
                />
              </div>
            </section>

            {/* ── Power / cost section ────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                power &amp; cost
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <InputRow
                  label="Electricity price per kWh"
                  description="Your local price, in any currency. Drives the per-instance cost estimate on the detail view. Set to 0 to hide the meter."
                  value={String(settings.powerPricePerKwh ?? 0)}
                  onCommit={(v) => void handleNumberSetting("powerPricePerKwh", parseFloat(v) || 0)}
                  type="number"
                />
                <Divider />
                <InputRow
                  label="Machine power draw (watts)"
                  description="Average wattage of this machine under load. Tune to your hardware for an accurate cost figure."
                  value={String(settings.machineWatts ?? 120)}
                  onCommit={(v) => void handleNumberSetting("machineWatts", parseFloat(v) || 120)}
                  type="number"
                />
              </div>
            </section>

            {/* ── Updates section ─────────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                updates
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <UpdateCheckRow />
              </div>
            </section>

            {/* ── Registry / marketplace section ──────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                plugin registry
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <InputRow
                  label="Registry URL"
                  description="Base URL of the plugin marketplace. Defaults to the live kern site."
                  value={settings.registryUrl ?? "https://kern.aaenz.no"}
                  onCommit={(v) => void handleStringSetting("registryUrl", v)}
                />
              </div>
            </section>

            {/* ── Web remote section ──────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                web remote
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <ToggleRow
                  label="Enable web remote"
                  description="Serve a mobile control panel over self-signed HTTPS on the LAN: status, start/stop/restart, and live logs. Pair by scanning the QR code. Applies immediately."
                  checked={!!settings.webRemoteEnabled}
                  onChange={(v) => void handleSetting("webRemoteEnabled", v)}
                />
                <Divider />
                <InputRow
                  label="HTTPS port"
                  description="Port for the web remote (default 7440). Applies immediately."
                  value={String(settings.webRemotePort ?? 7440)}
                  onCommit={(v) => void handleNumberSetting("webRemotePort", parseInt(v) || 7440)}
                  type="number"
                />
                <RemoteAccess
                  enabled={!!settings.webRemoteEnabled}
                  bind={settings.webRemoteBind ?? "0.0.0.0"}
                  onBind={(v) => void handleStringSetting("webRemoteBind", v)}
                />
                <Divider />
                <ToggleRow
                  label="Expose via Cloudflare tunnel"
                  description="Run a cloudflared tunnel so the panel is reachable from anywhere. Quick = random trycloudflare.com URL, no account. Named = stable hostname on your own domain. Public URL + paired devices = control; keep it off unless you need it."
                  checked={!!settings.cfTunnelEnabled}
                  disabled={!settings.webRemoteEnabled}
                  onChange={(v) => void handleSetting("cfTunnelEnabled", v)}
                />
                <RemoteTunnel
                  webRemoteEnabled={!!settings.webRemoteEnabled}
                  tunnelEnabled={!!settings.cfTunnelEnabled}
                  mode={settings.cfTunnelMode ?? "quick"}
                  hostname={settings.cfTunnelHostname ?? ""}
                  onMode={(v) => void handleStringSetting("cfTunnelMode", v)}
                  onHostname={(v) => void handleStringSetting("cfTunnelHostname", v)}
                />
                <Divider />
                <WebRemotePairing
                  enabled={!!settings.webRemoteEnabled}
                  tunnelEnabled={!!settings.cfTunnelEnabled}
                />
              </div>
              <p className="mt-2 text-[11px] text-zinc-600">
                Access is token-protected; devices pair with single-use invites
                and per-user roles below.
              </p>
            </section>

            {/* ── Remote people section ───────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                web remote people
              </h3>
              <div className="border border-grid-bounds">
                <RemotePeople enabled={!!settings.webRemoteEnabled} />
              </div>
            </section>

            {/* ── Sync section ────────────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                multi-machine sync
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <InputRow
                  label="Git repo URL"
                  description="Optional. Set to share your registry across machines (export/import — instances stay local, only metadata travels). Requires git on your PATH."
                  value={settings.syncRepoUrl ?? ""}
                  onCommit={(v) => void handleStringSetting("syncRepoUrl", v)}
                  mono
                />
                <Divider />
                <SyncControls />
              </div>
            </section>

            {/* ── Automation / CLI ────────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                automation &amp; cli
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <ToggleRow
                  label="Enable the automation API"
                  description="Serve a loopback-only (127.0.0.1) JSON API for kern-cli and scripts — start/stop/restart, logs, and stdin. Never exposed to the network."
                  checked={settings.automationEnabled !== false}
                  onChange={(v) => void handleSetting("automationEnabled", v)}
                />
                <Divider />
                <InputRow
                  label="Automation port"
                  description="Port on 127.0.0.1 (default 7442). Changing it requires an app restart."
                  value={String(settings.automationPort ?? 7442)}
                  onCommit={(v) => void handleNumberSetting("automationPort", parseInt(v) || 7442)}
                  type="number"
                />
                <Divider />
                <AutomationPanel />
              </div>
            </section>

            {/* ── Activity / audit log ────────────────────────────────── */}
            <section>
              <h3 className="text-[10px] tracking-[0.2em] uppercase text-zinc-500 mb-3">
                activity log
              </h3>
              <div className="space-y-1 border border-grid-bounds">
                <AuditLogPanel />
              </div>
              <p className="mt-2 text-[11px] text-zinc-600">
                Records starts/stops, config changes, plugin installs, backups,
                task runs, and restart announcements. Stored locally in the app
                data folder; export any time above.
              </p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Toggle row ───────────────────────────────────────────────────────── */

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: ToggleRowProps) {
  return (
    <label
      className={`flex items-start justify-between gap-4 px-3 py-3 bg-bg-surface ${
        disabled ? "opacity-50" : "hover:bg-bg-core"
      } transition-colors cursor-pointer`}
    >
      <div className="min-w-0">
        <div className="text-xs text-zinc-200">{label}</div>
        {description && (
          <div className="mt-0.5 text-[11px] text-zinc-500 leading-snug">
            {description}
          </div>
        )}
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function Divider() {
  return <div className="h-px bg-grid-bounds mx-3" />;
}

/* ─── Text / number input row ──────────────────────────────────────────── */

interface InputRowProps {
  label: string;
  description?: string;
  value: string;
  /** Fired when the field loses focus (Enter / blur) with the latest value. */
  onCommit: (value: string) => void;
  type?: "text" | "number" | "password";
  mono?: boolean;
}

/**
 * Editable settings row. Commits on blur rather than on every keystroke so we
 * don't spam config writes. Renders as a labeled input inside the card style.
 */
function InputRow({ label, description, value, onCommit, type = "text", mono }: InputRowProps) {
  const [draft, setDraft] = useState(value);

  // Keep the local draft in sync if the upstream value changes elsewhere —
  // but only when this field isn't focused (so we don't clobber an in-progress edit).
  useEffect(() => {
    const el = document.activeElement;
    if (el?.getAttribute("data-label") !== label) {
      setDraft(value);
    }
  }, [value, label]);

  return (
    <div className="flex flex-col gap-1 px-3 py-3 bg-bg-surface">
      <label className="text-xs text-zinc-200">{label}</label>
      {description && (
        <div className="text-[11px] text-zinc-500 leading-snug">{description}</div>
      )}
      <input
        data-label={label}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`mt-1 w-full bg-bg-core border border-grid-bounds px-2 py-1.5 text-xs text-zinc-100 focus:border-signal-low outline-none ${
          mono ? "font-mono" : ""
        }`}
      />
    </div>
  );
}

/* ─── Switch control ──────────────────────────────────────────────────── */

function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) onChange(!checked);
      }}
      className={`relative shrink-0 w-8 h-4 border transition-colors ${
        checked
          ? "bg-signal-high/30 border-signal-high"
          : "bg-bg-core border-grid-bounds"
      } ${disabled ? "cursor-not-allowed" : ""}`}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 transition-all ${
          checked
            ? "right-0.5 bg-signal-high"
            : "left-0.5 bg-zinc-500"
        }`}
      />
    </button>
  );
}
