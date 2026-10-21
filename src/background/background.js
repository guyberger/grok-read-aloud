import { ext } from "../common/browser.js";
import { getPublicSettings, getSettings } from "../common/settings.js";
import { listVoices, synthesizeWithRetry } from "../common/tts-client.js";

const CONTENT_FILES = [
  "content/util.js",
  "content/extract.js",
  "content/align.js",
  "content/highlight.js",
  "content/pointer.js",
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
  const settings = await getSettings();
  const key = payload.requestId ? synthesisKey(sender?.tab?.id, payload.requestId) : "";
  const controller = key ? new AbortController() : null;
  if (controller) pendingSynthesis.set(key, controller);
  try {
    const result = await synthesizeWithRetry({
      apiKey: settings.apiKey,
      text: payload.text,
      voiceId: payload.voiceId || settings.voiceId,
      language: payload.language || settings.language,
      signal: controller?.signal,
    });
    return { ok: true, ...result };
  } finally {
    if (key) pendingSynthesis.delete(key);
  }
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
      const { apiKey } = await getSettings();
      if (!apiKey) throw new Error("No API key set.");
      return { ok: true, voices: await listVoices(apiKey) };
    }

    case "getTabState": {
      const tabId = message.tabId ?? (await activeTabId());
      const state = await sendToTab(tabId, { type: "getState" });
      return { ok: true, tabId, state };
    }

    case "control": {
      const tabId = message.tabId ?? (await activeTabId());
      const state = await sendToTab(tabId, { type: message.action, ...message.args });
      return { ok: true, tabId, state };
    }

    // Content scripts broadcast progress so an open popup can follow along.
    case "stateChanged":
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

ext.commands.onCommand.addListener(async (command) => {
  try {
    const tabId = await activeTabId();
    if (command === "toggle-read") await sendToTab(tabId, { type: "toggle" });
    if (command === "stop-read") await sendToTab(tabId, { type: "stop" });
  } catch {
    // A shortcut pressed on a page we cannot inject into is a no-op.
  }
});

ext.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const { apiKey } = await getSettings();
  if (!apiKey) ext.runtime.openOptionsPage();
});
