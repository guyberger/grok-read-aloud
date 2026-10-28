import assert from "node:assert/strict";
import test from "node:test";
import { loadContentNamespace } from "./load-content.js";

const ns = loadContentNamespace(["util.js", "audio-cache.js"]);
const { createAudioCache, DEFAULT_MAX_BYTES } = ns.audioCache;

/** A chunk of a read, as the reader asks for it. */
function request(start, end, text, { voiceId = "eve", language = "en" } = {}) {
  return { voiceId, language, start, end, text: text ?? `text for ${start}-${end}` };
}

/** Audio of a given weight, which is all the cache knows about a value. */
function audio(kilobytes, label = "") {
  return { bytes: new Uint8Array(kilobytes * 1024), contentType: "audio/mpeg", label };
}

// ---------------------------------------------------------------------------
// Audio in hand is audio that need not be bought again.
// ---------------------------------------------------------------------------

test("audio that was fetched comes back instead of being fetched again", () => {
  const cache = createAudioCache();
  const chunk = request(0, 240);

  assert.equal(cache.get(chunk), null, "nothing has been fetched yet");

  const value = cache.set(chunk, audio(16, "opening"));
  assert.equal(cache.get(chunk), value, "the same audio, not a copy of it");
  assert.equal(cache.get(request(0, 240)).label, "opening", "asked for by value, not by identity");
});

test("audio stays in hand as a read moves past it", () => {
  // The reason the cache exists: the old behaviour held the chunk being spoken
  // and its two neighbours, so stepping back three paragraphs bought the
  // audio for them a second time.
  const cache = createAudioCache();
  const page = [0, 240, 1440, 2640, 3840, 5040].map((start, i, starts) =>
    request(start, starts[i + 1] ?? 6240),
  );
  for (const chunk of page) cache.set(chunk, audio(64));

  assert.equal(cache.stats.count, page.length);
  assert.ok(
    page.every((chunk) => cache.get(chunk)),
    "every part of a page read through is still there at the end of it",
  );
});

test("a range on its own is not an identity: the voice and the language count too", () => {
  // A voice changed between two reads — or mid-read, with a chunk already
  // prefetched — must not be answered with the voice before it.
  const cache = createAudioCache();
  const eve = request(0, 240);
  cache.set(eve, audio(16, "eve"));

  assert.equal(cache.get(request(0, 240, eve.text, { voiceId: "rex" })), null);
  assert.equal(cache.get(request(0, 240, eve.text, { language: "fr" })), null);
  assert.equal(cache.get(eve).label, "eve", "and the original is still there");
});

test("audio for text that has since changed is dropped rather than spoken", () => {
  // A character range is an address. A page that rewrites itself under a read
  // — a route change, a comment thread that finished loading — leaves the same
  // address naming different words.
  const cache = createAudioCache();
  cache.set(request(0, 240, "The mill stood by the river."), audio(16));

  assert.equal(cache.get(request(0, 240, "Something else entirely now.")), null);
  assert.equal(cache.stats.count, 0, "and the stale audio is not left taking up room");
});

// ---------------------------------------------------------------------------
// What a tab is willing to hold.
// ---------------------------------------------------------------------------

test("the budget is in bytes, and holds about an hour of speech", () => {
  // 64 kbps is what the extension asks the API for, so eight kilobytes is a
  // second of audio.
  const minutes = DEFAULT_MAX_BYTES / 8 / 1024 / 60;
  assert.ok(minutes > 30 && minutes < 90, `${Math.round(minutes)} minutes of audio`);
});

test("a page past the budget loses the audio it went longest without wanting", () => {
  const cache = createAudioCache({ maxBytes: 300 * 1024 });
  const first = request(0, 1200);
  const second = request(1200, 2400);
  const third = request(2400, 3600);
  const fourth = request(3600, 4800);

  for (const chunk of [first, second, third]) cache.set(chunk, audio(100));
  assert.equal(cache.stats.count, 3);
  assert.equal(cache.stats.bytes, 300 * 1024, "full, and nothing evicted yet");

  // Going back to the first one makes the second the oldest thing held.
  assert.ok(cache.get(first));
  cache.set(fourth, audio(100));

  assert.equal(cache.get(second), null, "the one nothing has wanted for longest");
  assert.ok(cache.get(first), "kept, because it was just played");
  assert.ok(cache.get(third));
  assert.ok(cache.get(fourth));
  assert.ok(cache.stats.bytes <= cache.stats.maxBytes);
});

test("the chunk about to be spoken is never the one evicted", () => {
  // A budget smaller than one chunk still has to answer with that chunk: it is
  // what the reader is about to play, and losing it would cost the request
  // that just paid for it.
  const cache = createAudioCache({ maxBytes: 1024 });
  const chunk = request(0, 1200);
  cache.set(chunk, audio(64));

  assert.ok(cache.get(chunk));
  assert.equal(cache.stats.count, 1);
});

test("re-fetching a chunk replaces it rather than counting it twice", () => {
  const cache = createAudioCache();
  const chunk = request(0, 1200);

  cache.set(chunk, audio(50, "first try"));
  cache.set(chunk, audio(50, "after a retry"));

  assert.equal(cache.stats.count, 1);
  assert.equal(cache.stats.bytes, 50 * 1024);
  assert.equal(cache.get(chunk).label, "after a retry");
});

test("a page that goes away takes its audio with it", () => {
  const cache = createAudioCache();
  const chunk = request(0, 1200);
  cache.set(chunk, audio(100));

  cache.clear();

  assert.equal(cache.get(chunk), null);
  assert.deepEqual({ count: cache.stats.count, bytes: cache.stats.bytes }, { count: 0, bytes: 0 });
});

// ---------------------------------------------------------------------------
// The key the reader tracks a request in flight under.
// ---------------------------------------------------------------------------

test("two requests are the same request only when everything about them is", () => {
  const cache = createAudioCache();
  const chunk = request(0, 240);

  assert.equal(cache.keyFor(chunk), cache.keyFor(request(0, 240)));
  assert.notEqual(cache.keyFor(chunk), cache.keyFor(request(0, 241)));
  assert.notEqual(cache.keyFor(chunk), cache.keyFor(request(1, 240)));
  assert.notEqual(cache.keyFor(chunk), cache.keyFor(request(0, 240, chunk.text, { voiceId: "rex" })));
  assert.notEqual(cache.keyFor(chunk), cache.keyFor(request(0, 240, chunk.text, { language: "ja" })));
});

test("a voice whose name contains the separator cannot be mistaken for another", () => {
  const cache = createAudioCache();
  assert.notEqual(
    cache.keyFor(request(0, 240, "x", { voiceId: "eve", language: "en-GB" })),
    cache.keyFor(request(0, 240, "x", { voiceId: "eve-en", language: "GB" })),
  );
});
