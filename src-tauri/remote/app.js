/*
  kern remote panel.

  A small no-build SPA for the web remote. Talks to the same API the desktop
  app and CLI use (`/api/*` on this origin), pairs as a device with a role, and
  streams console/status over SSE.
*/
(() => {
  "use strict";

  // ── state ─────────────────────────────────────────────────────────────
  const state = {
    token: localStorage.getItem("kern.token") || "",
    user: null,
    servers: [],
    route: { name: "overview" },
    events: null, // events SSE handle
    console: null, // console SSE handle
    filesPath: "",
    metricsWindow: 3600,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ── formatting ────────────────────────────────────────────────────────
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / 1024 ** i;
    return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function fmtUptime(secs) {
    if (!secs && secs !== 0) return "—";
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${secs}s`;
  }

  function fmtAgo(unixSecs) {
    if (!unixSecs) return "—";
    const diff = Math.max(0, Date.now() / 1000 - unixSecs);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function fmtTime(unixSecs) {
    if (!unixSecs) return "—";
    return new Date(unixSecs * 1000).toLocaleString();
  }

  function statusClass(status) {
    const s = String(status || "");
    if (s === "running") return "running";
    if (["error", "stopped-forced", "crashed"].includes(s)) return "error";
    if (["starting", "stopping", "installing"].includes(s)) return "starting";
    return "stopped";
  }

  function toast(message, kind) {
    const box = $("#toasts");
    const node = document.createElement("div");
    node.className = "toast" + (kind ? " " + kind : "");
    node.textContent = message;
    box.appendChild(node);
    setTimeout(() => node.remove(), 5200);
  }

  // ── api ───────────────────────────────────────────────────────────────
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign(
      { Authorization: "Bearer " + state.token },
      opts.headers || {},
    );
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
    }
    const res = await fetch("/api" + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers,
      body: opts.body,
    });
    if (res.status === 401) {
      signOut("this device was signed out — pair again");
      throw new Error("unauthorized");
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `http ${res.status}`);
    }
    return data;
  }

  function can(scope) {
    if (!state.user) return false;
    const role = state.user.role;
    if (role === "admin") return true;
    if (role === "operator") return scope !== "admin";
    return scope === "view";
  }

  // ── gate: pairing / session ───────────────────────────────────────────
  function gate(html) {
    $("#app").classList.add("hidden");
    $("#gate").classList.remove("hidden");
    $("#gate-body").innerHTML = html;
  }

  function showApp() {
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  function signOut(message) {
    localStorage.removeItem("kern.token");
    state.token = "";
    state.user = null;
    stopEvents();
    gate(
      `<h2>signed out</h2><p class="muted">${esc(message || "this device is no longer paired.")}</p>
       <p class="muted" style="margin-top:14px">ask the owner for a new invite link from kern → settings → web remote.</p>`,
    );
  }

  function deviceLabel() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return "ios device";
    if (/Android/.test(ua)) return "android device";
    if (/Macintosh/.test(ua)) return "mac browser";
    if (/Windows/.test(ua)) return "windows browser";
    if (/Linux/.test(ua)) return "linux browser";
    return "browser";
  }

  async function pair(code) {
    const data = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, device: deviceLabel() }),
    }).then((r) => r.json().then((j) => ({ ok: r.ok, j })));
    if (!data.ok) throw new Error(data.j.error || "pairing failed");
    state.token = data.j.token;
    localStorage.setItem("kern.token", state.token);
    history.replaceState(null, "", location.pathname);
  }

  async function boot() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(location.search);

    // Legacy QR: ?token= stays supported as the owner credential.
    if (query.get("token")) {
      state.token = query.get("token");
      localStorage.setItem("kern.token", state.token);
      history.replaceState(null, "", location.pathname);
    }

    const invite = hash.get("invite");
    if (invite) {
      let preview = null;
      try {
        const res = await fetch("/api/invite?code=" + encodeURIComponent(invite));
        preview = await res.json();
        if (!res.ok) preview = null;
      } catch {
        preview = null;
      }
      gate(
        preview && preview.valid
          ? `<h2>pair this device</h2>
             <p class="muted">invite for <b class="green">${esc(preview.name)}</b> · ${esc(preview.role)}</p>
             <button class="btn primary" id="pair-btn" style="margin-top:16px">connect</button>`
          : `<h2>invite unavailable</h2>
             <p class="muted">this invite is expired or already used. ask for a fresh link.</p>
             <div class="field-row" style="margin-top:16px"><input id="code-input" placeholder="invite code" autocapitalize="characters"></div>
             <button class="btn" id="pair-btn">use code</button>`,
      );
      $("#pair-btn").onclick = async () => {
        const code = preview && preview.valid ? invite : ($("#code-input") || {}).value;
        try {
          await pair(code || "");
          boot2();
        } catch (e) {
          toast(e.message, "err");
        }
      };
      return;
    }

    if (!state.token) {
      gate(
        `<h2>pair this device</h2>
         <p class="muted">open an invite link from kern → settings → web remote, or paste the code:</p>
         <div class="field-row" style="margin-top:16px"><input id="code-input" placeholder="invite code" autocapitalize="characters"></div>
         <button class="btn primary" id="pair-btn">connect</button>`,
      );
      $("#pair-btn").onclick = async () => {
        try {
          await pair(($("#code-input") || {}).value || "");
          boot2();
        } catch (e) {
          toast(e.message, "err");
        }
      };
      return;
    }

    boot2();
  }

  async function boot2() {
    try {
      const session = await api("/remote/session");
      state.user = session.user;
    } catch {
      return; // api() already showed the gate on 401
    }
    showApp();
    renderNav();
    window.addEventListener("hashchange", route);
    route();
    startEvents();
  }

  // ── SSE ───────────────────────────────────────────────────────────────
  function sse(path, onEvent, onState) {
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      while (!stopped) {
        try {
          const res = await fetch("/api" + path, {
            headers: { Authorization: "Bearer " + state.token },
            signal: controller.signal,
          });
          if (res.status === 401) {
            signOut();
            return;
          }
          if (!res.ok || !res.body) throw new Error("stream failed");
          onState && onState("live");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              let event = "message";
              let data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
                else if (line.startsWith(":")) continue;
              }
              if (data) {
                try {
                  onEvent(event, JSON.parse(data));
                } catch {
                  onEvent(event, data);
                }
              }
            }
          }
        } catch (e) {
          if (stopped || e.name === "AbortError") return;
          onState && onState("offline");
        }
        if (!stopped) {
          onState && onState("offline");
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }

  function setConn(text, cls) {
    const node = $("#conn");
    if (!node) return;
    node.textContent = text;
    node.className = "conn " + (cls || "");
  }

  function startEvents() {
    stopEvents();
    state.events = sse(
      "/events",
      (event, data) => {
        if (event === "statuses" && data.servers) {
          applyStatuses(data.servers);
        } else if (event === "audit") {
          if (state.route.name === "audit") loadAudit();
        }
      },
      (status) => {
        setConn(status === "live" ? "live" : "offline", status === "live" ? "live" : "offline");
        if (status === "live") {
          refreshServers();
        }
      },
    );
  }

  function stopEvents() {
    if (state.events) state.events();
    state.events = null;
  }

  function applyStatuses(list) {
    let changed = false;
    for (const s of list) {
      const existing = state.servers.find((x) => x.id === s.id);
      if (existing) {
        if (existing.status !== s.status || existing.running !== s.running) {
          existing.status = s.status;
          existing.running = s.running;
          changed = true;
        }
      } else {
        changed = true;
      }
    }
    if (changed && state.route.name === "overview") renderOverview();
  }

  // ── nav / routing ─────────────────────────────────────────────────────
  const NAV = [
    { key: "overview", label: "overview", glyph: "▦" },
    { key: "audit", label: "audit", glyph: "≣" },
    { key: "settings", label: "settings", glyph: "⚙" },
  ];

  function renderNav() {
    const active = state.route.name;
    $("#nav").innerHTML = NAV.map(
      (n) =>
        `<button data-nav="${n.key}" class="${active === n.key ? "active" : ""}">${n.label}</button>`,
    ).join("");
    $("#mobile-nav").innerHTML = NAV.map(
      (n) =>
        `<button data-nav="${n.key}" class="${active === n.key ? "active" : ""}">
           <span class="glyph">${n.glyph}</span>${n.label}
         </button>`,
    ).join("");
    $$("[data-nav]").forEach((btn) => {
      btn.onclick = () => {
        location.hash = "#/" + btn.dataset.nav;
      };
    });
    if (state.user) {
      $("#user-chip").innerHTML = `${esc(state.user.name)} <span class="dim">· ${esc(state.user.role)}</span>`;
    }
  }

  function route() {
    closeConsole();
    const hash = location.hash.replace(/^#\/?/, "");
    const parts = hash.split("/").filter(Boolean);
    state.route =
      parts[0] === "s" && parts[1]
        ? { name: "server", id: decodeURIComponent(parts[1]), tab: parts[2] || "console" }
        : { name: parts[0] || "overview" };

    if (state.route.name === "overview") renderOverview();
    else if (state.route.name === "audit") renderAudit();
    else if (state.route.name === "settings") renderSettings();
    else if (state.route.name === "server") renderServer(state.route.id, state.route.tab);
    else renderOverview();
    renderNav();
  }

  // ── overview ──────────────────────────────────────────────────────────
  async function refreshServers() {
    try {
      const data = await api("/servers");
      state.servers = data.servers || [];
      if (state.route.name === "overview") renderOverview();
    } catch {}
  }

  async function renderOverview() {
    const main = $("#main");
    let host = null;
    try {
      host = await api("/status");
    } catch {}

    const groups = {};
    for (const s of state.servers) {
      const g = s.group || "";
      (groups[g] = groups[g] || []).push(s);
    }

    const running = state.servers.filter((s) => s.running).length;

    main.innerHTML = `
      <h1 class="h1">overview</h1>
      <p class="sub">${running}/${state.servers.length} running${
        host ? ` · host cpu ${Math.round((host.host.cpu || 0) * 100)}% · ram ${Math.round((host.host.ram || 0) * 100)}%` : ""
      }</p>
      ${Object.keys(groups)
        .sort()
        .map(
          (g) => `
          ${g ? `<div class="sub" style="margin:14px 0 8px;letter-spacing:.2em;text-transform:uppercase">${esc(g)}</div>` : ""}
          <div class="cards">${groups[g].map(serverCard).join("")}</div>`,
        )
        .join("") ||
        `<p class="empty">no instances registered yet. create one in the kern desktop app.</p>`}
    `;
    wireServerActions(main);
  }

  function serverCard(s) {
    const m = s.metrics || { cpu: 0, ram: 0 };
    const cpu = Math.round((m.cpu || 0) * 100);
    const ram = Math.round((m.ram || 0) * 100);
    return `
      <div class="card">
        <div class="spread" style="margin-bottom:8px">
          <a class="row grow" href="#/s/${encodeURIComponent(s.id)}" style="color:inherit;text-decoration:none">
            <span class="dot ${statusClass(s.status)}"></span>
            <b class="nowrap">${esc(s.name)}</b>
          </a>
          <span class="chip ${s.orphaned ? "bad" : ""}">${esc(s.orphaned ? "orphan" : s.status || "unknown")}</span>
        </div>
        <div class="row" style="gap:16px;font-size:11px;color:var(--dim)">
          <span>${esc(s.type || "")}</span>
          <span>${s.uptimeSecs ? "up " + fmtUptime(s.uptimeSecs) : ""}</span>
        </div>
        <div class="meter-label">cpu ${cpu}%</div>
        <div class="bar"><i style="width:${cpu}%"></i></div>
        <div class="meter-label">ram ${ram}%</div>
        <div class="bar ram"><i style="width:${ram}%"></i></div>
        <div class="row" style="margin-top:12px;gap:6px">
          ${actionsHtml(s)}
        </div>
      </div>`;
  }

  function actionsHtml(s) {
    if (!can("control")) return "";
    if (s.running) {
      return `<button class="btn" data-act="restart" data-id="${esc(s.id)}">restart</button>
              <button class="btn danger" data-act="stop" data-id="${esc(s.id)}">stop</button>
              <a class="btn" href="#/s/${encodeURIComponent(s.id)}" style="text-decoration:none">open</a>`;
    }
    return `<button class="btn primary" data-act="start" data-id="${esc(s.id)}" ${s.orphaned ? "disabled" : ""}>start</button>
            <a class="btn" href="#/s/${encodeURIComponent(s.id)}" style="text-decoration:none">open</a>`;
  }

  function wireServerActions(root) {
    $$("[data-act]", root).forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { act, id } = btn.dataset;
        btn.disabled = true;
        try {
          await api(`/servers/${encodeURIComponent(id)}/${act}`, { method: "POST" });
          toast(`${act} accepted`, act === "stop" ? "warn" : "");
          setTimeout(refreshServers, 900);
        } catch (err) {
          toast(err.message, "err");
        } finally {
          btn.disabled = false;
        }
      };
    });
  }

  // ── server view ───────────────────────────────────────────────────────
  const TABS = [
    { key: "console", label: "console" },
    { key: "metrics", label: "metrics" },
    { key: "files", label: "files" },
    { key: "backups", label: "backups" },
    { key: "tasks", label: "tasks" },
  ];

  async function renderServer(id, tab) {
    closeConsole();
    const main = $("#main");
    let server = state.servers.find((s) => s.id === id);
    if (!server) {
      try {
        await refreshServers();
        server = state.servers.find((s) => s.id === id);
      } catch {}
    }
    if (!server) {
      main.innerHTML = `<p class="empty">server not found.</p>`;
      return;
    }

    main.innerHTML = `
      <div class="row" style="gap:10px;margin-bottom:4px">
        <span class="dot ${statusClass(server.status)}"></span>
        <h1 class="h1" style="margin:0">${esc(server.name)}</h1>
        <span class="chip">${esc(server.status || "unknown")}</span>
        ${server.orphaned ? '<span class="chip bad">orphan</span>' : ""}
      </div>
      <p class="sub">${esc(server.type || "")} · ${server.uptimeSecs ? "up " + fmtUptime(server.uptimeSecs) : "stopped"} · <span id="srv-metrics"></span></p>
      <div class="row wrap" style="margin-bottom:16px;gap:6px" id="srv-actions">${actionsHtml(server)}</div>
      <div class="tabs">
        ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === tab ? "active" : ""}">${t.label}</button>`).join("")}
      </div>
      <div id="tab-body"></div>
    `;
    $$("[data-tab]").forEach((btn) => {
      btn.onclick = () => (location.hash = `#/s/${encodeURIComponent(id)}/${btn.dataset.tab}`);
    });
    wireServerActions($("#srv-actions"));

    const metricsNode = $("#srv-metrics");
    const paint = () => {
      const m = server.metrics || {};
      metricsNode.textContent = `cpu ${Math.round((m.cpu || 0) * 100)}% · ram ${Math.round((m.ram || 0) * 100)}%`;
    };
    paint();
    const timer = setInterval(() => {
      const fresh = state.servers.find((s) => s.id === id);
      if (fresh) {
        server = fresh;
        paint();
      }
    }, 3000);
    // Clear the timer when navigating away.
    const clearOnHash = () => {
      if (!location.hash.includes(`/s/${encodeURIComponent(id)}`)) {
        clearInterval(timer);
        window.removeEventListener("hashchange", clearOnHash);
      }
    };
    window.addEventListener("hashchange", clearOnHash);

    const body = $("#tab-body");
    if (tab === "console") tabConsole(body, server);
    else if (tab === "metrics") tabMetrics(body, server);
    else if (tab === "files") tabFiles(body, server);
    else if (tab === "backups") tabBackups(body, server);
    else if (tab === "tasks") tabTasks(body, server);
  }

  // console
  function closeConsole() {
    if (state.console) state.console();
    state.console = null;
  }

  function ansiLine(text) {
    // Minimal SGR mapping: errors/warnings/ok read as colors, everything else
    // stays plain. ANSI escapes are stripped either way.
    let cls = "";
    // eslint-disable-next-line no-control-regex
    if (/\u001b\[(31|91)m/.test(text) || /\[(ERROR|FATAL)\]/i.test(text)) cls = "err";
    // eslint-disable-next-line no-control-regex
    else if (/\u001b\[(33|93)m/.test(text) || /\[(WARN|WARNING)\]/i.test(text)) cls = "warn";
    // eslint-disable-next-line no-control-regex
    else if (/\u001b\[(32|92)m/.test(text)) cls = "ok";
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
    const ts = clean.match(/^\[?(\d{2}:\d{2}:\d{2})\]?\s?/);
    let rest = clean;
    let stamp = "";
    if (ts) {
      stamp = ts[1];
      rest = clean.slice(ts[0].length);
    }
    return `${stamp ? `<span class="ts">${esc(stamp)}</span> ` : ""}<span class="${cls}">${esc(rest)}</span>`;
  }

  function tabConsole(body, server) {
    body.innerHTML = `
      <div class="console-wrap">
        <pre class="console" id="console"></pre>
        ${
          can("control")
            ? `<form class="console-form" id="console-form">
                 <input id="console-input" placeholder="type a command and press enter" autocomplete="off" ${server.running ? "" : 'title="server is not running — commands may be ignored"'}>
                 <button class="btn" type="submit">send</button>
               </form>`
            : ""
        }
      </div>`;

    const box = $("#console");
    const history = [];
    let historyIdx = -1;

    const append = (lines) => {
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      const frag = document.createElement("div");
      for (const line of lines) {
        const span = document.createElement("span");
        span.className = "ln";
        span.innerHTML = ansiLine(line);
        frag.appendChild(span);
      }
      box.appendChild(frag);
      while (box.childElementCount > 3000) box.firstElementChild.remove();
      if (nearBottom) box.scrollTop = box.scrollHeight;
    };

    state.console = sse(
      `/servers/${encodeURIComponent(server.id)}/console`,
      (event, data) => {
        if (event === "tail" || event === "log") append(data.lines || []);
        else if (event === "reset") append(["— log rotated —"]);
        else if (event === "status") {
          const dot = $(".dot", $("#main"));
          if (dot) dot.className = "dot " + statusClass(data.status);
        }
      },
      (status) => setConn(status === "live" ? "live" : "offline", status === "live" ? "live" : "offline"),
    );

    const form = $("#console-form");
    if (form) {
      const input = $("#console-input");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const line = input.value.trim();
        if (!line) return;
        input.value = "";
        history.push(line);
        historyIdx = history.length;
        try {
          await api(`/servers/${encodeURIComponent(server.id)}/stdin`, { json: { line } });
        } catch (err) {
          toast(err.message, "err");
        }
      };
      input.onkeydown = (e) => {
        if (e.key === "ArrowUp") {
          if (historyIdx > 0) input.value = history[--historyIdx];
          e.preventDefault();
        } else if (e.key === "ArrowDown") {
          if (historyIdx < history.length - 1) input.value = history[++historyIdx];
          else {
            historyIdx = history.length;
            input.value = "";
          }
          e.preventDefault();
        }
      };
      input.focus();
    }
  }

  // metrics
  async function tabMetrics(body, server) {
    body.innerHTML = `
      <div class="row wrap" style="gap:6px;margin-bottom:10px">
        ${[1, 6, 24, 168]
          .map(
            (h) =>
              `<button class="btn ${state.metricsWindow === h * 3600 ? "primary" : ""}" data-window="${h}">${h}h</button>`,
          )
          .join("")}
        <span class="muted grow right" id="chart-meta"></span>
      </div>
      <div class="chart-wrap">
        <canvas class="chart" id="chart"></canvas>
      </div>
      <p class="muted" style="font-size:11px;margin-top:8px">sampled once a minute — green cpu, amber ram.</p>`;

    const load = async (win) => {
      state.metricsWindow = win;
      try {
        const data = await api(
          `/servers/${encodeURIComponent(server.id)}/metrics?window=${win}`,
        );
        drawChart($("#chart"), data.samples || []);
        $("#chart-meta").textContent = `${(data.samples || []).length} samples`;
      } catch (err) {
        toast(err.message, "err");
      }
    };
    $$("[data-window]", body).forEach((btn) => {
      btn.onclick = () => {
        $$("[data-window]", body).forEach((b) => b.classList.remove("primary"));
        btn.classList.add("primary");
        load(Number(btn.dataset.window) * 3600);
      };
    });
    load(state.metricsWindow);
    new MutationObserver(() => {}).disconnect(); // no-op; chart is static per window
  }

  function drawChart(canvas, samples) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(320, rect.width) * dpr;
    canvas.height = 140 * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = "#161920";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    if (!samples || samples.length < 2) {
      ctx.fillStyle = "#4c525e";
      ctx.font = "11px monospace";
      ctx.fillText("not enough samples yet", 10, h / 2);
      return;
    }

    const at = samples.map((s) => s.at || s.timestamp || 0);
    const minT = Math.min(...at);
    const maxT = Math.max(...at) || minT + 1;
    const x = (t) => ((t - minT) / (maxT - minT || 1)) * w;
    const y = (v) => h - Math.min(1, Math.max(0, v)) * (h - 6) - 3;

    const line = (key, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const s of samples) {
        const v = Number(s[key] ?? s[key === "cpu" ? "cpu" : "ram"] ?? 0);
        const px = x(s.at || s.timestamp || 0);
        const py = y(v);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    line("cpu", "#4cf5a0");
    line("ram", "#f5a04c");
  }

  // files
  async function tabFiles(body, server) {
    state.filesPath = "";
    body.innerHTML = `
      <div class="path-bar">
        <button class="btn" id="f-up">↑ up</button>
        <button class="btn" id="f-refresh">refresh</button>
        ${can("control") ? `<button class="btn" id="f-mkdir">new folder</button><button class="btn" id="f-upload">upload</button>` : ""}
        <span class="crumbs grow right" id="crumbs"></span>
      </div>
      <div class="files" id="filelist"><p class="empty">loading…</p></div>
      <input type="file" id="f-input" class="hidden">
      <div id="editor-slot"></div>`;

    const list = $("#filelist");
    const crumbs = $("#crumbs");

    const navigate = (path) => {
      state.filesPath = path || "";
      loadFiles();
    };

    const loadFiles = async () => {
      crumbs.innerHTML = "/" + esc(state.filesPath || "");
      try {
        const data = await api(
          `/servers/${encodeURIComponent(server.id)}/files?path=${encodeURIComponent(state.filesPath)}`,
        );
        const entries = (data.entries || []).slice().sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return String(a.name).localeCompare(String(b.name));
        });
        list.innerHTML =
          `<div class="frow head"><span>name</span><span class="col-size">size</span><span class="col-modified">modified</span><span></span></div>` +
          (entries.length
            ? entries
                .map(
                  (e) => `
              <div class="frow ${e.isDir ? "dir" : ""}" data-name="${esc(e.name)}" data-dir="${e.isDir ? "1" : ""}">
                <span class="nowrap">${e.isDir ? "▸ " : ""}${esc(e.name)}</span>
                <span class="col-size dim">${e.isDir ? "" : fmtBytes(e.size)}</span>
                <span class="col-modified dim">${fmtTime(e.modified)}</span>
                <span class="actions">
                  ${!e.isDir ? `<button class="btn" data-download="${esc(e.name)}">get</button>` : ""}
                  ${can("control") ? `<button class="btn danger" data-del="${esc(e.name)}">del</button>` : ""}
                </span>
              </div>`,
                )
                .join("")
            : `<p class="empty">empty directory.</p>`);

        $$(".frow[data-name]", list).forEach((row) => {
          row.onclick = (e) => {
            if (e.target.closest("button")) return;
            const name = row.dataset.name;
            const rel = state.filesPath ? `${state.filesPath}/${name}` : name;
            if (row.dataset.dir) navigate(rel);
            else openEditor(rel);
          };
        });
        $$("[data-download]", list).forEach((btn) => {
          btn.onclick = () => download(btn.dataset.download);
        });
        $$("[data-del]", list).forEach((btn) => {
          btn.onclick = async () => {
            const name = btn.dataset.del;
            const rel = state.filesPath ? `${state.filesPath}/${name}` : name;
            if (!confirm(`delete ${rel}?`)) return;
            try {
              await api(`/servers/${encodeURIComponent(server.id)}/files`, {
                json: { op: "delete_recursive", path: rel },
              });
              toast("deleted");
              loadFiles();
            } catch (err) {
              toast(err.message, "err");
            }
          };
        });
      } catch (err) {
        list.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      }
    };

    const download = async (name) => {
      const rel = state.filesPath ? `${state.filesPath}/${name}` : name;
      try {
        const res = await fetch(
          `/api/servers/${encodeURIComponent(server.id)}/download?path=${encodeURIComponent(rel)}`,
          { headers: { Authorization: "Bearer " + state.token } },
        );
        if (!res.ok) throw new Error("download failed");
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (err) {
        toast(err.message, "err");
      }
    };

    const openEditor = async (rel) => {
      const slot = $("#editor-slot");
      try {
        const file = await api(
          `/servers/${encodeURIComponent(server.id)}/file?path=${encodeURIComponent(rel)}`,
        );
        const mtime = file.mtime;
        slot.innerHTML = `
          <div class="spread" style="margin:14px 0 8px">
            <b class="nowrap">${esc(rel)}</b>
            <span class="row" style="gap:6px">
              ${can("control") ? `<button class="btn primary" id="ed-save">save</button>` : ""}
              <button class="btn" id="ed-close">close</button>
            </span>
          </div>
          <textarea class="editor" id="ed" spellcheck="false"></textarea>`;
        const ed = $("#ed");
        ed.value = file.content || "";
        $("#ed-close").onclick = () => (slot.innerHTML = "");
        if (can("control")) {
          $("#ed-save").onclick = async () => {
            try {
              await api(`/servers/${encodeURIComponent(server.id)}/file`, {
                method: "PUT",
                json: { path: rel, content: ed.value, expectedMtime: mtime },
              });
              toast("saved");
            } catch (err) {
              if (String(err.message).includes("conflict:")) {
                if (confirm("this file changed on disk since you opened it. overwrite anyway?")) {
                  try {
                    await api(`/servers/${encodeURIComponent(server.id)}/file`, {
                      method: "PUT",
                      json: { path: rel, content: ed.value },
                    });
                    toast("saved (overwrote)");
                  } catch (e2) {
                    toast(e2.message, "err");
                  }
                }
              } else {
                toast(err.message, "err");
              }
            }
          };
        }
      } catch (err) {
        toast(err.message, "err");
      }
    };

    $("#f-refresh").onclick = loadFiles;
    $("#f-up").onclick = () => {
      const parts = state.filesPath.split("/").filter(Boolean);
      parts.pop();
      navigate(parts.join("/"));
    };
    if ($("#f-mkdir")) {
      $("#f-mkdir").onclick = async () => {
        const name = prompt("folder name");
        if (!name) return;
        const rel = state.filesPath ? `${state.filesPath}/${name}` : name;
        try {
          await api(`/servers/${encodeURIComponent(server.id)}/files`, {
            json: { op: "mkdir", path: rel },
          });
          loadFiles();
        } catch (err) {
          toast(err.message, "err");
        }
      };
    }
    if ($("#f-upload")) {
      $("#f-upload").onclick = () => $("#f-input").click();
      $("#f-input").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const rel = state.filesPath ? `${state.filesPath}/${file.name}` : file.name;
        try {
          const res = await fetch(
            `/api/servers/${encodeURIComponent(server.id)}/upload?path=${encodeURIComponent(rel)}`,
            {
              method: "POST",
              headers: { Authorization: "Bearer " + state.token },
              body: file,
            },
          );
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "upload failed");
          toast(`uploaded ${fmtBytes(data.bytes || file.size)}`);
          loadFiles();
        } catch (err) {
          toast(err.message, "err");
        }
        e.target.value = "";
      };
    }

    loadFiles();
  }

  // backups
  async function tabBackups(body, server) {
    body.innerHTML = `
      <div class="spread" style="margin-bottom:10px">
        <span class="muted" style="font-size:11px">plugin-defined snapshots (minecraft worlds today)</span>
        ${can("control") ? `<button class="btn primary" id="bk-create">backup now</button>` : ""}
      </div>
      <div id="bk-list"><p class="empty">loading…</p></div>`;

    const load = async () => {
      try {
        const data = await api(`/servers/${encodeURIComponent(server.id)}/backups`);
        const rows = data.backups || [];
        $("#bk-list").innerHTML = rows.length
          ? `<table class="responsive"><thead><tr><th>name</th><th class="hide-m">size</th><th class="hide-m">created</th><th></th></tr></thead><tbody>
              ${rows
                .map(
                  (b) => `<tr>
                    <td class="nowrap">${esc(b.name)}</td>
                    <td class="hide-m dim">${fmtBytes(b.size)}</td>
                    <td class="hide-m dim">${fmtTime(b.created)}</td>
                    <td class="actions">
                      ${can("control") ? `<button class="btn" data-restore="${esc(b.name)}">restore</button>
                      <button class="btn danger" data-del="${esc(b.name)}">delete</button>` : ""}
                    </td>
                  </tr>`,
                )
                .join("")}
            </tbody></table>`
          : `<p class="empty">no backups yet.</p>`;

        $$("[data-restore]", body).forEach((btn) => {
          btn.onclick = async () => {
            if (!confirm(`restore ${btn.dataset.restore}? the current world will be replaced.`)) return;
            btn.disabled = true;
            try {
              await api(
                `/servers/${encodeURIComponent(server.id)}/backups/${encodeURIComponent(btn.dataset.restore)}/restore`,
                { method: "POST" },
              );
              toast("restore accepted — stop the server first if it isn't already", "warn");
            } catch (err) {
              toast(err.message, "err");
            } finally {
              btn.disabled = false;
            }
          };
        });
        $$("[data-del]", body).forEach((btn) => {
          btn.onclick = async () => {
            if (!confirm(`delete backup ${btn.dataset.del}?`)) return;
            try {
              await api(
                `/servers/${encodeURIComponent(server.id)}/backups/${encodeURIComponent(btn.dataset.del)}`,
                { method: "DELETE" },
              );
              toast("deleted");
              load();
            } catch (err) {
              toast(err.message, "err");
            }
          };
        });
      } catch (err) {
        $("#bk-list").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      }
    };

    if ($("#bk-create")) {
      $("#bk-create").onclick = async () => {
        try {
          await api(`/servers/${encodeURIComponent(server.id)}/backup`, { method: "POST" });
          toast("backup accepted — this can take a moment", "warn");
          setTimeout(load, 2500);
        } catch (err) {
          toast(err.message, "err");
        }
      };
    }
    load();
  }

  // tasks
  async function tabTasks(body, server) {
    body.innerHTML = `<div id="tk-list"><p class="empty">loading…</p></div>`;
    try {
      const data = await api(`/servers/${encodeURIComponent(server.id)}/tasks`);
      const tasks = data.tasks || [];
      $("#tk-list").innerHTML = tasks.length
        ? `<table class="responsive"><thead><tr><th>task</th><th class="hide-m">action</th><th class="hide-m">when</th><th></th></tr></thead><tbody>
            ${tasks
              .map(
                (t) => `<tr>
                  <td>${esc(t.name || t.id)}</td>
                  <td class="hide-m dim">${esc(t.action || "")}</td>
                  <td class="hide-m dim">${esc(t.dailyAt ? "daily " + t.dailyAt : t.intervalSecs ? "every " + Math.round(t.intervalSecs / 60) + "m" : "—")}</td>
                  <td class="actions">${can("control") ? `<button class="btn" data-run="${esc(t.id)}">run now</button>` : ""}</td>
                </tr>`,
              )
              .join("")}
          </tbody></table>`
        : `<p class="empty">no scheduled tasks for this instance.</p>`;
      $$("[data-run]", body).forEach((btn) => {
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            await api(
              `/servers/${encodeURIComponent(server.id)}/tasks/${encodeURIComponent(btn.dataset.run)}/run`,
              { method: "POST" },
            );
            toast("task started");
          } catch (err) {
            toast(err.message, "err");
          } finally {
            btn.disabled = false;
          }
        };
      });
    } catch (err) {
      $("#tk-list").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    }
  }

  // ── audit ─────────────────────────────────────────────────────────────
  async function renderAudit() {
    const main = $("#main");
    try {
      const data = await api("/audit?limit=200");
      const entries = (data.entries || []).slice().reverse();
      main.innerHTML = `
        <h1 class="h1">audit</h1>
        <p class="sub">every lifecycle action, config change, and remote request.</p>
        ${
          entries.length
            ? `<table class="responsive"><thead><tr><th>when</th><th>action</th><th>detail</th><th class="hide-m">server</th></tr></thead><tbody>
                ${entries
                  .map(
                    (e) => `<tr>
                      <td class="dim nowrap">${fmtAgo(e.at)}</td>
                      <td class="nowrap">${esc(e.action)}</td>
                      <td>${esc(e.detail)}</td>
                      <td class="hide-m dim">${esc(e.server_id || "")}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody></table>`
            : `<p class="empty">nothing recorded yet.</p>`
        }`;
    } catch (err) {
      main.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    }
  }

  // ── settings ──────────────────────────────────────────────────────────
  async function renderSettings() {
    const main = $("#main");
    let remote = null;
    try {
      remote = await api("/remote/status");
    } catch {}

    const user = state.user || {};
    main.innerHTML = `
      <h1 class="h1">settings</h1>
      <p class="sub">this device and the remote service.</p>

      <div class="cards">
        <div class="card">
          <div class="spread" style="margin-bottom:10px"><b>this device</b><span class="chip">${esc(user.role || "")}</span></div>
          <p class="muted" style="font-size:12px">signed in as <b class="green">${esc(user.name || "?")}</b>${
            user.servers && user.servers.length ? ` · scoped to ${user.servers.map(esc).join(", ")}` : " · all servers"
          }</p>
          <div class="row" style="margin-top:12px;gap:6px">
            <button class="btn" id="signout">sign out</button>
          </div>
        </div>

        <div class="card">
          <div class="spread" style="margin-bottom:10px">
            <b>public access</b>
            <span class="chip ${remote && remote.tunnel && remote.tunnel.url ? "good" : ""}">${
              remote && remote.tunnel && remote.tunnel.url ? "tunnel up" : "local only"
            }</span>
          </div>
          ${
            remote && remote.tunnel && remote.tunnel.url
              ? `<p class="invite-link">${esc(remote.tunnel.url)}</p>`
              : `<p class="muted" style="font-size:12px">${
                  remote && remote.tunnel && remote.tunnel.enabled
                    ? esc(remote.tunnel.error || "tunnel starting…")
                    : "reachable on your lan only."
                }</p>`
          }
          ${
            can("admin")
              ? `<button class="btn ${remote && remote.tunnel && remote.tunnel.enabled ? "danger" : ""}" id="tunnel-toggle" style="margin-top:12px">
                   ${remote && remote.tunnel && remote.tunnel.enabled ? "disable tunnel" : "expose via cloudflare tunnel"}
                 </button>`
              : ""
          }
        </div>
      </div>

      <div id="people-slot" style="margin-top:22px"></div>`;

    $("#signout").onclick = () => {
      if (confirm("sign out this device?")) signOut("signed out on this device.");
    };

    const toggle = $("#tunnel-toggle");
    if (toggle) {
      toggle.onclick = async () => {
        const enable = !(remote && remote.tunnel && remote.tunnel.enabled);
        toggle.disabled = true;
        try {
          await api("/remote/tunnel", { json: { enabled: enable } });
          toast(enable ? "tunnel starting…" : "tunnel disabled");
          setTimeout(renderSettings, 1500);
        } catch (err) {
          toast(err.message, "err");
          toggle.disabled = false;
        }
      };
    }

    if (can("admin")) renderPeople($("#people-slot"));
  }

  async function renderPeople(slot) {
    slot.innerHTML = `<p class="empty">loading people…</p>`;
    let people;
    try {
      people = await api("/remote/people");
    } catch (err) {
      slot.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
      return;
    }

    const inviteLink = (code) => `${location.origin}/#invite=${code}`;

    slot.innerHTML = `
      <h2 class="h1" style="font-size:13px">people</h2>
      <p class="sub">invite a person, pick their role, and scope them to specific servers.</p>

      <div class="card" style="margin-bottom:14px">
        <b>new invite</b>
        <div class="row wrap" style="gap:8px;margin-top:10px;align-items:flex-end">
          <div style="flex:2;min-width:140px"><label class="field">name</label><input id="inv-name" placeholder="alex"></div>
          <div style="flex:1;min-width:110px"><label class="field">role</label>
            <select id="inv-role">
              <option value="viewer">viewer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div style="flex:2;min-width:160px"><label class="field">servers (blank = all)</label><input id="inv-servers" placeholder="minecraft_java, discord_bot"></div>
          <button class="btn primary" id="inv-create">create</button>
        </div>
        <div id="inv-result" style="margin-top:12px"></div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <b>users</b>
        <table class="responsive" style="margin-top:8px"><thead><tr><th>name</th><th>role</th><th class="hide-m">servers</th><th class="hide-m">devices</th><th></th></tr></thead><tbody>
          ${
            people.users.length
              ? people.users
                  .map(
                    (u) => `<tr>
                      <td>${esc(u.name)}</td>
                      <td>${esc(u.role)}</td>
                      <td class="hide-m dim">${u.servers && u.servers.length ? u.servers.map(esc).join(", ") : "all"}</td>
                      <td class="hide-m dim">${u.deviceCount}</td>
                      <td class="actions"><button class="btn danger" data-rm-user="${esc(u.id)}">remove</button></td>
                    </tr>`,
                  )
                  .join("")
              : `<tr><td colspan="5" class="empty">nobody paired yet.</td></tr>`
          }
        </tbody></table>
      </div>

      <div class="card" style="margin-bottom:14px">
        <b>devices</b>
        <table class="responsive" style="margin-top:8px"><thead><tr><th>device</th><th>user</th><th class="hide-m">last seen</th><th></th></tr></thead><tbody>
          ${
            people.devices.length
              ? people.devices
                  .map(
                    (d) => `<tr>
                      <td>${esc(d.label || d.id)}</td>
                      <td class="dim">${esc(d.userName)}</td>
                      <td class="hide-m dim">${fmtAgo(d.lastSeenAt)}</td>
                      <td class="actions"><button class="btn danger" data-rm-device="${esc(d.id)}">revoke</button></td>
                    </tr>`,
                  )
                  .join("")
              : `<tr><td colspan="4" class="empty">no devices.</td></tr>`
          }
        </tbody></table>
      </div>

      <div class="card">
        <b>open invites</b>
        <table class="responsive" style="margin-top:8px"><thead><tr><th>for</th><th>role</th><th class="hide-m">expires</th><th></th></tr></thead><tbody>
          ${
            people.invites.filter((i) => !i.usedAt && !i.expired).length
              ? people.invites
                  .filter((i) => !i.usedAt && !i.expired)
                  .map(
                    (i) => `<tr>
                      <td>${esc(i.name)}<div class="invite-link">${esc(inviteLink(i.code))}</div></td>
                      <td>${esc(i.role)}</td>
                      <td class="hide-m dim">${fmtAgo(i.expiresAt)}</td>
                      <td class="actions"><button class="btn danger" data-rm-invite="${esc(i.code)}">revoke</button></td>
                    </tr>`,
                  )
                  .join("")
              : `<tr><td colspan="4" class="empty">no open invites.</td></tr>`
          }
        </tbody></table>
      </div>`;

    $("#inv-create").onclick = async () => {
      const name = $("#inv-name").value.trim() || "guest";
      const role = $("#inv-role").value;
      const servers = $("#inv-servers")
        .value.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        const invite = await api("/remote/invites", {
          json: { name, role, servers: servers.length ? servers : null },
        });
        const link = inviteLink(invite.code);
        $("#inv-result").innerHTML = `
          <p class="muted">invite for <b class="green">${esc(invite.name)}</b> (${esc(invite.role)}) — ${scrubExpiry(invite.expiresAt)}</p>
          <p class="invite-code">${esc(invite.code)}</p>
          <p class="invite-link">${esc(link)}</p>
          <button class="btn" id="inv-copy">copy link</button>`;
        $("#inv-copy").onclick = async () => {
          try {
            await navigator.clipboard.writeText(link);
            toast("link copied");
          } catch {
            toast("clipboard unavailable", "warn");
          }
        };
        renderSettings();
      } catch (err) {
        toast(err.message, "err");
      }
    };

    $$("[data-rm-user]", slot).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("remove this user and every device they paired?")) return;
        try {
          await api("/remote/users/remove", { json: { id: btn.dataset.rmUser } });
          toast("user removed");
          renderPeople(slot);
        } catch (err) {
          toast(err.message, "err");
        }
      };
    });
    $$("[data-rm-device]", slot).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("revoke this device?")) return;
        try {
          await api("/remote/devices/revoke", { json: { id: btn.dataset.rmDevice } });
          toast("device revoked");
          renderPeople(slot);
        } catch (err) {
          toast(err.message, "err");
        }
      };
    });
    $$("[data-rm-invite]", slot).forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api("/remote/invites/revoke", { json: { code: btn.dataset.rmInvite } });
          toast("invite revoked");
          renderPeople(slot);
        } catch (err) {
          toast(err.message, "err");
        }
      };
    });
  }

  function scrubExpiry(expiresAt) {
    const mins = Math.max(0, Math.round((expiresAt - Date.now() / 1000) / 60));
    return mins > 60 ? `expires in ${Math.round(mins / 60)}h` : `expires in ${mins}m`;
  }

  // ── boot ──────────────────────────────────────────────────────────────
  window.addEventListener("online", () => setConn("live", "live"));
  window.addEventListener("offline", () => setConn("offline", "offline"));
  boot().catch(() => {
    gate(`<h2>connection failed</h2><p class="muted">couldn't reach kern. is the web remote still enabled?</p>`);
  });
})();
