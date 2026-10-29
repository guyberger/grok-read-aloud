import { ext } from "../common/browser.js";
import { withCredential } from "../common/credentials.js";
import { forgetTabState, rememberAuth, rememberTabState } from "../common/panel-cache.js";
import { DEFAULT_SETTINGS, getPublicSettings, getSettings } from "../common/settings.js";
import { API_BASE, listVoices, synthesizeWithRetry } from "../common/tts-client.js";
import * as xaiAuth from "../common/xai-auth.js";

const CONTENT_FILES = [
  "content/util.js",
  "content/extract.js",
  "content/align.js",
  "content/highlight.js",
  "content/pointer.js",
  "content/follow.js",
  "content/positions.js",
  "content/handoff.js",
  "content/pace.js",
  "content/audio-cache.js",
  "content/controls.js",
  "content/player.js",
  "content/reader.js",
];

/**
 * Synthesis in flight, by request. A page that jumps somewhere else no longer
 * wants the audio it asked for, and only the worker holds the fetch, so the
 * controller to cancel it has to live here.
 */
const pendingSynthesis = new Map();

const synthesisKey = (tabId, requestId) => `${tabId ?? "none"}:${requestId}`;

/**
 * Each keyboard command, as the message it sends to the page. `npm run check`
 * fails if a manifest declares a command that is missing from here.
 */
const COMMAND_MESSAGES = {
  "toggle-read": { type: "toggle" },
  "stop-read": { type: "stop" },
  "previous-sentence": { type: "skipSentence", delta: -1 },
  "next-sentence": { type: "skipSentence", delta: 1 },
};

/**
 * Settings, held for as long as the worker lives. Reading them is a trip to
 * extension storage, and the first synthesis of a read waits on it; the
 * listener below drops the copy the moment anything is written.
 */
let cachedSettings = null;

async function settings() {
  cachedSettings ??= await getSettings();
  return cachedSettings;
}

/**
 * Work the extension can do before the user presses read rather than after.
 *
 * Opening the popup is the signal: by the time the panel is on screen the
 * worker is awake, the settings are in memory, and a connection to the API is
 * open — so the first request is a request rather than a handshake. The
 * OPTIONS call carries no key and no text; the API answers preflights from any
 * origin, and all this needs from it is the socket.
 */
function warmUp() {
  settings().catch(() => {});
  fetch(`${API_BASE}/tts`, { method: "OPTIONS" }).catch(() => {});
}

/**
 * Injection is on demand rather than declared for `<all_urls>`: the extension
 * only ever touches a page the user explicitly asked it to read.
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await ext.tabs.sendMessage(tabId, { type: "ping" });
    if (pong?.ok) return true;
  } catch {
    // Not injected yet.
  }
  try {
    // insertCSS rather than an injected <style> so a strict page CSP cannot
    // suppress the highlight rules.
    await ext.scripting.insertCSS({ target: { tabId }, files: ["content/highlight.css"] });
    await ext.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return true;
  } catch (error) {
    throw new Error(
      `Can't read this page. Browser-internal and extension pages are off limits. (${error.message})`,
    );
  }
}

async function activeTabId() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab.id;
}

async function sendToTab(tabId, message) {
  await ensureContentScript(tabId);
  return ext.tabs.sendMessage(tabId, message);
}

async function handleSynthesize(payload, sender) {
  const current = await settings();
  const key = payload.requestId ? synthesisKey(sender?.tab?.id, payload.requestId) : "";
  const controller = key ? new AbortController() : null;
  if (controller) pendingSynthesis.set(key, controller);
  try {
    const { result, notice } = await withCredential(
      (token) =>
        synthesizeWithRetry({
          apiKey: token,
          text: payload.text,
          voiceId: payload.voiceId || current.voiceId,
          language: payload.language || current.language,
          signal: controller?.signal,
        }),
      { settings: current },
    );
    // `notice` says the sign-in was skipped and the key used instead. The
    // reader shows it rather than dropping it: the read worked, but not the
    // way the user asked for.
    return { ok: true, ...result, ...(notice ? { notice } : {}) };
  } finally {
    if (key) pendingSynthesis.delete(key);
  }
}

/**
 * A sign-in, driven from here rather than from the page that asked for it.
 *
 * Approval happens in another tab and takes as long as it takes, so whoever
 * started the flow is usually gone by the time it finishes — a popup closes the
 * moment the verification tab takes focus. The worker owns the polling, writes
 * the prompt to storage so the next UI to open can show it, and announces the
 * result to anything still listening.
 */
let signInFlow = null;

function announce(message) {
  ext.runtime.sendMessage(message).catch(() => {});
}

async function startSignIn({ openTab = true } = {}) {
  // A second click while one is in flight shows the prompt it already has
  // rather than stranding the first device code.
  if (signInFlow) {
    const pending = await xaiAuth.readPendingFlow();
    if (pending) {
      if (openTab) ext.tabs.create({ url: pending.verificationUrlComplete, active: true }).catch(() => {});
      return { ok: true, flow: pending, alreadyRunning: true };
    }
  }

  const controller = new AbortController();
  let prompt = null;
  const ready = new Promise((resolve, reject) => {
    const run = xaiAuth.signIn({
      signal: controller.signal,
      onPrompt: (details) => {
        prompt = { ...details, startedAt: Date.now() };
        resolve(prompt);
      },
    });
    signInFlow = { controller, run };
    run.catch(reject);
  });

  const flow = await ready;
  await xaiAuth.savePendingFlow(flow);
  announce({ type: "xaiAuthChanged", state: "pending", flow });

  if (openTab) {
    ext.tabs.create({ url: flow.verificationUrlComplete, active: true }).catch(() => {});
  }

  signInFlow.run
    .then(async (status) => {
      await xaiAuth.clearPendingFlow();
      announce({ type: "xaiAuthChanged", state: "signedIn", status });
    })
    .catch(async (error) => {
      await xaiAuth.clearPendingFlow();
      announce({ type: "xaiAuthChanged", state: "failed", error: error?.message || String(error) });
    })
    .finally(() => {
      signInFlow = null;
      cachedSettings = null;
    });

  return { ok: true, flow };
}

