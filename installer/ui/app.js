/* UI controller for the kern installer.
 *
 * Talks to the Rust side through Tauri's global API:
 *   installer_info()  -> configuration + defaults
 *   start_install()   -> runs the installation, emitting progress events
 *
 * Progress model: concise step lines in the list, one slim grayed line for the
 * actual current action, and a signal-trail lane under the titlebar that maps
 * 0-100%.
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const currentWindow = window.__TAURI__.window.getCurrentWindow();

const $ = (id) => document.getElementById(id);

let info = null;
let finished = false;
let closeTimer = null;

/* ── Titlebar ───────────────────────────────────────────────────────── */

$("minimize").addEventListener("click", () => void currentWindow.minimize());
const closeWindow = () => {
  if (closeTimer) clearInterval(closeTimer);
  void currentWindow.close();
};
$("close").addEventListener("click", closeWindow);

/* ── Visual state ───────────────────────────────────────────────────── */

function setState(state) {
  document.body.classList.toggle("is-working", state === "working");
  document.body.classList.toggle("is-done", state === "done");
  document.body.classList.toggle("is-error", state === "error");
}

function setStatus(text) {
  $("statusText").textContent = text;
}

function setProgress(percent) {
  $("laneFill").style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function glitch() {
  document.body.classList.add("glitching");
  setTimeout(() => document.body.classList.remove("glitching"), 750);
}

/* ── Step list + current action ─────────────────────────────────────── */

function clearSteps() {
  $("steps").innerHTML = "";
  lastStage = 0;
  setCurrentAction(null);
}

function addStep(label) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="mark">▸</span><span class="label"></span>`;
  li.querySelector(".label").textContent = label;
  li.classList.add("active");
  $("steps").appendChild(li);
  $("steps").scrollTop = $("steps").scrollHeight;
  return li;
}

function finishStep(li, ok = true) {
  if (!li) return;
  li.classList.remove("active");
  li.classList.add(ok ? "done" : "failed");
  li.querySelector(".mark").textContent = ok ? "✓" : "✕";
}

function setCurrentAction(text) {
  const row = $("currentAction");
  if (!text) {
    row.hidden = true;
    $("currentActionText").textContent = "";
    return;
  }
  row.hidden = false;
  // Recreate the text node so the fade-in animation replays per action.
  const old = $("currentActionText");
  const fresh = old.cloneNode(false);
  fresh.textContent = text;
  old.replaceWith(fresh);
}

/* ── Result handling ────────────────────────────────────────────────── */

function showResult(message, isError) {
  finished = true;
  setState(isError ? "error" : "done");
  setStatus(isError ? "failed" : "signal acquired");
  setProgress(isError ? 100 : 100);

  $("progress").hidden = true;
  $("result").hidden = false;
  const el = $("resultText");
  el.textContent = message;
  el.classList.toggle("error", !!isError);

  $("install").hidden = true;
  $("cancel").hidden = true;
  $("close2").hidden = false;

  if (isError) {
    glitch();
  } else if (shouldAutoClose()) {
    startCountdown();
  } else {
    $("close2").focus();
  }
}

/* Auto-close when the app will be launched (or in updater/passive mode). */
function shouldAutoClose() {
  if (info?.demo) return false;
  if (document.body.classList.contains("passive")) return true;
  return $("launchAfter").checked || info?.restart === true;
}

function startCountdown() {
  let seconds = 4;
  const el = $("countdown");
  el.hidden = false;
  const render = () => {
    el.textContent =
      seconds > 0 ? `launching kern in ${seconds}…` : "launching kern…";
  };
  render();
  closeTimer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(closeTimer);
      closeTimer = null;
      closeWindow();
      return;
    }
    render();
  }, 1000);
}

/* ── Install ────────────────────────────────────────────────────────── */

async function runInstall() {
  if (finished) return;
  // Safety: in demo mode the button must never trigger a real install, even if
  // it's clicked before the auto-playing demo disables it.
  if (info?.demo) return runDemo();
  setState("working");
  setStatus("installing");
  setProgress(0);
  clearSteps();

  $("intro").hidden = true;
  $("progress").hidden = false;
  $("install").disabled = true;
  $("cancel").disabled = true;

  try {
    const result = await invoke("start_install", {
      installDir: $("installDir").value.trim() || null,
      desktopShortcut: $("desktopShortcut").checked,
      launchAfter: $("launchAfter").checked,
    });
    showResult(result, false);
  } catch (e) {
    setProgress(100);
    showResult(String(e), true);
  }
}

/* ── Progress handling ──────────────────────────────────────────────── */

let lastStage = 0;

function handleProgress({ stage, total, message, detail, percent, done, error }) {
  if (percent != null) setProgress(percent);
  if (total > 0 && typeof stage === "number") {
    setStatus(`installing · ${stage}/${total}`);
  }
  if (detail) setCurrentAction(detail);

  const li = $("steps").lastElementChild;

  if (done || error) {
    finishStep(li, !error);
    return;
  }

  // Detail-only events must not touch the step list.
  if (typeof stage !== "number" || !message) return;

  if (stage > lastStage) {
    // A new stage begins: the previous step completed successfully.
    if (li && li.classList.contains("active")) finishStep(li, true);
    lastStage = stage;
    addStep(message);
  } else if (li) {
    li.querySelector(".label").textContent = message;
  }
}

/* ── Demo mode (dev aid; never touches the filesystem) ──────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runDemo() {
  setState("working");
  setStatus("installing");
  setProgress(0);
  clearSteps();
  $("intro").hidden = true;
  $("progress").hidden = false;
  $("install").disabled = true;
  $("cancel").disabled = true;

  const stages = [
    { label: "closing running instances", details: ["stopping kern.exe"] },
    { label: "installing files", details: ["extracting kern.exe", "writing 1 file"] },
    {
      label: "creating shortcuts",
      details: [
        "linking %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\kern.lnk",
        "linking C:\\Users\\you\\Desktop\\kern.lnk",
      ],
    },
    { label: "registering uninstaller", details: ["writing uninstall entry"] },
    { label: "launching kern", details: ["starting kern.exe"] },
  ];

  for (let i = 0; i < stages.length; i += 1) {
    handleProgress({
      stage: i + 1,
      total: stages.length,
      message: stages[i].label,
      percent: Math.round((i * 100) / stages.length),
    });
    for (const detail of stages[i].details) {
      handleProgress({ message: "", detail });
      await sleep(650);
    }
  }

  handleProgress({ done: true, message: "done", percent: 100 });
  showResult(
    `kern v${info.version} installed to ${$("installDir").value} (demo mode — nothing was written).`,
    false,
  );
}

/* ── Main ───────────────────────────────────────────────────────────── */

async function main() {
  info = await invoke("installer_info");

  $("version").textContent = `v${info.version}`;
  $("installDir").value = info.defaultDir;
  $("payloadWarning").hidden = info.payloadPresent;

  if (info.passive) {
    document.body.classList.add("passive");
  }

  await listen("installer://progress", (event) => handleProgress(event.payload));

  $("install").addEventListener("click", runInstall);
  $("cancel").addEventListener("click", closeWindow);
  $("close2").addEventListener("click", closeWindow);

  setStatus("ready");

  if (info.demo) {
    runDemo();
  } else if (info.passive) {
    runInstall();
  }
}

main().catch((e) => {
  document.body.innerHTML = `<main><p class="warn">installer failed to start: ${e}</p></main>`;
});
