import { ext } from "../common/browser.js";
import { FALLBACK_VOICES, getSettings, setSettings } from "../common/settings.js";

const el = {
  status: document.getElementById("status"),
  pageTitle: document.getElementById("page-title"),
  progressBar: document.getElementById("progress-bar"),
  chunkLabel: document.getElementById("chunk-label"),
  toggle: document.getElementById("toggle"),
  toggleLabel: document.getElementById("toggle-label"),
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
let current = { status: "idle" };

const LABELS = {
  idle: { status: "Ready", action: "Read" },
  loading: { status: "Loading", action: "Loading…" },
  playing: { status: "Playing", action: "Pause" },
  paused: { status: "Paused", action: "Resume" },
  error: { status: "Error", action: "Try again" },
};

function render(state) {
  current = state ?? { status: "idle" };
  const label = LABELS[current.status] ?? LABELS.idle;

  el.status.textContent = label.status;
  el.status.dataset.state = current.status;
  el.toggleLabel.textContent =
    current.status === "idle" || current.status === "error"
      ? `${label.action} ${scope === "selection" ? "selection" : "page"}`
      : label.action;

  el.toggle.disabled = current.status === "loading";
  el.stop.disabled = current.status === "idle" || current.status === "error";
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
  const text = problem || missingKey;
  el.message.textContent = text;
  el.message.hidden = !text;
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

async function loadVoices(selected) {
  let voices = FALLBACK_VOICES;
  const { cachedVoices } = await ext.storage.local.get("cachedVoices");
  if (Array.isArray(cachedVoices) && cachedVoices.length) voices = cachedVoices;
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
el.stop.addEventListener("click", () => control("stop"));

for (const button of el.scopeButtons) {
  button.addEventListener("click", () => setScope(button.dataset.scope));
}

el.rate.addEventListener("input", () => setRateUi(el.rate.value));
el.rate.addEventListener("change", async () => {
  const rate = Number(el.rate.value);
  await setSettings({ rate });
  await control("setRate", { rate });
});

for (const chip of el.presets) {
  chip.addEventListener("click", async () => {
    const rate = Number(chip.dataset.rate);
    setRateUi(rate);
    await setSettings({ rate });
    await control("setRate", { rate });
  });
}

el.voice.addEventListener("change", async () => {
  await setSettings({ voiceId: el.voice.value });
  await ext.runtime.sendMessage({ type: "control", action: "settingsChanged" }).catch(() => {});
});

el.openOptions.addEventListener("click", () => {
  ext.runtime.openOptionsPage();
  window.close();
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "tabStateChanged") render(message.state);
});

(async function init() {
  const settings = await getSettings();
  setRateUi(settings.rate);
  await loadVoices(settings.voiceId);
  try {
    const response = await ext.runtime.sendMessage({ type: "getTabState" });
    if (response?.ok) {
      render(response.state);
      if (response.state?.scope) setScope(response.state.scope);
      return;
    }
    render({ status: "error", error: response?.error, hasApiKey: Boolean(settings.apiKey) });
  } catch (error) {
    render({ status: "error", error: error.message });
  }
})();
