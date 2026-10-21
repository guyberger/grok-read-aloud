/**
 * The popup paints before it knows anything.
 *
 * Everything this panel needs — stored settings, the cached voice list, the
 * reader's state — costs at least one round trip, and reaching the reader can
 * cost much more: the background worker may have to start, then inject the
 * content scripts, then wait for a page whose main thread is busy. None of
 * that may stand between the user clicking the toolbar icon and seeing a
 * panel, so `popup.html` ships a complete default state that needs no script
 * at all, nothing here is awaited before that state is on screen, and the
 * settings module is pulled in dynamically rather than widening the module
 * graph the browser must finish before the document loads.
 *
 * `tools/popup-paint.js` measures what this is worth.
 */
const ext = globalThis.browser ?? globalThis.chrome;

/**
 * The settings module, fetched on first use rather than imported at the top.
 * A static import would put it, and everything it imports, in the graph the
 * browser has to finish before the document loads — which is the moment the
 * popup window is put on screen.
 */
let settingsModule = null;
const settingsApi = () => (settingsModule ??= import("../common/settings.js"));

const el = {
  status: document.getElementById("status"),
  pageTitle: document.getElementById("page-title"),
  progressBar: document.getElementById("progress-bar"),
  chunkLabel: document.getElementById("chunk-label"),
  toggle: document.getElementById("toggle"),
  toggleLabel: document.getElementById("toggle-label"),
  previous: document.getElementById("previous"),
  next: document.getElementById("next"),
  stop: document.getElementById("stop"),
  rate: document.getElementById("rate"),
  rateValue: document.getElementById("rate-value"),
  voice: document.getElementById("voice"),
  message: document.getElementById("message"),
  openOptions: document.getElementById("open-options"),
  scopeButtons: [...document.querySelectorAll("[data-scope]")],
  presets: [...document.querySelectorAll("[data-rate]")],
};

let scope = "page";
// Matches what the markup already shows, so the first render is a no-op
// rather than a flash of different text.
let current = { status: "pending" };

const LABELS = {
  pending: { status: "Checking…", action: "Read" },
  idle: { status: "Ready", action: "Read" },
  loading: { status: "Loading", action: "Loading…" },
  playing: { status: "Playing", action: "Pause" },
  paused: { status: "Paused", action: "Resume" },
  error: { status: "Error", action: "Try again" },
};

/** Statuses with something to stop, step through or resume. */
const ACTIVE = new Set(["loading", "playing", "paused"]);

function render(state) {
  current = state ?? { status: "idle" };
  const label = LABELS[current.status] ?? LABELS.idle;

  el.status.textContent = label.status;
  el.status.dataset.state = current.status;
  el.toggleLabel.textContent =
    current.status === "idle" || current.status === "error" || current.status === "pending"
      ? `${label.action} ${scope === "selection" ? "selection" : "page"}`
      : label.action;

  const active = ACTIVE.has(current.status);
  el.toggle.disabled = current.status === "loading";
  el.previous.disabled = !active;
  el.next.disabled = !active;
  el.stop.disabled = !active;
  el.pageTitle.textContent = current.title ?? "";
  el.progressBar.style.width = `${Math.round((current.progress ?? 0) * 100)}%`;

  if (current.chunkCount) {
    const scopeWord = current.scope === "selection" ? "selection" : "page";
    el.chunkLabel.textContent = `Part ${(current.chunkIndex ?? 0) + 1} of ${current.chunkCount} · ${scopeWord}`;
  } else {
    el.chunkLabel.textContent = "No audio loaded";
  }

  const problem = current.status === "error" ? current.error : "";
  const missingKey = current.hasApiKey === false ? "Add your xAI API key in Settings to start." : "";
  const text = problem || current.notice || missingKey;
  el.message.textContent = text;
  el.message.hidden = !text;
  el.message.classList.toggle("message--notice", !problem && Boolean(current.notice));
}

function setScope(next) {
  scope = next;
  for (const button of el.scopeButtons) {
    const active = button.dataset.scope === next;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  }
  render(current);
}

