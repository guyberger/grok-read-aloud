import { ext } from "../common/browser.js";
import { DEFAULT_SETTINGS, FALLBACK_VOICES, LANGUAGES, getSettings, setSettings } from "../common/settings.js";

const PREVIEW_TEXT =
  "This is how I sound. I will read the page aloud and highlight each word as I say it.";

const el = {
  apiKey: document.getElementById("api-key"),
  reveal: document.getElementById("reveal"),
  saveKey: document.getElementById("save-key"),
  testKey: document.getElementById("test-key"),
  clearKey: document.getElementById("clear-key"),
  keyStatus: document.getElementById("key-status"),
  voice: document.getElementById("voice"),
  language: document.getElementById("language"),
  preview: document.getElementById("preview"),
  previewStatus: document.getElementById("preview-status"),
  rate: document.getElementById("rate"),
  rateValue: document.getElementById("rate-value"),
  chunkChars: document.getElementById("chunk-chars"),
  chunkValue: document.getElementById("chunk-value"),
  autoScroll: document.getElementById("auto-scroll"),
  sentenceTint: document.getElementById("sentence-tint"),
  highlightColor: document.getElementById("highlight-color"),
  permissionCard: document.getElementById("permission-card"),
  grant: document.getElementById("grant"),
  saved: document.getElementById("saved"),
};

let savedTimer = 0;
let previewAudio = null;

function setStatus(node, text, tone) {
  node.textContent = text;
  node.hidden = !text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

function flashSaved() {
  el.saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.saved.hidden = true;
  }, 1400);
}

async function persist(patch) {
  await setSettings(patch);
  flashSaved();
}

function fillVoices(voices, selected) {
  const list = voices.some((voice) => voice.voice_id === selected)
    ? voices
    : [{ voice_id: selected, name: selected }, ...voices];
  el.voice.replaceChildren(
    ...list.map((voice) => {
      const option = document.createElement("option");
      option.value = voice.voice_id;
      option.textContent = voice.name || voice.voice_id;
      option.selected = voice.voice_id === selected;
      return option;
    }),
  );
}

function fillLanguages(selected) {
  el.language.replaceChildren(
    ...LANGUAGES.map((language) => {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      option.selected = language.code === selected;
      return option;
    }),
  );
}

async function refreshVoiceList({ announce }) {
  if (announce) setStatus(el.keyStatus, "Checking key…");
  try {
    const response = await ext.runtime.sendMessage({ type: "listVoices" });
    if (!response?.ok) throw new Error(response?.error || "Could not reach the API.");
    if (response.voices.length) {
      await ext.storage.local.set({ cachedVoices: response.voices });
      fillVoices(response.voices, el.voice.value);
    }
    if (announce) {
      setStatus(el.keyStatus, `Key works — ${response.voices.length} voices available.`, "ok");
    }
  } catch (error) {
    if (announce) setStatus(el.keyStatus, error.message, "error");
  }
}

async function checkHostPermission() {
  try {
    const granted = await ext.permissions.contains({ origins: ["https://api.x.ai/*"] });
    el.permissionCard.hidden = granted;
  } catch {
    el.permissionCard.hidden = true;
  }
}

el.reveal.addEventListener("click", () => {
  const hidden = el.apiKey.type === "password";
  el.apiKey.type = hidden ? "text" : "password";
  el.reveal.textContent = hidden ? "Hide" : "Show";
});

el.saveKey.addEventListener("click", async () => {
  const apiKey = el.apiKey.value.trim();
  await setSettings({ apiKey });
  setStatus(el.keyStatus, apiKey ? "Key saved." : "Key cleared.", apiKey ? "ok" : undefined);
  flashSaved();
  if (apiKey) await refreshVoiceList({ announce: false });
});

el.testKey.addEventListener("click", async () => {
  const apiKey = el.apiKey.value.trim();
  if (apiKey) await setSettings({ apiKey });
  await refreshVoiceList({ announce: true });
});

el.clearKey.addEventListener("click", async () => {
  el.apiKey.value = "";
  await setSettings({ apiKey: "" });
  await ext.storage.local.remove("cachedVoices");
  setStatus(el.keyStatus, "Key removed from this browser.");
  flashSaved();
});

el.voice.addEventListener("change", () => persist({ voiceId: el.voice.value }));
el.language.addEventListener("change", () => persist({ language: el.language.value }));

el.rate.addEventListener("input", () => {
  el.rateValue.textContent = `${Number(el.rate.value).toFixed(1)}×`;
});
el.rate.addEventListener("change", () => persist({ rate: Number(el.rate.value) }));

el.chunkChars.addEventListener("input", () => {
  el.chunkValue.textContent = el.chunkChars.value;
});
el.chunkChars.addEventListener("change", () => persist({ chunkChars: Number(el.chunkChars.value) }));

el.autoScroll.addEventListener("change", () => persist({ autoScroll: el.autoScroll.checked }));
el.sentenceTint.addEventListener("change", () => persist({ sentenceTint: el.sentenceTint.checked }));
el.highlightColor.addEventListener("change", () => persist({ highlightColor: el.highlightColor.value }));

el.grant.addEventListener("click", async () => {
  try {
    await ext.permissions.request({ origins: ["https://api.x.ai/*"] });
  } catch {
    // The user dismissed the prompt.
  }
  await checkHostPermission();
});

el.preview.addEventListener("click", async () => {
  el.preview.disabled = true;
  setStatus(el.previewStatus, "Synthesising…");
  try {
    const response = await ext.runtime.sendMessage({
      type: "synthesize",
      text: PREVIEW_TEXT,
      voiceId: el.voice.value,
      language: el.language.value,
    });
    if (!response?.ok) throw new Error(response?.error || "Preview failed.");
    previewAudio?.pause();
    previewAudio = new Audio(`data:${response.contentType};base64,${response.audio}`);
    previewAudio.playbackRate = Number(el.rate.value) || 1;
    await previewAudio.play();
    setStatus(el.previewStatus, `${response.duration.toFixed(1)}s of audio`, "ok");
  } catch (error) {
    setStatus(el.previewStatus, error.message, "error");
  } finally {
    el.preview.disabled = false;
  }
});

(async function init() {
  const settings = await getSettings();
  el.apiKey.value = settings.apiKey;
  fillLanguages(settings.language);
  el.rate.value = String(settings.rate);
  el.rateValue.textContent = `${Number(settings.rate).toFixed(1)}×`;
  el.chunkChars.value = String(settings.chunkChars);
  el.chunkValue.textContent = String(settings.chunkChars);
  el.autoScroll.checked = settings.autoScroll;
  el.sentenceTint.checked = settings.sentenceTint;
  el.highlightColor.value = settings.highlightColor || DEFAULT_SETTINGS.highlightColor;

  const { cachedVoices } = await ext.storage.local.get("cachedVoices");
  fillVoices(Array.isArray(cachedVoices) && cachedVoices.length ? cachedVoices : FALLBACK_VOICES, settings.voiceId);

  await checkHostPermission();
  if (settings.apiKey) await refreshVoiceList({ announce: false });
  else setStatus(el.keyStatus, "Paste your xAI API key to get started.");
})();
