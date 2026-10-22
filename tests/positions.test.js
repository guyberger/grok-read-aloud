import assert from "node:assert/strict";
import test from "node:test";
import { loadContentNamespace } from "./load-content.js";

const ns = loadContentNamespace(["util.js", "positions.js"]);
const positions = ns.positions;

const PAGE =
  "The mill at Wheatfen stood where the river narrows. " +
  "Its owners dammed the stream twice a century, and twice the sea took the dam back. " +
  "Grinding therefore happened at odd hours. " +
  "A mill that was busy at dawn one week would be busy at midday the next. " +
  "Millers slept in shifts, and families learned to read the water.";

const KEY = "https://example.com/mill";

/** A position at the first character of `needle`. */
function at(text, needle, title = "Mill") {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `the fixture no longer contains ${JSON.stringify(needle)}`);
  return positions.entryFor({ text, charIndex: index, title, at: Date.now() });
}

/** Extension storage, as much of it as a position needs. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    storage: {
      local: {
        async get(key) {
          return key in data ? { [key]: data[key] } : {};
        },
        async set(patch) {
          Object.assign(data, patch);
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Which page a position belongs to.
// ---------------------------------------------------------------------------

test("a fragment is not a different page", () => {
  assert.equal(
    positions.pageKey("https://example.com/post#footnote-3"),
    positions.pageKey("https://example.com/post"),
  );
  assert.notEqual(
    positions.pageKey("https://example.com/post?page=2"),
    positions.pageKey("https://example.com/post"),
  );
});

test("something that is not a URL is still a key", () => {
  assert.equal(positions.pageKey("file-with-no-scheme"), "file-with-no-scheme");
});

// ---------------------------------------------------------------------------
// Finding the position again in the text as it is now.
// ---------------------------------------------------------------------------

test("an unchanged page is found at the index it was left at", () => {
  const entry = at(PAGE, "Grinding");
  assert.equal(positions.locate(PAGE, entry), PAGE.indexOf("Grinding"));
});

test("text inserted above the position moves with it", () => {
  const entry = at(PAGE, "Grinding");
  const edited = `A note the editors added later. ${PAGE}`;
  assert.equal(
    positions.locate(edited, entry),
    edited.indexOf("Grinding"),
    "the stored index is stale, but the words it named are not",
  );
});

test("text removed above the position moves with it", () => {
  const entry = at(PAGE, "Millers slept");
  const edited = PAGE.replace("Its owners dammed the stream twice a century, and twice the sea took the dam back. ", "");
  assert.equal(positions.locate(edited, entry), edited.indexOf("Millers slept"));
});

test("a repeated anchor resolves to the occurrence nearest the stored index", () => {
  const text = `${PAGE}\n${PAGE}`;
  const entry = positions.entryFor({ text, charIndex: text.indexOf("Grinding", PAGE.length) });
  const shifted = `Added. ${text}`;
  assert.equal(
    positions.locate(shifted, entry),
    shifted.indexOf("Grinding", PAGE.length),
    "the second copy of the sentence is the one that was being read",
  );
});

test("a page with nothing of the position left in it starts from the top", () => {
  const entry = at(PAGE, "Grinding");
  assert.equal(positions.locate("An entirely different article about bridges.", entry), -1);
  assert.equal(positions.locate("", entry), -1);
  assert.equal(positions.locate(PAGE, null), -1);
  assert.equal(positions.locate(PAGE, { charIndex: 10 }), -1, "no anchor, no position");
});

test("an edit inside the anchor falls back to the words before it", () => {
  const entry = at(PAGE, "A mill that was busy at dawn");
  // The tail of the anchor is rewritten; its opening words are still there.
  const edited = PAGE.replace("busy at midday the next.", "quiet by the middle of the following day.");
  const found = positions.locate(edited, entry);
  assert.equal(found, edited.indexOf("A mill that was busy at dawn"));
});

// ---------------------------------------------------------------------------
// Which positions are worth offering to continue from.
// ---------------------------------------------------------------------------

test("the opening of a page is not worth continuing from", () => {
  const long = PAGE.repeat(8);
  assert.equal(positions.offered(positions.entryFor({ text: long, charIndex: 0 })), false);
  assert.equal(positions.offered(positions.entryFor({ text: long, charIndex: 120 })), false);
  assert.equal(positions.offered(positions.entryFor({ text: long, charIndex: 900 })), true);
});

test("a page heard to its last few percent counts as finished", () => {
  const long = PAGE.repeat(8);
  assert.equal(positions.offered(positions.entryFor({ text: long, charIndex: long.length - 10 })), false);
});

test("a position carries the progress the popup shows", () => {
  const long = PAGE.repeat(4);
  const entry = positions.entryFor({ text: long, charIndex: Math.round(long.length / 2) });
  assert.ok(Math.abs(entry.percent - 0.5) < 0.01, `${entry.percent}`);
  assert.equal(entry.anchor, long.slice(entry.charIndex, entry.charIndex + 80));
});

test("a position is clamped to the text it came from", () => {
  assert.equal(positions.entryFor({ text: PAGE, charIndex: -5 }).charIndex, 0);
  assert.equal(positions.entryFor({ text: PAGE, charIndex: 1e6 }).charIndex, PAGE.length - 1);
  assert.equal(positions.entryFor({ text: "", charIndex: 10 }).percent, 0);
});

// ---------------------------------------------------------------------------
// Pruning, so the store cannot grow without limit.
// ---------------------------------------------------------------------------

test("stale positions are dropped and the newest pages are kept", () => {
  const now = Date.UTC(2026, 0, 1);
  const day = 24 * 60 * 60 * 1000;
  const pages = {
    "https://example.com/old": { anchor: "x", charIndex: 1, at: now - 40 * day },
    "https://example.com/recent": { anchor: "x", charIndex: 1, at: now - day },
    "https://example.com/today": { anchor: "x", charIndex: 1, at: now },
    "https://example.com/broken": { charIndex: 1, at: now },
  };
  const pruned = positions.prune(pages, now);
  assert.deepEqual(Object.keys(pruned).sort(), ["https://example.com/recent", "https://example.com/today"]);
});

test("the store keeps a bounded number of pages, the most recent first", () => {
  const now = Date.UTC(2026, 0, 1);
  const pages = {};
  for (let i = 0; i < 60; i += 1) {
    pages[`https://example.com/${i}`] = { anchor: "x", charIndex: 1, at: now - i * 1000 };
  }
  const pruned = positions.prune(pages, now);
  assert.equal(Object.keys(pruned).length, 40);
  assert.ok("https://example.com/0" in pruned, "the page read most recently is kept");
  assert.ok(!("https://example.com/59" in pruned), "the oldest page is dropped");
});

// ---------------------------------------------------------------------------
// Reading and writing them.
// ---------------------------------------------------------------------------

test("a stored position comes back for its own page and no other", async () => {
  const fake = fakeStorage();
  ns.ext = fake;
  await positions.store(at(PAGE, "Grinding"), KEY);

  const stored = await positions.load(KEY);
  assert.equal(stored.charIndex, PAGE.indexOf("Grinding"));
  assert.equal(await positions.load("https://example.com/elsewhere"), null);
});

test("writing one page's position leaves the others alone", async () => {
  const fake = fakeStorage();
  ns.ext = fake;
  await positions.store(at(PAGE, "Grinding"), KEY);
  await positions.store(at(PAGE, "Millers"), "https://example.com/other");

  assert.equal((await positions.load(KEY)).charIndex, PAGE.indexOf("Grinding"));
  assert.equal((await positions.load("https://example.com/other")).charIndex, PAGE.indexOf("Millers"));
});

test("clearing a position removes that page and keeps the rest", async () => {
  const fake = fakeStorage();
  ns.ext = fake;
  await positions.store(at(PAGE, "Grinding"), KEY);
  await positions.store(at(PAGE, "Millers"), "https://example.com/other");

  await positions.clear(KEY);
  assert.equal(await positions.load(KEY), null);
  assert.ok(await positions.load("https://example.com/other"));
});

test("positions live under one key, so settings are never touched", async () => {
  const fake = fakeStorage({ apiKey: "untouched", rate: 2 });
  ns.ext = fake;
  await positions.store(at(PAGE, "Grinding"), KEY);
  await positions.clear(KEY);

  assert.equal(fake.data.apiKey, "untouched");
  assert.equal(fake.data.rate, 2);
  assert.deepEqual(Object.keys(fake.data).sort(), ["apiKey", "rate", positions.STORE_KEY].sort());
});

test("storage that will not answer costs a read, not a reader", async () => {
  ns.ext = {
    storage: {
      local: {
        get: async () => {
          throw new Error("storage is gone");
        },
        set: async () => {
          throw new Error("storage is gone");
        },
      },
    },
  };
  assert.equal(await positions.load(KEY), null);
  await positions.store(at(PAGE, "Grinding"), KEY);
  await positions.clear(KEY);
});
