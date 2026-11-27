/**
 * The last thing the popup was told, kept where the next popup can read it.
 *
 * Everything the panel shows comes from somewhere else: the reader in the page
 * for the transport, the worker for the credentials. Both answers are quick
 * when the worker is awake and the content scripts are already in the page,
 * and neither is quick when they are not — a worker that has to boot, scripts
 * that have to be injected into a document whose main thread is busy. The
 * panel paints long before either lands, so without a cache its first frame
 * can only say "Checking…" and leave the transport dead.
 *
 * So the worker writes down what it last knew, per tab, and the popup reads it
 * on the way up. `storage.session` is the right shelf for it: it is cleared
 * when the browser closes, which is also when every remembered read stops
 * being true. Within a session a read is made untrue by one other thing — the
 * tab navigating — and the worker drops the entry for that too.
 *
 * Nothing here is authoritative. The live answer overwrites whatever was shown
 * the moment it arrives, and the popup marks which of the two is on screen.
 */
import { ext } from "./browser.js";

const TAB_PREFIX = "panel:tab:";
const AUTH_KEY = "panel:auth";

/** How long a remembered state is worth showing. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export const tabKey = (tabId) => `${TAB_PREFIX}${tabId}`;

/**
 * `storage.session` where there is one. Chrome has had it since 102 and
 * Firefox since 115, both below what the manifests ask for, so the fallback is
 * for a packaging mistake rather than for a browser.
 */
function shelf() {
  return ext.storage?.session ?? null;
}

/**
 * The fields of a reader snapshot the panel paints, and nothing else.
 *
 * A snapshot also carries what the panel has no use for from a cache — the
 * engine in play, whether the timestamps aligned — and the audio-shaped parts
 * of it are the parts most likely to have moved on. Keeping the list explicit
 * is also what stops a future field from being cached without a thought about
 * whether it is still true a minute later.
 */
const PAINTED = [
  "status",
  "scope",
  "chunkIndex",
  "chunkCount",
  "progress",
  "remainingSeconds",
  "resume",
  "title",
  "rate",
  "voiceId",
  "hasApiKey",
  "signedIn",
  "hasCredential",
  "notice",
  "error",
];

/**
 * What is worth remembering about a reader.
 *
 * A chunk still being fetched is remembered as `loading`. That wait is often
 * several seconds — the request itself, or a page whose main thread has not
 * yet answered — and the panel paints it with the main button held. Writing
 * it down as paused instead offers Resume for a request that is still in
 * flight, and that press starts the read over.
 *
 * An error is about one request at one moment. Coming back to it hours later
 * and being told it again, before anything has even been tried, is noise.
 */
export function panelState(state) {
  if (!state?.status) return null;
  const kept = {};
  for (const field of PAINTED) {
    if (state[field] !== undefined) kept[field] = state[field];
  }
  if (kept.status === "error") kept.error = "";
  return kept;
}

/** Whether a remembered entry is still worth painting. */
export function fresh(entry, now = Date.now()) {
  if (!entry?.state) return false;
  return now - (entry.at ?? 0) < STALE_AFTER_MS;
}

/**
 * Writes for one tab, one at a time, in the order they were asked for.
 *
 * The check against `revision` has to see the write before it, or two
 * messages in flight both read an empty shelf and the slower one sticks.
 */
const tails = new Map();

function enqueue(tabId, task) {
  const previous = tails.get(tabId) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(task);
  tails.set(tabId, job.catch(() => {}));
  return job;
}

export function rememberTabState(tabId, state) {
  const store = shelf();
  const kept = panelState(state);
  if (!store || !tabId || !kept) return Promise.resolve();
  // `revision` is the reader's own count of state changes. A message that
  // was in flight across a newer one is dropped, even when its write was
  // the one that ran last.
  const revision = Number.isFinite(state.revision) ? state.revision : 0;
  const key = tabKey(tabId);
  return enqueue(tabId, async () => {
    try {
      const stored = await store.get(key);
      const entry = stored?.[key];
      if ((entry?.revision ?? -1) > revision) return;
      await store.set({ [key]: { state: kept, at: Date.now(), revision } });
    } catch {
      // Nowhere to keep it. The panel falls back to the markup's default.
    }
  });
}

export async function readTabState(tabId) {
  const store = shelf();
  if (!store || !tabId) return null;
  try {
    const key = tabKey(tabId);
    const stored = await store.get(key);
    const entry = stored?.[key];
    return fresh(entry) ? entry.state : null;
  } catch {
    return null;
  }
}

export function forgetTabState(tabId) {
  const store = shelf();
  if (!store || !tabId) return Promise.resolve();
  const key = tabKey(tabId);
  return enqueue(tabId, () => store.remove(key).catch(() => {}));
}

/**
 * The credential row. Not per tab — which credential the next read would use
 * is the same answer everywhere — and the slowest of the panel's answers on a
 * cold worker, since it is the worker that holds the session.
 */
export async function rememberAuth(summary) {
  const store = shelf();
  if (!store || !summary) return;
  await store.set({ [AUTH_KEY]: { state: summary, at: Date.now() } }).catch(() => {});
}

export async function readAuth() {
  const store = shelf();
  if (!store) return null;
  try {
    const stored = await store.get(AUTH_KEY);
    const entry = stored?.[AUTH_KEY];
    return fresh(entry) ? entry.state : null;
  } catch {
    return null;
  }
}
