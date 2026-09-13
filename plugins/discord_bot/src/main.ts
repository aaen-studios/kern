/**
 * Discord Bot Manager — plugin UI.
 *
 * Replaces the earlier hand-written dashboard (which animated a fake latency
 * gauge with Math.random()) with real host data:
 *
 *   Status tab — process state (`is_server_running`), live cpu/ram
 *                (`get_instance_metrics`), and the streamed console via
 *                `log:<id>:stream`, parsed for "Logged in as …" to show
 *                whether the gateway actually came up.
 *   Setup tab  — the bot token: stored in the OS credential vault
 *                (`plugin_secret_set`) and materialized to `.env` so the
 *                host injects it when the bot process launches.
 *
 * Extension points: two tabs + a "restart bot" toolbar action.
 */

import type {
  HostAPI,
  InstanceMetrics,
  ServerInstance,
  StatusPayload,
  UnlistenFn,
} from "./types";

const PLUGIN_ID = "discord_bot";
const SECRET_KEY = "token";
const LOG_BUFFER = 200;
const RENDER_THROTTLE_MS = 80;

interface State {
  serverData: ServerInstance;
  hostAPI: HostAPI;
  running: boolean;
  metrics: InstanceMetrics;
  logLines: string[];
  /** Epoch ms of the newest log line; null until the first line arrives. */
  lastActivity: number | null;
  /** Bot tag parsed from "Logged in as …", null while waiting. */
  botTag: string | null;
  tokenConfigured: boolean;
  tokenDraft: string;
  tokenBusy: boolean;
  clearArmed: boolean;
  runtime: string;
  entry: string;
  tokenEnv: string;
  unlistenLog: UnlistenFn | null;
  unlistenStatus: UnlistenFn | null;
  metricsTimer: ReturnType<typeof setInterval> | null;
}

let state: State | null = null;
let rootEl: HTMLElement | null = null;
let tabUpdateFns = new Map<string, () => void>();
let activeTabId: string | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;

/* ─────────────────────────────────────────────────
 *  Small DOM helpers
 * ───────────────────────────────────────────────── */

function $<T extends HTMLElement = HTMLDivElement>(
  tag: string,
  attrs: Record<string, string | undefined> = {},
  children: (string | HTMLElement)[] = [],
): T {
  const el = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    el.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === "string") el.appendChild(document.createTextNode(child));
    else el.appendChild(child);
  }
  return el;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, "");
}

function fmtClock(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString();
}

function kv(key: string, value: string, pill?: "ok" | "warn" | "dim" | "fault"): HTMLElement {
  const v = pill
    ? $<HTMLSpanElement>("span", { class: `db-pill ${pill}` }, [
        $("span", { class: "db-dot" }),
        value,
      ])
    : $("span", { class: "v mono" }, [value]);
  return $("div", { class: "db-kv" }, [$("span", { class: "k" }, [key]), v]);
}

function metricRow(label: string, value: number): HTMLElement {
  const pct = Math.round(value * 100);
  const color = value > 0.85 ? "#f54c4c" : value > 0.7 ? "#f5a04c" : "#4cf5a0";
  const fill = $("div", { class: "db-metric-fill" });
  fill.style.width = `${pct}%`;
  fill.style.background = color;
  return $("div", { class: "db-metric", "data-metric": label }, [
    $("span", {}, [label]),
    $("div", { class: "db-metric-track" }, [fill]),
    $("span", { class: "db-metric-pct" }, [`${pct}%`]),
  ]);
}

function section(title: string, ...body: HTMLElement[]): HTMLElement {
  return $("div", { class: "db-section" }, [
    $("div", { class: "db-section-head" }, [title]),
    $("div", { class: "db-section-body" }, body),
  ]);
}

/* ─────────────────────────────────────────────────
 *  mount / unmount
 * ───────────────────────────────────────────────── */

