import assert from "node:assert/strict";
import test from "node:test";
import { fakeTimestamps, loadContentNamespace } from "./load-content.js";

const ns = loadContentNamespace();
const { chunkRanges, characterTimes, words, sentences, buildChunkTimeline } = ns.align;

// Values produced inside the script context belong to another realm, so copy
// them before comparing structurally.
const own = (value) => Array.from(value);

const ARTICLE = [
  "Grok reads the page aloud.",
  "Each word lights up as it is spoken, which makes it easy to follow along.",
  "Long articles are split into parts so audio starts quickly.",
].join("\n");

test("chunkRanges keeps every chunk under the limit", () => {
  const text = `${ARTICLE}\n`.repeat(40);
  const ranges = chunkRanges(text, 600);
  assert.ok(ranges.length > 1);
  for (const range of ranges) {
    assert.ok(range.end - range.start <= 600, `chunk of ${range.end - range.start} exceeds 600`);
    assert.ok(range.end > range.start);
  }
});

test("chunkRanges covers the whole text without reordering or duplicating words", () => {
  const text = `${ARTICLE}\n`.repeat(12);
  const ranges = chunkRanges(text, 500);
  const rejoined = own(ranges.map((range) => text.slice(range.start, range.end)))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
  assert.deepEqual(rejoined, text.split(/\s+/).filter(Boolean));
});

test("chunkRanges prefers paragraph and sentence boundaries", () => {
  assert.equal(chunkRanges(ARTICLE, 600).length, 1, "short text should stay in one chunk");

  const long = [ARTICLE, ARTICLE, ARTICLE].join("\n");
  const tight = chunkRanges(long, 220);
  assert.ok(tight.length > 1);
  for (const range of tight.slice(0, -1)) {
    const tail = long.slice(range.start, range.end).trimEnd().slice(-1);
    assert.ok(".!?\n".includes(tail), `chunk ended mid-sentence on ${JSON.stringify(tail)}`);
  }
});

test("chunkRanges does not cut a chunk inside an abbreviation", () => {
  // The cut is what the API hears: a chunk ending `led by Dr.` is read with a
  // full stop in the middle of a name, and the next one opens on `Mair`.
  const sentence = "The survey was led by Dr. Mair of the Mt. Vernon institute, who filed it in Sept. 1974. ";
  const text = sentence.repeat(12);
  const ranges = own(chunkRanges(text, 300));

  assert.ok(ranges.length > 3, `expected several chunks, got ${ranges.length}`);
  const tails = ranges.slice(0, -1).map((range) => text.slice(range.start, range.end).trimEnd());
  for (const tail of tails) {
    assert.ok(
      !/\b(Dr|Mt|Sept)\.$/.test(tail),
      `chunk ended on an abbreviation: ${JSON.stringify(tail.slice(-20))}`,
    );
  }
});

test("chunkRanges cuts after the quote that closes a sentence, not before it", () => {
  // Every sentence here ends on a quote mark, so the only boundary a chunk can
  // be cut at is one. Cut at the stop instead and the next chunk opens on a
  // stray `"`, which the API reads as the start of something.
  const sentence = 'He said "Not at this tide, not for anyone, not for the abbot himself." ';
  const text = sentence.repeat(12);
  const ranges = own(chunkRanges(text, 200));

  assert.ok(ranges.length > 3, `expected several chunks, got ${ranges.length}`);
  for (const range of ranges) {
    const piece = text.slice(range.start, range.end).trim();
    assert.ok(!piece.startsWith('"'), `a chunk opened on a stray quote: ${JSON.stringify(piece.slice(0, 20))}`);
  }
  assert.ok(
    ranges.slice(0, -1).every((range) => text.slice(range.start, range.end).trimEnd().endsWith('."')),
    `chunks ended on ${JSON.stringify(ranges.map((range) => text.slice(range.start, range.end).trimEnd().slice(-3)))}`,
  );
});

test("chunkRanges never emits a whitespace-only chunk", () => {
  const ranges = chunkRanges("   \n\n  Hello there, world.  \n\n   ", 300);
  assert.equal(ranges.length, 1);
  assert.equal("   \n\n  Hello there, world.  \n\n   ".slice(ranges[0].start, ranges[0].end).trim(), "Hello there, world.");
});

test("firstChars makes the opening chunk small and grows from there", () => {
  const text = `${ARTICLE}\n`.repeat(20);
  const sizes = own(chunkRanges(text, 1200, { firstChars: 240 })).map((range) => range.end - range.start);

  assert.ok(sizes[0] <= 240, `opening chunk of ${sizes[0]} characters is not small`);
  assert.ok(sizes[1] > sizes[0], "the second chunk should be bigger than the first");
  assert.ok(
    sizes.slice(0, 4).every((size, index) => size <= 240 * 2 ** index),
    `sizes ${sizes.slice(0, 4).join(", ")} grew faster than doubling`,
  );
  assert.ok(sizes.some((size) => size > 900), `nothing reached full size: ${sizes.join(", ")}`);
  for (const size of sizes) assert.ok(size <= 1200, `chunk of ${size} exceeds the limit`);
});

test("a small opening chunk still ends on a sentence boundary", () => {
  const text = `${ARTICLE}\n`.repeat(20);
  const ranges = own(chunkRanges(text, 1200, { firstChars: 240 }));
  for (const range of ranges.slice(0, -1)) {
    const tail = text.slice(range.start, range.end).trimEnd().slice(-1);
    assert.ok(".!?\n".includes(tail), `chunk ended mid-sentence on ${JSON.stringify(tail)}`);
  }
});

