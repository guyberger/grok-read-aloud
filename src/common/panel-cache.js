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
 * A read in flight is remembered as the pause it will look like by the time
 * anyone sees this: `loading` is a moment, not a state to come back to, and a
 * panel that opens claiming to be loading would be claiming a request that no
 * longer exists.
 */
export function panelState(state) {
  if (!state?.status) return null;
  const kept = {};
  for (const field of PAINTED) {
    if (state[field] !== undefined) kept[field] = state[field];
  }
  if (kept.status === "loading") kept.status = "paused";
  // An error is about one request at one moment. Coming back to it hours later
  // and being told it again, before anything has even been tried, is noise.
  if (kept.status === "error") kept.error = "";
  return kept;
}

/** Whether a remembered entry is still worth painting. */
export function fresh(entry, now = Date.now()) {
  if (!entry?.state) return false;
  return now - (entry.at ?? 0) < STALE_AFTER_MS;
}

export async function rememberTabState(tabId, state) {
  const store = shelf();
  const kept = panelState(state);
  if (!store || !tabId || !kept) return;
  await store.set({ [tabKey(tabId)]: { state: kept, at: Date.now() } }).catch(() => {});
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

export async function forgetTabState(tabId) {
  const store = shelf();
  if (!store || !tabId) return;
  await store.remove(tabKey(tabId)).catch(() => {});
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
