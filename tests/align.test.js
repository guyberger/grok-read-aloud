import assert from "node:assert/strict";
import test from "node:test";
import { graphCharsFor } from "../tools/graph-chars.js";
import { fakeTimestamps, loadContentNamespace } from "./load-content.js";

const ns = loadContentNamespace();
const {
  chunkRanges,
  characterTimes,
  words,
  sentences,
  buildChunkTimeline,
  leadingContext,
  withoutContext,
} = ns.align;

// Values produced inside the script context belong to another realm, so copy
// them before comparing structurally.
const own = (value) => Array.from(value);

const ARTICLE = [
  "Grok reads the page aloud.",
  "Each word lights up as it is spoken, which makes it easy to follow along.",
  "Long articles are split into parts so audio starts quickly.",
].join("\n");

test("a no-break space is a word boundary and can end a sentence", () => {
  const text = "It stores 20\u00A0km of head. The account ends here.\u00A0The next thought starts.";
  assert.deepEqual(
    own(words("20\u00A0km").map((token) => "20\u00A0km".slice(token.start, token.end))),
    ["20", "km"],
  );
  const spoken = own(sentences(text).map((span) => text.slice(span.start, span.end).trim()));
  assert.deepEqual(spoken, [
    "It stores 20\u00A0km of head.",
    "The account ends here.",
    "The next thought starts.",
  ]);
});

test("Dr. followed by a no-break space is still one sentence", () => {
  const text = "Led by Dr.\u00A0Mair yesterday.";
  assert.equal(sentences(text).length, 1);
});

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

test("timestamps follow the API: one graph char per Unicode code point", () => {
  const text = "Hi 😂";
  assert.deepEqual(graphCharsFor(text), ["H", "i", " ", "😂"]);
  assert.deepEqual(fakeTimestamps(text).graphChars, graphCharsFor(text));
  assert.equal(text.length, 5, "the emoji is two UTF-16 units");
});

function wordTexts(text, timeline) {
  return own(timeline.words.map((word) => text.slice(word.start, word.end)));
}

test("a run of emoji keeps a start time on every word after it", () => {
  const emoji = "😂".repeat(8);
  const text = `Wow ${emoji} and then the sentence continues with more words here.`;
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration });
  const starts = timeline.words.map((word) => word.t0);

  assert.deepEqual(wordTexts(text, timeline).slice(0, 4), ["Wow", emoji, "and", "then"]);
  assert.equal(new Set(starts.map((start) => start.toFixed(4))).size, timeline.words.length);
  assert.ok(timeline.words[2].t0 > timeline.words[0].t0);
  // "here." is the last word. Its start is the code-point index of "h", not
  // the UTF-16 index, because each emoji is one code point of speech.
  const here = [...text.slice(0, text.indexOf("here"))].length;
  assert.ok(Math.abs(timeline.words.at(-1).t0 - here * 0.05) < 1e-9, String(timeline.words.at(-1).t0));
});

test("an inserted run longer than eight characters does not drop the rest of the line", () => {
  const text = "Alpha omega";
  const heard = `Alpha ${"*".repeat(9)}omega`;
  const { graphChars, graphTimes } = fakeTimestamps(heard, 0.1);
  const times = characterTimes(text, graphChars, graphTimes);
  const omega = text.indexOf("omega");
  // "Alpha " is six code points, then nine stars, so "omega" starts at 15.
  assert.ok(Math.abs(times.starts[omega] - 1.5) < 1e-9, String(times.starts[omega]));
  assert.ok(times.starts.every((value) => !Number.isNaN(value)));
});

test("a long run the reply never timed does not pull the following word back", () => {
  const text = `Before ${"*".repeat(30)} after.`;
  const { graphChars, graphTimes } = fakeTimestamps("Before  after.", 0.1);
  const times = characterTimes(text, graphChars, graphTimes);
  const after = text.indexOf("after");
  assert.ok(Math.abs(times.starts[after] - 0.8) < 1e-9, String(times.starts[after]));
});