test("firstChars loses no text and stays within the limit it is given", () => {
  const text = `${ARTICLE}\n`.repeat(9);
  const rejoined = own(chunkRanges(text, 1200, { firstChars: 240 }))
    .map((range) => text.slice(range.start, range.end))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
  assert.deepEqual(rejoined, text.split(/\s+/).filter(Boolean));

  // A first chunk is never asked to be bigger than the steady-state size.
  const small = own(chunkRanges(text, 300, { firstChars: 900 }));
  for (const range of small) assert.ok(range.end - range.start <= 300);
});

test("without firstChars the chunking is unchanged", () => {
  const text = `${ARTICLE}\n`.repeat(9);
  const shape = (ranges) => own(ranges).map((range) => `${range.start}:${range.end}`);
  assert.deepEqual(shape(chunkRanges(text, 600, {})), shape(chunkRanges(text, 600)));
  assert.deepEqual(shape(chunkRanges(text, 600, { firstChars: 0 })), shape(chunkRanges(text, 600)));
});

test("characterTimes maps one-for-one when the API echoes the text", () => {
  const text = "Hello world.";
  const { graphChars, graphTimes } = fakeTimestamps(text, 0.1);
  const times = characterTimes(text, graphChars, graphTimes);
  assert.ok(times);
  for (let i = 0; i < text.length; i += 1) {
    assert.ok(Math.abs(times.starts[i] - i * 0.1) < 1e-9);
    assert.ok(Math.abs(times.ends[i] - (i + 1) * 0.1) < 1e-9);
  }
});

test("characterTimes recovers when the API inserts extra characters", () => {
  const text = "Hi there";
  const { graphChars, graphTimes } = fakeTimestamps("Hi, there", 0.1);
  const times = characterTimes(text, graphChars, graphTimes);
  // "there" in the submitted text must still land on the API's "there" timings.
  assert.ok(Math.abs(times.starts[3] - 0.4) < 1e-9, `got ${times.starts[3]}`);
  assert.ok(times.starts.every((value) => !Number.isNaN(value)));
});

test("characterTimes interpolates characters the API never reported", () => {
  const text = "abcd";
  const times = characterTimes(text, ["a", "d"], [
    [0, 1],
    [3, 4],
  ]);
  assert.equal(times.starts[0], 0);
  assert.ok(times.starts[1] >= 1 && times.starts[1] <= 3);
  assert.ok(times.starts[2] >= times.starts[1]);
  assert.equal(times.starts[3], 3);
});

test("characterTimes returns null without timestamps", () => {
  assert.equal(characterTimes("abc", null, null), null);
});

test("words and sentences tokenise punctuation with the word it belongs to", () => {
  const text = "Hello world. Bye!";
  assert.deepEqual(
    own(words(text).map((token) => text.slice(token.start, token.end))),
    ["Hello", "world.", "Bye!"],
  );
  assert.deepEqual(
    own(sentences(text).map((token) => text.slice(token.start, token.end).trim())),
    ["Hello world.", "Bye!"],
  );
});

test("sentences break on paragraph newlines", () => {
  const text = "One line\nAnother line";
  assert.deepEqual(
    own(sentences(text).map((token) => text.slice(token.start, token.end).trim())),
    ["One line", "Another line"],
  );
});

test("buildChunkTimeline puts the right word under the playhead", () => {
  const text = "The quick brown fox jumps.";
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration });

  assert.ok(timeline.aligned);
  const at = (time) => {
    const index = ns.util.lastAtOrBefore(timeline.words, time);
    const word = timeline.words[index];
    return text.slice(word.start, word.end);
  };

  assert.equal(at(0), "The");
  assert.equal(at(0.1), "The");
  assert.equal(at(0.25), "quick");
  assert.equal(at(0.55), "brown");
  assert.equal(at(duration - 0.01), "jumps.");
});

test("buildChunkTimeline offsets spans into document coordinates", () => {
  const text = "Hello world.";
  const { graphChars, graphTimes, duration } = fakeTimestamps(text);
  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration, globalStart: 1000 });
  assert.equal(timeline.words[0].start, 1000);
  assert.equal(timeline.words[0].end, 1005);
  assert.equal(timeline.words.at(-1).end, 1000 + text.length);
});

test("buildChunkTimeline keeps word times monotonic and non-overlapping backwards", () => {
  const text = ARTICLE;
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.04);
  const { words: spans } = buildChunkTimeline({ text, graphChars, graphTimes, duration });
  for (let i = 1; i < spans.length; i += 1) {
    assert.ok(spans[i].t0 >= spans[i - 1].t0, `word ${i} starts before its predecessor`);
    assert.ok(spans[i].t1 >= spans[i].t0);
  }
  assert.ok(spans.at(-1).t1 <= duration + 1e-6);
});

test("buildChunkTimeline falls back to proportional timing without timestamps", () => {
  const text = "One two three four";
  const timeline = buildChunkTimeline({ text, graphChars: null, graphTimes: null, duration: 4 });
  assert.equal(timeline.aligned, false);
  assert.equal(timeline.words.length, 4);
  assert.equal(timeline.words[0].t0, 0);
  assert.ok(timeline.words.at(-1).t1 <= 4 + 1e-9);
  for (let i = 1; i < timeline.words.length; i += 1) {
    assert.ok(timeline.words[i].t0 >= timeline.words[i - 1].t0);
  }
});

test("lastAtOrBefore returns -1 before the first span", () => {
  const spans = [{ t0: 1 }, { t0: 2 }];
  assert.equal(ns.util.lastAtOrBefore(spans, 0), -1);
  assert.equal(ns.util.lastAtOrBefore(spans, 1), 0);
  assert.equal(ns.util.lastAtOrBefore(spans, 99), 1);
});
