import { ext } from "../common/browser.js";
import { DEFAULT_SETTINGS, FALLBACK_VOICES, LANGUAGES, getSettings, setSettings } from "../common/settings.js";

const PREVIEW_TEXT =
  "This is how I sound. I will read the page aloud and highlight each word as I say it.";

const el = {
  signIn: document.getElementById("sign-in"),
  signOut: document.getElementById("sign-out"),
  cancelSignIn: document.getElementById("cancel-sign-in"),
  authOpen: document.getElementById("auth-open"),
  authSignedOut: document.getElementById("auth-signed-out"),
  authSignedIn: document.getElementById("auth-signed-in"),
  authPending: document.getElementById("auth-pending"),
  authCode: document.getElementById("auth-code"),
  authUrl: document.getElementById("auth-url"),
  authStatus: document.getElementById("auth-status"),
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
  clickToJump: document.getElementById("click-to-jump"),
  readCodeBlocks: document.getElementById("read-code-blocks"),
  autoScroll: document.getElementById("auto-scroll"),
  sentenceTint: document.getElementById("sentence-tint"),
  highlightColor: document.getElementById("highlight-color"),
  apiPermission: document.getElementById("api-permission"),
  grantApi: document.getElementById("grant-api"),
  grantAll: document.getElementById("grant-all"),
  revokeAll: document.getElementById("revoke-all"),
  allStatus: document.getElementById("all-status"),
  saved: document.getElementById("saved"),
};

const ALL_URLS = { origins: ["<all_urls>"] };
const API_ORIGIN = { origins: ["https://api.x.ai/*"] };

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

async function checkHostPermissions() {
  try {
    el.apiPermission.hidden = await ext.permissions.contains(API_ORIGIN);
  } catch {
    el.apiPermission.hidden = true;
  }
  try {
    const all = await ext.permissions.contains(ALL_URLS);
    setStatus(el.allStatus, all ? "Allowed on all sites." : "Per-tab access only.", all ? "ok" : undefined);
    el.grantAll.hidden = all;
    el.revokeAll.hidden = !all;
  } catch {
    el.grantAll.hidden = true;
    el.revokeAll.hidden = true;
  }
}

/**
 * The sign-in panel, in one of three shapes: signed out, waiting for approval,
 * or signed in. Nothing here ever holds a token — the worker answers with a
 * status that has none in it.
 */
let pendingFlow = null;

function renderAuth({ status, flow, error }) {
  pendingFlow = flow ?? null;
  const waiting = Boolean(pendingFlow);
  const signedIn = Boolean(status?.signedIn);

  el.authPending.hidden = !waiting;
  el.authSignedIn.hidden = waiting || !signedIn;
  el.authSignedOut.hidden = waiting || signedIn;

  if (waiting) {
    el.authCode.textContent = pendingFlow.userCode;
    el.authUrl.href = pendingFlow.verificationUrlComplete || pendingFlow.verificationUrl;
    el.authUrl.textContent = pendingFlow.verificationUrl;
    setStatus(el.authStatus, "Waiting for you to approve the sign-in…");
    return;
  }

  if (error) {
    setStatus(el.authStatus, error, "error");
    return;
  }
  if (!signedIn) {
    setStatus(el.authStatus, "");
    return;
  }
  if (status.tierDenied) {
    setStatus(
      el.authStatus,
      "Signed in, but xAI will not let this account through to the API — it gates OAuth access by " +
        "subscription tier. The API key below is used instead.",
      "error",
    );
    return;
  }
  const minutes = Math.max(1, Math.round(status.expiresInSeconds / 60));
  setStatus(el.authStatus, `Signed in with xAI — token good for another ${minutes} min, then refreshed.`, "ok");
}

async function refreshAuth(extra = {}) {
  try {
    const response = await ext.runtime.sendMessage({ type: "xaiAuthState" });
    if (!response?.ok) throw new Error(response?.error || "Could not read the sign-in state.");
    renderAuth({ status: response.status, flow: response.flow, ...extra });
    return response;
  } catch (error) {
    renderAuth({ status: { signedIn: false }, flow: null, error: error.message });
    return null;
  }
}

el.signIn.addEventListener("click", async () => {
  el.signIn.disabled = true;
  setStatus(el.authStatus, "Asking xAI for a sign-in code…");
  try {
    const response = await ext.runtime.sendMessage({ type: "xaiSignIn" });
    if (!response?.ok) throw new Error(response?.error || "Could not start the sign-in.");
    renderAuth({ status: { signedIn: false }, flow: response.flow });
  } catch (error) {
    renderAuth({ status: { signedIn: false }, flow: null, error: error.message });
  } finally {
    el.signIn.disabled = false;
  }
});

el.authOpen.addEventListener("click", () => {
  if (!pendingFlow) return;
  ext.tabs.create({ url: pendingFlow.verificationUrlComplete || pendingFlow.verificationUrl, active: true });
});

el.cancelSignIn.addEventListener("click", async () => {
  await ext.runtime.sendMessage({ type: "xaiCancelSignIn" }).catch(() => {});
  await refreshAuth();
});

el.signOut.addEventListener("click", async () => {
  el.signOut.disabled = true;
  try {
    await ext.runtime.sendMessage({ type: "xaiSignOut" });
    await refreshAuth();
    setStatus(el.authStatus, "Signed out of xAI.");
    flashSaved();
  } finally {
    el.signOut.disabled = false;
  }
});

// The sign-in finishes in the worker, long after the click that started it.
ext.runtime.onMessage.addListener((message) => {
  if (message?.type !== "xaiAuthChanged") return;
  if (message.state === "failed") refreshAuth({ error: message.error });
  else refreshAuth();
  if (message.state === "signedIn") refreshVoiceList({ announce: false });
});

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

el.clickToJump.addEventListener("change", () => persist({ clickToJump: el.clickToJump.checked }));
el.readCodeBlocks.addEventListener("change", () => persist({ readCodeBlocks: el.readCodeBlocks.checked }));
el.autoScroll.addEventListener("change", () => persist({ autoScroll: el.autoScroll.checked }));
el.sentenceTint.addEventListener("change", () => persist({ sentenceTint: el.sentenceTint.checked }));
el.highlightColor.addEventListener("change", () => persist({ highlightColor: el.highlightColor.value }));

for (const [button, permission, request] of [
  [el.grantApi, API_ORIGIN, true],
  [el.grantAll, ALL_URLS, true],
  [el.revokeAll, ALL_URLS, false],
]) {
  button.addEventListener("click", async () => {
    try {
      if (request) await ext.permissions.request(permission);
      else await ext.permissions.remove(permission);
    } catch {
      // The user dismissed the prompt.
    }
    await checkHostPermissions();
  });
}

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
  el.clickToJump.checked = settings.clickToJump;
  el.readCodeBlocks.checked = settings.readCodeBlocks;
  el.autoScroll.checked = settings.autoScroll;
  el.sentenceTint.checked = settings.sentenceTint;
  el.highlightColor.value = settings.highlightColor || DEFAULT_SETTINGS.highlightColor;

  const { cachedVoices } = await ext.storage.local.get("cachedVoices");
  fillVoices(Array.isArray(cachedVoices) && cachedVoices.length ? cachedVoices : FALLBACK_VOICES, settings.voiceId);

  await checkHostPermissions();
  const auth = await refreshAuth();
  if (settings.apiKey || auth?.status?.signedIn) await refreshVoiceList({ announce: false });
  else setStatus(el.keyStatus, "Sign in with xAI above, or paste an API key here.");
})();