test("scattered insertions stay local instead of sliding the line", () => {
  const text = "abcdef";
  const { graphChars, graphTimes } = fakeTimestamps("aXbXcXdef", 0.1);
  const times = characterTimes(text, graphChars, graphTimes);
  // "d" is the fourth page character and the seventh heard character.
  assert.ok(Math.abs(times.starts[3] - 0.6) < 1e-9, String(times.starts[3]));
});

test("a ZWJ emoji is timed as its code points and the next word follows the cluster", () => {
  const family = "👨‍👩‍👧";
  const text = `See ${family} now.`;
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  assert.ok(graphChars.includes("\u200D"), "the joiner is its own code point in the reply");
  assert.ok([...family].length > 1);

  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration });
  const words = wordTexts(text, timeline);
  assert.equal(words[0], "See");
  assert.equal(words[1], family);
  assert.equal(words[2], "now.");
  const familyPoints = [...`See ${family} `].length;
  assert.ok(Math.abs(timeline.words[2].t0 - familyPoints * 0.05) < 1e-9, String(timeline.words[2].t0));
  assert.ok(timeline.words[1].t1 > timeline.words[1].t0);
  assert.ok(timeline.words[2].t0 >= timeline.words[1].t1 - 1e-9);
});

test("a family emoji packed into one graph char still lines up with the page", () => {
  const family = "👨‍👩‍👧";
  const text = `See ${family} now.`;
  const graphChars = [..."See ", family, ..." now."];
  const graphTimes = graphChars.map((_, index) => [index * 0.1, (index + 1) * 0.1]);
  const timeline = buildChunkTimeline({
    text,
    graphChars,
    graphTimes,
    duration: graphChars.length * 0.1,
  });
  assert.equal(text.slice(timeline.words[1].start, timeline.words[1].end), family);
  assert.equal(text.slice(timeline.words[2].start, timeline.words[2].end), "now.");
  // "See " is four entries and the cluster is the fifth, so the cluster
  // starts at 0.4s and "now." — after the space that follows it — at 0.6s.
  assert.ok(Math.abs(timeline.words[1].t0 - 0.4) < 1e-9, String(timeline.words[1].t0));
  assert.ok(Math.abs(timeline.words[2].t0 - 0.6) < 1e-9, String(timeline.words[2].t0));
});

test("a flag and a skin-tone emoji keep the words around them in order", () => {
  const flag = "🇺🇸";
  const tone = "👍🏽";
  const text = `Fly ${flag} then ${tone} home.`;
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  assert.equal(graphChars.filter((char) => char === flag).length, 0, "a flag is two code points, not one string");
  assert.equal([...flag].length, 2);
  assert.equal([...tone].length, 2);

  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration });
  const words = wordTexts(text, timeline);
  assert.deepEqual(words, ["Fly", flag, "then", tone, "home."]);
  for (let i = 1; i < timeline.words.length; i += 1) {
    assert.ok(timeline.words[i].t0 > timeline.words[i - 1].t0, words[i]);
  }
  const home = [...text.slice(0, text.indexOf("home"))].length;
  assert.ok(Math.abs(timeline.words.at(-1).t0 - home * 0.05) < 1e-9);
});

test("surrogate halves in graph chars reassemble into the emoji they are", () => {
  const emoji = "😂";
  const text = `Go ${emoji} now`;
  const graphChars = ["G", "o", " ", emoji[0], emoji[1], " ", "n", "o", "w"];
  const graphTimes = graphChars.map((_, index) => [index * 0.1, (index + 1) * 0.1]);
  const times = characterTimes(text, graphChars, graphTimes);
  const now = text.indexOf("now");
  // The two halves are one code point timed from 0.3 to 0.5, then a space,
  // so "now" starts at 0.6 — and both of the emoji's units carry that span.
  assert.ok(Math.abs(times.starts[now] - 0.6) < 1e-9, String(times.starts[now]));
  const emojiAt = text.indexOf(emoji);
  assert.equal(times.starts[emojiAt], times.starts[emojiAt + 1]);
  assert.ok(Math.abs(times.starts[emojiAt] - 0.3) < 1e-9);
  assert.ok(Math.abs(times.ends[emojiAt + 1] - 0.5) < 1e-9);
});

