import assert from "node:assert/strict";
import test from "node:test";

/**
 * The cache reaches `storage.session` through `common/browser.js`, which reads
 * the extension globals as it loads — so the fake has to be in place first.
 * `shelf()` looks the area up on every call, which is what lets the test for a
 * browser without session storage take it away again.
 */
const session = new Map();

const area = {
  async get(key) {
    return session.has(key) ? { [key]: session.get(key) } : {};
  },
  async set(patch) {
    for (const [key, value] of Object.entries(patch)) session.set(key, value);
  },
  async remove(key) {
    session.delete(key);
  },
};

globalThis.chrome = {
  storage: {
    session: area,
    local: { get: async () => ({ apiKey: "" }), set: async () => {} },
  },
};

const cache = await import("../src/common/panel-cache.js");

/** A reader snapshot, in the shape `reader.js` emits one. */
const snapshot = (over = {}) => ({
  status: "playing",
  scope: "page",
  chunkIndex: 2,
  chunkCount: 9,
  progress: 0.24,
  remainingSeconds: 310,
  resume: null,
  title: "An article",
  rate: 1.25,
  voiceId: "eve",
  hasApiKey: true,
  signedIn: false,
  hasCredential: true,
  notice: "",
  error: "",
  engine: "element",
  aligned: true,
  ...over,
});

test.beforeEach(() => {
  session.clear();
  globalThis.chrome.storage.session = area;
});

// ---------------------------------------------------------------------------
// What is kept.
// ---------------------------------------------------------------------------

test("a remembered state comes back the way the panel paints it", async () => {
  await cache.rememberTabState(7, snapshot());
  const read = await cache.readTabState(7);

  assert.equal(read.status, "playing");
  assert.equal(read.chunkIndex, 2);
  assert.equal(read.chunkCount, 9);
  assert.equal(read.progress, 0.24);
  assert.equal(read.remainingSeconds, 310);
  assert.equal(read.title, "An article");
  assert.equal(read.rate, 1.25);
  assert.equal(read.hasCredential, true);
});

test("nothing the panel does not paint is kept", async () => {
  await cache.rememberTabState(7, snapshot());
  const read = await cache.readTabState(7);

  assert.equal("engine" in read, false);
  assert.equal("aligned" in read, false);
});

test("a read still loading is remembered as the pause it will look like", async () => {
  // `loading` is a moment, not a state to come back to: the request it refers
  // to is gone by the time anyone reads this.
  await cache.rememberTabState(7, snapshot({ status: "loading" }));
  assert.equal((await cache.readTabState(7)).status, "paused");
});

test("the error from a request long over is not shown again", async () => {
  await cache.rememberTabState(7, snapshot({ status: "error", error: "API error 429." }));
  const read = await cache.readTabState(7);

  assert.equal(read.status, "error");
  assert.equal(read.error, "");
});

test("each tab is remembered on its own", async () => {
  await cache.rememberTabState(1, snapshot({ title: "First" }));
  await cache.rememberTabState(2, snapshot({ title: "Second", status: "paused" }));

  assert.equal((await cache.readTabState(1)).title, "First");
  assert.equal((await cache.readTabState(2)).status, "paused");
});

test("a state with no status is not worth remembering", async () => {
  await cache.rememberTabState(7, {});
  await cache.rememberTabState(7, null);
  assert.equal(await cache.readTabState(7), null);
});

test("a tab nothing is known about reads as nothing", async () => {
  assert.equal(await cache.readTabState(99), null);
  assert.equal(await cache.readTabState(undefined), null);
});

// ---------------------------------------------------------------------------
// What stops being true.
// ---------------------------------------------------------------------------

test("a forgotten tab is forgotten", async () => {
  await cache.rememberTabState(7, snapshot());
  await cache.forgetTabState(7);
  assert.equal(await cache.readTabState(7), null);
});

test("forgetting one tab leaves the others alone", async () => {
  await cache.rememberTabState(1, snapshot());
  await cache.rememberTabState(2, snapshot());
  await cache.forgetTabState(1);

  assert.equal(await cache.readTabState(1), null);
  assert.ok(await cache.readTabState(2));
});

test("a state remembered half a day ago is not painted", async () => {
  await cache.rememberTabState(7, snapshot());
  const entry = session.get(cache.tabKey(7));
  session.set(cache.tabKey(7), { ...entry, at: Date.now() - 13 * 60 * 60 * 1000 });

  assert.equal(await cache.readTabState(7), null);
});

test("freshness is about the entry, not about what is in it", () => {
  assert.equal(cache.fresh({ state: { status: "idle" }, at: Date.now() }), true);
  assert.equal(cache.fresh({ state: { status: "idle" }, at: 0 }), false);
  assert.equal(cache.fresh({ at: Date.now() }), false);
  assert.equal(cache.fresh(null), false);
});

// ---------------------------------------------------------------------------
// The credential row.
// ---------------------------------------------------------------------------

test("the credential row is remembered once, not per tab", async () => {
  await cache.rememberAuth({ signedIn: true, tierDenied: false, hasApiKey: false, pending: false });
  const read = await cache.readAuth();

  assert.deepEqual(read, { signedIn: true, tierDenied: false, hasApiKey: false, pending: false });
});

test("a credential row nobody has written reads as nothing", async () => {
  assert.equal(await cache.readAuth(), null);
});

test("writing the credential row again replaces it", async () => {
  await cache.rememberAuth({ signedIn: true, tierDenied: false, hasApiKey: false, pending: false });
  await cache.rememberAuth({ signedIn: false, tierDenied: false, hasApiKey: true, pending: false });

  assert.equal((await cache.readAuth()).signedIn, false);
  assert.equal((await cache.readAuth()).hasApiKey, true);
});

// ---------------------------------------------------------------------------
// A browser with nowhere to keep it.
// ---------------------------------------------------------------------------

test("without session storage nothing is written and nothing is read", async () => {
  delete globalThis.chrome.storage.session;

  await cache.rememberTabState(7, snapshot());
  await cache.rememberAuth({ signedIn: true });
  await cache.forgetTabState(7);

  assert.equal(session.size, 0);
  assert.equal(await cache.readTabState(7), null);
  assert.equal(await cache.readAuth(), null);
});

test("a session area that throws is not an error the panel sees", async () => {
  globalThis.chrome.storage.session = {
    async get() {
      throw new Error("no");
    },
    async set() {
      throw new Error("no");
    },
    async remove() {
      throw new Error("no");
    },
  };

  await cache.rememberTabState(7, snapshot());
  await cache.forgetTabState(7);
  assert.equal(await cache.readTabState(7), null);
  assert.equal(await cache.readAuth(), null);
});