async function cancelSignIn() {
  signInFlow?.controller.abort();
  signInFlow = null;
  await xaiAuth.clearPendingFlow();
  announce({ type: "xaiAuthChanged", state: "cancelled" });
  return { ok: true };
}

/**
 * Polling runs in the worker, and Chrome stops an idle worker. Each poll is a
 * `fetch`, which keeps it awake for as long as the flow lasts — but a browser
 * restart in the middle leaves a prompt in storage that nothing is waiting on.
 * So a stored flow with no poll behind it is cleared rather than shown.
 */
async function authState() {
  const [status, stored] = await Promise.all([xaiAuth.getStatus(), xaiAuth.readPendingFlow()]);
  const abandoned = Boolean(stored) && !signInFlow;
  if (abandoned) await xaiAuth.clearPendingFlow();
  const answer = abandoned
    ? { ok: true, status, flow: null, pending: false, abandoned: true }
    : { ok: true, status, flow: stored, pending: Boolean(stored) };
  // Which credential is in play is the panel's slowest answer on a worker that
  // has to boot for it, and it is the same answer in every tab.
  const { apiKey } = await getSettings();
  rememberAuth({
    signedIn: Boolean(status.signedIn),
    tierDenied: Boolean(status.tierDenied),
    hasApiKey: Boolean(apiKey),
    pending: answer.pending,
  });
  return answer;
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "synthesize":
      return handleSynthesize(message, sender);

    case "abortSynthesis": {
      const key = synthesisKey(sender?.tab?.id, message.requestId);
      pendingSynthesis.get(key)?.abort();
      pendingSynthesis.delete(key);
      return { ok: true };
    }

    // The API key stays in the worker; page contexts only get the rest.
    case "getPublicSettings":
      return { ok: true, settings: await getPublicSettings() };

    case "listVoices": {
      const { result, source, notice } = await withCredential((token) => listVoices(token), {
        settings: await settings(),
      });
      return { ok: true, voices: result, source, notice };
    }

    case "xaiAuthState":
      return authState();

    case "xaiSignIn":
      return startSignIn({ openTab: message.openTab !== false });

    case "xaiCancelSignIn":
      return cancelSignIn();

    case "xaiSignOut": {
      await cancelSignIn();
      await xaiAuth.signOut();
      cachedSettings = null;
      announce({ type: "xaiAuthChanged", state: "signedOut" });
      // Re-read rather than patch the remembered row: `authState` is the one
      // place that decides what the credential row says.
      await authState();
      return { ok: true, status: await xaiAuth.getStatus() };
    }

    // Only the popup asks, and only as it opens — which is as good a warning
    // as the extension gets that a read is about to start.
    case "getTabState": {
      warmUp();
      const tabId = message.tabId ?? (await activeTabId());
      const state = await sendToTab(tabId, { type: "getState" });
      rememberTabState(tabId, state);
      return { ok: true, tabId, state };
    }

    case "control": {
      const tabId = message.tabId ?? (await activeTabId());
      const state = await sendToTab(tabId, { type: message.action, ...message.args });
      rememberTabState(tabId, state);
      return { ok: true, tabId, state };
    }

    // Content scripts broadcast progress so an open popup can follow along.
    case "stateChanged":
      // And so the next popup to open has something to paint before it has
      // asked anyone anything. See `common/panel-cache.js`.
      rememberTabState(sender?.tab?.id, message.state);
      ext.runtime
        .sendMessage({ type: "tabStateChanged", tabId: sender?.tab?.id, state: message.state })
        .catch(() => {});
      return { ok: true };

    default:
      throw new Error(`Unknown message: ${message?.type}`);
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

ext.storage.onChanged.addListener((changes, area) => {
  // Only a settings write matters. A read writes down where it has got to in
  // the same area as it goes, and dropping the warm copy for one of those
  // would put extension storage back in front of the next synthesis.
  if (area !== "local") return;
  if (Object.keys(changes).some((key) => key in DEFAULT_SETTINGS)) cachedSettings = null;
});

/**
 * A tab that has gone, or gone somewhere else, is a tab whose remembered
 * transport is a lie. The reader announces its own reset on `pagehide`, but
 * only when it was in the page to begin with — a tab navigated before any read
 * started has nothing to announce, and a crashed one never gets the chance.
 */
ext.tabs.onRemoved.addListener((tabId) => forgetTabState(tabId));
ext.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === "loading") forgetTabState(tabId);
});

ext.commands.onCommand.addListener(async (command) => {
  const message = COMMAND_MESSAGES[command];
  if (!message) return;
  try {
    await sendToTab(await activeTabId(), message);
  } catch {
    // A shortcut pressed on a page we cannot inject into is a no-op.
  }
});

ext.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const { apiKey } = await getSettings();
  if (!apiKey && !(await xaiAuth.hasUsableSession())) ext.runtime.openOptionsPage();
});