export async function mount(
  mountPoint: HTMLElement,
  serverData: ServerInstance,
  hostAPI: HostAPI,
): Promise<void> {
  // A second mount can race a first (React StrictMode remount, two detail
  // views). Tear the old one down so listeners/timers/tabs never leak.
  if (state) unmount();

  rootEl = mountPoint;
  const overrides = serverData.userOverrides ?? {};
  state = {
    serverData,
    hostAPI,
    running: serverData.status === "running",
    metrics: { cpu: 0, ram: 0, status: serverData.status || "stopped" },
    logLines: [],
    lastActivity: null,
    botTag: null,
    tokenConfigured: false,
    tokenDraft: "",
    tokenBusy: false,
    clearArmed: false,
    runtime: overrides.runtime || "node",
    entry: overrides.entry || "index.js",
    tokenEnv: overrides.token_env || "DISCORD_TOKEN",
    unlistenLog: null,
    unlistenStatus: null,
    metricsTimer: null,
  };

  registerTabs(hostAPI);
  hostAPI.registerToolbarAction({
    id: "dbot-restart",
    label: "restart bot",
    order: 60,
    onClick() {
      void restartBot();
    },
  });

  subscribeToServer();
  render();
  void refreshRunning();
  void refreshTokenState();
  void loadInitialLog();
}

export function unmount(): void {
  if (!state) return;
  const { hostAPI } = state;

  if (state.unlistenLog) state.unlistenLog();
  if (state.unlistenStatus) state.unlistenStatus();
  if (state.metricsTimer) clearInterval(state.metricsTimer);
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  hostAPI.unregisterTab("dbot-status");
  hostAPI.unregisterTab("dbot-setup");
  hostAPI.unregisterToolbarAction("dbot-restart");

  state = null;
  rootEl = null;
  activeTabId = null;
  tabUpdateFns = new Map();
}

/* ─────────────────────────────────────────────────
 *  Tabs
 * ───────────────────────────────────────────────── */

function registerTabs(api: HostAPI): void {
  api.registerTab({
    id: "dbot-status",
    label: "Status",
    mount: (el) => {
      tabUpdateFns.set("dbot-status", () => {
        if (!state) return;
        el.innerHTML = "";
        el.appendChild(renderStatusTab());
      });
      activeTabId = "dbot-status";
      tabUpdateFns.get("dbot-status")?.();
    },
    unmount: () => tabUpdateFns.delete("dbot-status"),
  });

  api.registerTab({
    id: "dbot-setup",
    label: "Setup",
    mount: (el) => {
      tabUpdateFns.set("dbot-setup", () => {
        if (!state) return;
        el.innerHTML = "";
        el.appendChild(renderSetupTab());
      });
      activeTabId = "dbot-setup";
      tabUpdateFns.get("dbot-setup")?.();
    },
    unmount: () => tabUpdateFns.delete("dbot-setup"),
  });
}

function render(): void {
  if (!state || !activeTabId) return;
  const fn = tabUpdateFns.get(activeTabId);
  if (fn) fn();
}

/** Coalesces log-driven renders so a chatty bot can't thrash the DOM. */
function scheduleRender(): void {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, RENDER_THROTTLE_MS);
}

/* ─────────────────────────────────────────────────
 *  Data
 * ───────────────────────────────────────────────── */

function subscribeToServer(): void {
  if (!state) return;
  const id = state.serverData.id;

  state.hostAPI
    .listen(`log:${id}:stream`, (payload) => {
      if (!state) return;
      ingestLogLine(String(payload));
    })
    .then((unlisten) => {
      if (state) state.unlistenLog = unlisten;
    })
    .catch(() => {
      /* non-fatal */
    });

  state.hostAPI
    .listen(`status:${id}`, (payload) => {
      if (!state) return;
      const status = payload as StatusPayload;
      if (status.state === "running") {
        state.running = true;
        startMetrics();
      } else {
        state.running = false;
        state.botTag = null;
        stopMetrics();
      }
      render();
    })
    .then((unlisten) => {
      if (state) state.unlistenStatus = unlisten;
    })
    .catch(() => {
      /* non-fatal */
    });
}