test("CJK characters keep their own times beside an emoji run", () => {
  const text = `東京${"😂".repeat(8)}の夜`;
  const { graphChars, graphTimes } = fakeTimestamps(text, 0.05);
  const times = characterTimes(text, graphChars, graphTimes);
  assert.equal(graphChars.length, [...text].length);
  const night = text.indexOf("の");
  const before = [...text.slice(0, night)].length;
  assert.ok(Math.abs(times.starts[night] - before * 0.05) < 1e-9, String(times.starts[night]));
  assert.ok(times.starts[text.indexOf("夜")] > times.starts[night]);
  assert.ok(times.starts[0] === 0);
});

test("a combining accent stays on its letter and the next word follows both", () => {
  const text = "The cafe\u0301 opens.";
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  assert.ok(graphChars.includes("\u0301"));
  const times = characterTimes(text, graphChars, graphTimes);
  const letter = text.indexOf("e\u0301");
  const opens = text.indexOf("opens");
  assert.ok(times.starts[letter] < times.starts[letter + 1], "the accent is spoken after the letter");
  assert.ok(Math.abs(times.ends[letter + 1] - (letter + 2) * 0.05) < 1e-9);
  const before = [...text.slice(0, opens)].length;
  assert.ok(Math.abs(times.starts[opens] - before * 0.05) < 1e-9, String(times.starts[opens]));

  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration });
  assert.deepEqual(wordTexts(text, timeline), ["The", "cafe\u0301", "opens."]);
  assert.ok(timeline.words[2].t0 > timeline.words[1].t0);
});