function setRateUi(rate) {
  el.rate.value = String(rate);
  el.rateValue.textContent = `${Number(rate).toFixed(2).replace(/0$/, "").replace(/\.$/, ".0")}×`;
  for (const chip of el.presets) {
    chip.classList.toggle("is-active", Number(chip.dataset.rate) === Number(rate));
  }
}

async function control(action, args = {}) {
  try {
    const response = await ext.runtime.sendMessage({ type: "control", action, args });
    if (!response?.ok) throw new Error(response?.error || "Something went wrong.");
    render(response.state);
  } catch (error) {
    render({ status: "error", error: error.message, chunkCount: current.chunkCount ?? 0 });
  }
}

async function saveSettings(patch) {
  const { setSettings } = await settingsApi();
  await setSettings(patch);
}

async function loadVoices(selected) {
  const [{ FALLBACK_VOICES }, { cachedVoices }] = await Promise.all([
    settingsApi(),
    ext.storage.local.get("cachedVoices"),
  ]);

  let voices = Array.isArray(cachedVoices) && cachedVoices.length ? cachedVoices : FALLBACK_VOICES;
  if (!voices.some((voice) => voice.voice_id === selected)) {
    voices = [{ voice_id: selected, name: selected }, ...voices];
  }
  el.voice.replaceChildren(
    ...voices.map((voice) => {
      const option = document.createElement("option");
      option.value = voice.voice_id;
      option.textContent = voice.name || voice.voice_id;
      option.selected = voice.voice_id === selected;
      return option;
    }),
  );
}

el.toggle.addEventListener("click", () => control("toggle", { scope }));
el.previous.addEventListener("click", () => control("skipSentence", { delta: -1 }));
el.next.addEventListener("click", () => control("skipSentence", { delta: 1 }));
el.stop.addEventListener("click", () => control("stop"));

for (const button of el.scopeButtons) {
  button.addEventListener("click", () => setScope(button.dataset.scope));
}

el.rate.addEventListener("input", () => setRateUi(el.rate.value));
el.rate.addEventListener("change", async () => {
  const rate = Number(el.rate.value);
  await saveSettings({ rate });
  await control("setRate", { rate });
});

for (const chip of el.presets) {
  chip.addEventListener("click", async () => {
    const rate = Number(chip.dataset.rate);
    setRateUi(rate);
    await saveSettings({ rate });
    await control("setRate", { rate });
  });
}

el.voice.addEventListener("change", async () => {
  if (!el.voice.value) return;
  await saveSettings({ voiceId: el.voice.value });
  await ext.runtime.sendMessage({ type: "control", action: "settingsChanged" }).catch(() => {});
});

el.openOptions.addEventListener("click", () => {
  ext.runtime.openOptionsPage();
  window.close();
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "tabStateChanged") render(message.state);
});

/**
 * Reader state and stored settings are fetched side by side, and each is
 * rendered as it lands rather than waiting for the other. The reader is the
 * slow half, since reaching it can mean starting the worker and injecting the
 * content scripts.
 *
 * Nothing here is awaited before the panel exists: the document is already
 * parsed and painted from its own markup, and every call below only replaces
 * text in place when it answers.
 */
function load() {
  // Pure message passing, so starting it now costs the renderer nothing, and
  // it is much the slowest answer to come back.
  const reader = ext.runtime
    .sendMessage({ type: "getTabState" })
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Something went wrong.");
      render(response.state);
      if (response.state?.scope) setScope(response.state.scope);
      return response.state;
    })
    .catch((error) => {
      render({ status: "error", error: error.message });
      return null;
    });

  // Fetching and compiling the settings module is work for this thread, so it
  // waits until a frame has been handed over. The speed and voice controls
  // show their defaults in the meantime.
  requestAnimationFrame(() =>
    setTimeout(async () => {
      let stored = null;
      try {
        const { getSettings } = await settingsApi();
        stored = await getSettings();
        setRateUi(stored.rate);
        await loadVoices(stored.voiceId);
      } catch {
        // Leave the controls on their defaults.
      }
      // A reader we could not reach says nothing about the key, so say it here.
      if ((await reader) === null && stored) {
        render({ ...current, hasApiKey: Boolean(stored.apiKey) });
      }
    }, 0),
  );
}

// Safe to start straight away: the panel is already on screen from its own
// markup, and nothing above occupies this thread long enough to hold a frame.
load();