function ingestLogLine(raw: string): void {
  if (!state) return;
  const line = stripAnsi(raw);
  state.logLines.push(line);
  if (state.logLines.length > LOG_BUFFER) {
    state.logLines = state.logLines.slice(-LOG_BUFFER);
  }
  state.lastActivity = Date.now();

  const match = line.match(/Logged in as\s+([^\s!]+)/i);
  if (match) state.botTag = match[1];

  scheduleRender();
}

async function loadInitialLog(): Promise<void> {
  if (!state) return;
  try {
    const lines = (await state.hostAPI.invoke("get_log_tail", {
      id: state.serverData.id,
      maxLines: LOG_BUFFER,
    })) as string[];
    if (!state || !Array.isArray(lines)) return;
    state.logLines = lines.map(stripAnsi);
    for (const line of state.logLines) {
      const match = line.match(/Logged in as\s+([^\s!]+)/i);
      if (match) state.botTag = match[1];
    }
    render();
  } catch {
    /* no log yet — the Status tab renders an empty state */
  }
}

async function refreshRunning(): Promise<void> {
  if (!state) return;
  try {
    const running = (await state.hostAPI.invoke("is_server_running", {
      id: state.serverData.id,
    })) as boolean;
    if (!state) return;
    state.running = running;
    if (running) startMetrics();
    render();
  } catch {
    /* non-fatal */
  }
}

async function refreshTokenState(): Promise<void> {
  if (!state) return;
  try {
    const value = (await state.hostAPI.invoke("plugin_secret_get", {
      pluginId: PLUGIN_ID,
      key: SECRET_KEY,
    })) as string | null;
    if (!state) return;
    state.tokenConfigured = !!value;
    render();
  } catch {
    /* permission or vault unavailable — treat as not configured */
  }
}

function startMetrics(): void {
  if (!state || state.metricsTimer) return;
  void pollMetrics();
  state.metricsTimer = setInterval(() => void pollMetrics(), 2000);
}

function stopMetrics(): void {
  if (!state) return;
  if (state.metricsTimer) {
    clearInterval(state.metricsTimer);
    state.metricsTimer = null;
  }
  state.metrics = { cpu: 0, ram: 0, status: "stopped" };
}

async function pollMetrics(): Promise<void> {
  if (!state) return;
  try {
    const metrics = (await state.hostAPI.invoke("get_instance_metrics", {
      id: state.serverData.id,
    })) as InstanceMetrics;
    if (!state) return;
    state.metrics = metrics;
    patchMetrics();
  } catch {
    /* leave the last reading in place */
  }
}

/** Patches the gauges in place so polling doesn't rebuild the tab. */
function patchMetrics(): void {
  if (!state) return;
  const root = rootEl?.getRootNode() as ShadowRoot | Document | null;
  if (!root) return;
  for (const [label, value] of [
    ["cpu", state.metrics.cpu],
    ["ram", state.metrics.ram],
  ] as const) {
    const row = root.querySelector<HTMLElement>(`.db-metric[data-metric="${label}"]`);
    if (!row) continue;
    const pct = Math.round(value * 100);
    const color = value > 0.85 ? "#f54c4c" : value > 0.7 ? "#f5a04c" : "#4cf5a0";
    const fill = row.querySelector<HTMLElement>(".db-metric-fill");
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.style.background = color;
    }
    const text = row.querySelector<HTMLElement>(".db-metric-pct");
    if (text) text.textContent = `${pct}%`;
  }
  const activity = root.querySelector<HTMLElement>('[data-kv="last-activity"] .v');
  if (activity) activity.textContent = fmtClock(state.lastActivity);
}

/* ─────────────────────────────────────────────────
 *  Actions
 * ───────────────────────────────────────────────── */