test("the lead-in of a chunk whose context holds an emoji run starts after that run", () => {
  const emoji = "😂".repeat(8);
  const text =
    "The opening sentence is perfectly ordinary and long enough to be its own chunk of speech. " +
    `Then a reaction ${emoji} lands in the middle of the paragraph and the words after it ` +
    "should still be highlighted in order as they are spoken, one after another, until the paragraph ends.";
  const ranges = own(chunkRanges(text, 500, { firstChars: 240 }));
  assert.ok(ranges.length > 1);
  const context = leadingContext(text, ranges[1].start);
  const submission = context + text.slice(ranges[1].start, ranges[1].end);
  const fake = fakeTimestamps(submission, 0.05);
  const spoken = withoutContext({
    submission,
    contextChars: context.length,
    graphChars: fake.graphChars,
    graphTimes: fake.graphTimes,
    duration: fake.duration,
  });

  const expected = [...context].length * 0.05;
  assert.ok(Math.abs(expected - 7.1) < 1e-9, `fixture lead changed to ${expected}`);
  assert.ok(Math.abs(spoken.lead - expected) < 1e-9, `lead is ${spoken.lead}`);
  const chunk = text.slice(ranges[1].start, ranges[1].end);
  const timeline = buildChunkTimeline({
    text: chunk,
    graphChars: spoken.graphChars,
    graphTimes: spoken.graphTimes,
    duration: spoken.duration,
  });
  assert.equal(chunk.slice(timeline.words[0].start, timeline.words[0].end), "one");
  assert.ok(Math.abs(timeline.words[0].t0) < 1e-9, String(timeline.words[0].t0));
  assert.equal(new Set(timeline.words.map((word) => word.t0.toFixed(4))).size, timeline.words.length);
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

test("a short line is kept with the paragraph it introduces", () => {
  const sentence = "The wheel turns while the pond drains back out through the sluice. ";
  const heading = "At the sluice";
  const text = `${sentence.repeat(8)}\n${heading}\n${sentence.repeat(4)}`;
  const ranges = own(chunkRanges(text, 320));
  const headingAt = text.indexOf(heading);

  assert.ok(ranges.length > 1, "fixture should span more than one chunk");
  for (const range of ranges) {
    const piece = text.slice(range.start, range.end).trimEnd();
    assert.ok(!piece.endsWith(heading), `a chunk ended on the heading: ${JSON.stringify(piece.slice(-40))}`);
  }
  const holding = ranges.find((range) => headingAt >= range.start && headingAt < range.end);
  assert.ok(holding, "the heading was dropped");
  const piece = text.slice(holding.start, holding.end);
  assert.ok(piece.includes(heading));
  assert.ok(
    piece.includes("The wheel turns"),
    "the heading was synthesised apart from the paragraph under it",
  );
});

test("leading context is the previous sentence, and empty at the top", () => {
  const text = "The pond fills slowly. The wheel begins to turn once the gate is open.";
  assert.equal(leadingContext(text, 0), "");
  assert.equal(leadingContext(text, text.indexOf("The wheel")), "The pond fills slowly. ");
});

test("leading context crosses a paragraph break and keeps a closing quote", () => {
  const paragraph = "First paragraph ends.\nSecond paragraph starts here.";
  assert.equal(leadingContext(paragraph, paragraph.indexOf("Second")), "First paragraph ends.\n");

  const quoted = 'Hello. He said "Stop." Then he left.';
  assert.equal(leadingContext(quoted, quoted.indexOf("Then")), 'He said "Stop." ');
});

test("leading context does not stop on an abbreviation", () => {
  const text = "The survey was led by Dr. Mair of the institute. She filed it.";
  assert.equal(leadingContext(text, text.indexOf("She")), "The survey was led by Dr. Mair of the institute. ");
});

test("leading context is capped on a word boundary", () => {
  const long = `${"word ".repeat(80)}end. Next sentence starts now.`;
  const context = leadingContext(long, long.indexOf("Next"), 40);
  assert.ok(context.length > 0 && context.length <= 40, `context is ${context.length} characters`);
  assert.ok(context.endsWith("end. "), JSON.stringify(context));
  assert.equal(context[0], "w", "the cap opened in the middle of a word");
});

test("the unspoken lead-in is removed from the timeline and the chunk starts at zero", () => {
  const text = "The pond fills slowly. The wheel begins to turn once the gate is open.";
  const start = text.indexOf("The wheel");
  const context = leadingContext(text, start);
  const submission = context + text.slice(start);
  const { graphChars, graphTimes, duration } = fakeTimestamps(submission, 0.05);
  const spoken = withoutContext({
    submission,
    contextChars: context.length,
    graphChars,
    graphTimes,
    duration,
  });

  assert.ok(Math.abs(spoken.lead - context.length * 0.05) < 1e-6, `lead is ${spoken.lead}`);
  assert.equal(spoken.graphChars[0], "T");
  assert.equal(spoken.graphTimes[0][0], 0);
  const timeline = buildChunkTimeline({
    text: text.slice(start),
    graphChars: spoken.graphChars,
    graphTimes: spoken.graphTimes,
    duration: spoken.duration,
  });
  assert.equal(text.slice(start).slice(timeline.words[0].start, timeline.words[0].end), "The");
  assert.ok(Math.abs(timeline.words[0].t0) < 1e-6, `first word starts at ${timeline.words[0].t0}`);
  assert.ok(timeline.words.every((word) => text.slice(start).slice(word.start, word.end) !== "pond"));
});

test("lastAtOrBefore returns -1 before the first span", () => {
  const spans = [{ t0: 1 }, { t0: 2 }];
  assert.equal(ns.util.lastAtOrBefore(spans, 0), -1);
  assert.equal(ns.util.lastAtOrBefore(spans, 1), 0);
  assert.equal(ns.util.lastAtOrBefore(spans, 99), 1);
});