async function restartBot(): Promise<void> {
  if (!state) return;
  const { hostAPI, serverData } = state;
  try {
    await hostAPI.invoke("restart_server_instance", { id: serverData.id });
    hostAPI.notify("info", "restarting bot", serverData.name);
  } catch (err) {
    hostAPI.notify("error", "restart failed", String(err));
  }
}

async function saveToken(): Promise<void> {
  if (!state) return;
  const token = state.tokenDraft.trim();
  if (!token) return;
  if (/[\r\n]/.test(token)) {
    state.hostAPI.notify("error", "invalid token", "the token must be a single line");
    return;
  }
  state.tokenBusy = true;
  render();
  try {
    await state.hostAPI.invoke("plugin_secret_set", {
      pluginId: PLUGIN_ID,
      key: SECRET_KEY,
      value: token,
    });
    await state.hostAPI.invoke("write_server_file", {
      id: state.serverData.id,
      relPath: ".env",
      content: `${state.tokenEnv}=${token}\n`,
    });
    if (!state) return;
    state.tokenConfigured = true;
    state.tokenDraft = "";
    state.clearArmed = false;
    state.hostAPI.notify("success", "token saved", "stored in the OS credential vault");
  } catch (err) {
    if (state) state.hostAPI.notify("error", "could not save token", String(err));
  } finally {
    if (state) {
      state.tokenBusy = false;
      render();
    }
  }
}

async function clearToken(): Promise<void> {
  if (!state) return;
  if (!state.clearArmed) {
    state.clearArmed = true;
    render();
    return;
  }
  const envKey = state.tokenEnv;
  const serverId = state.serverData.id;
  state.tokenBusy = true;
  render();
  try {
    await state.hostAPI.invoke("plugin_secret_delete", {
      pluginId: PLUGIN_ID,
      key: SECRET_KEY,
    });
    // Blank the key in .env, preserving any other lines.
    try {
      const file = (await state.hostAPI.invoke("read_server_file", {
        id: serverId,
        relPath: ".env",
      })) as { content: string };
      const kept = file.content
        .split(/\r?\n/)
        .filter((line) => !line.startsWith(`${envKey}=`));
      await state.hostAPI.invoke("write_server_file", {
        id: serverId,
        relPath: ".env",
        content: kept.join("\n").trim() ? kept.join("\n") + "\n" : "",
      });
    } catch {
      /* .env may not exist yet — nothing to blank */
    }
    if (!state) return;
    state.tokenConfigured = false;
    state.clearArmed = false;
    state.hostAPI.notify("info", "token cleared");
  } catch (err) {
    if (state) state.hostAPI.notify("error", "could not clear token", String(err));
  } finally {
    if (state) {
      state.tokenBusy = false;
      render();
    }
  }
}

/* ─────────────────────────────────────────────────
 *  Rendering
 * ───────────────────────────────────────────────── */

function gatewayState(): { label: string; cls: string } {
  if (!state) return { label: "offline", cls: "dim" };
  if (!state.running) return { label: "offline", cls: "dim" };
  if (state.botTag) return { label: "gateway connected", cls: "ok" };
  return { label: "waiting for login", cls: "warn" };
}

function renderStatusTab(): HTMLElement {
  const s = state!;
  const gateway = gatewayState();

  const processPill = $("span", { class: `db-pill ${s.running ? "ok" : "dim"}` }, [
    $("span", { class: "db-dot" }),
    s.running ? "running" : "stopped",
  ]);
  const gatewayPill = $("span", { class: `db-pill ${gateway.cls}` }, [
    $("span", { class: "db-dot" }),
    gateway.label,
  ]);

  const runtimeSection = section(
    "configuration",
    kv("runtime", s.runtime),
    kv("entry", s.entry),
    kv("token env", s.tokenEnv),
    kv("bot token", s.tokenConfigured ? "configured" : "missing", s.tokenConfigured ? "ok" : "warn"),
    kv("last activity", fmtClock(s.lastActivity)),
    kv("bot tag", s.botTag ?? "—"),
  );

  const metricsSection = section(
    "telemetry",
    s.running
      ? $("div", {}, [metricRow("cpu", s.metrics.cpu), metricRow("ram", s.metrics.ram)])
      : $("div", { class: "db-empty" }, ["metrics appear while the bot is running"]),
  );

  const recent = s.logLines.slice(-12).reverse();
  const logLines = recent.length
    ? recent.map((line, i) => $("div", { class: `db-log-line${i === 0 ? " hot" : ""}` }, [line]))
    : [$("div", { class: "db-empty" }, ["no output yet — start the bot to see its console here"])];
  const logSection = section("recent output", $("div", { class: "db-log" }, logLines));

  return $("div", { class: "db-tab" }, [
    $("div", { class: "db-header" }, [
      $("span", { class: "db-header-title" }, ["discord bot"]),
      processPill,
      $("span", { class: "db-header-spacer" }),
      gatewayPill,
    ]),
    $("div", { class: "db-body" }, [runtimeSection, metricsSection, logSection]),
  ]);
}

function renderSetupTab(): HTMLElement {
  const s = state!;

  const input = $("input", {
    class: "db-input",
    type: "password",
    placeholder: "paste the bot token…",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  input.value = s.tokenDraft;
  input.addEventListener("input", () => {
    if (!state) return;
    state.tokenDraft = input.value;
    state.clearArmed = false;
    const save = rootEl
      ?.getRootNode()
      .querySelector<HTMLButtonElement>(".db-btn.primary");
    if (save) save.disabled = state.tokenBusy || input.value.trim().length === 0;
  });

  const saveBtn = $(
    "button",
    { class: "db-btn primary", type: "button" },
    [s.tokenBusy ? "saving…" : "save token"],
  ) as HTMLButtonElement;
  saveBtn.disabled = s.tokenBusy || s.tokenDraft.trim().length === 0;
  saveBtn.addEventListener("click", () => void saveToken());

  const clearBtn = $(
    "button",
    { class: "db-btn danger", type: "button" },
    [s.clearArmed ? "confirm clear" : "clear token"],
  ) as HTMLButtonElement;
  clearBtn.disabled = s.tokenBusy || !s.tokenConfigured;
  clearBtn.addEventListener("click", () => void clearToken());

  const tokenSection = section(
    "bot token",
    kv("status", s.tokenConfigured ? "stored in vault" : "not set", s.tokenConfigured ? "ok" : "warn"),
    input,
    $("div", { class: "db-actions" }, [saveBtn, clearBtn]),
    $("p", { class: "db-hint" }, [
      "the token is kept in the os credential vault. saving also writes ",
      `${s.tokenEnv}=…`,
      " to ",
      $("span", { class: "v mono" }, [`${s.serverData.path}\\.env`]),
      ", which the host injects when it launches the bot.",
    ]),
  );

  const installHint =
    s.runtime === "rust"
      ? "cargo build"
      : s.runtime === "deno"
        ? "deno install"
        : s.runtime === "bun"
          ? "bun install"
          : "npm install";
  const nextSection = section(
    "next steps",
    $("p", { class: "db-hint" }, ["1. save the bot token above."]),
    $("p", { class: "db-hint" }, [`2. run the install step (${installHint}) from the lifecycle toolbar.`]),
    $("p", { class: "db-hint" }, ["3. start the bot — its console streams into the status tab."]),
  );

  return $("div", { class: "db-tab" }, [
    $("div", { class: "db-header" }, [
      $("span", { class: "db-header-title" }, ["discord bot · setup"]),
      $("span", { class: "db-header-spacer" }),
      $("span", { class: `db-pill ${s.tokenConfigured ? "ok" : "warn"}` }, [
        $("span", { class: "db-dot" }),
        s.tokenConfigured ? "token stored" : "token missing",
      ]),
    ]),
    $("div", { class: "db-body" }, [tokenSection, nextSection]),
  ]);
}
