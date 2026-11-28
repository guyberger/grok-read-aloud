import assert from "node:assert/strict";
import test from "node:test";
import { fakeTimestamps, loadContentNamespace } from "./load-content.js";

const ns = loadContentNamespace();
const {
  buildChunkTimeline,
  chunkRanges,
  sentences,
  sentenceStartFrom,
  sentenceStepTarget,
  spanIndexFor,
  spokenIntoSentence,
  wordStartAt,
} = ns.align;

/** The sentences of `text`, trimmed, so a failure prints what was cut where. */
const split = (text) =>
  Array.from(sentences(text)).map((span) => text.slice(span.start, span.end).trim());

const PARAGRAPH =
  "Grinding therefore happened at odd hours. " +
  "A mill that was busy at dawn one week would be busy at midday the next. " +
  "Millers slept in shifts, and families learned to read the water.";

/** The character index of `needle`, asserted to be a word start. */
function at(text, needle) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `the fixture no longer contains ${JSON.stringify(needle)}`);
  assert.equal(wordStartAt(text, index), index, `${JSON.stringify(needle)} is not a word start`);
  return index;
}

/** The word the step lands on, so a failure says where it went. */
const landedOn = (text, start) => (start < 0 ? null : text.slice(start).split(/\s/)[0]);

/** A chunk timeline for `text.slice(start, end)`, in document coordinates. */
function timelinePiece(text, start, end) {
  const slice = text.slice(start, end);
  const fake = fakeTimestamps(slice, 0.05);
  return {
    start,
    end,
    timeline: buildChunkTimeline({
      text: slice,
      graphChars: fake.graphChars,
      graphTimes: fake.graphTimes,
      duration: fake.duration,
      globalStart: start,
    }),
  };
}

/** Media time at which `piece` starts speaking `charIndex`. */
function timeAt(piece, charIndex) {
  return ns.align.timeForCharIndex(piece.timeline, charIndex);
}

// ---------------------------------------------------------------------------
// Which span a character belongs to.
// ---------------------------------------------------------------------------

test("spanIndexFor finds the span a character falls in", () => {
  const spans = [
    { start: 0, end: 10 },
    { start: 12, end: 25 },
    { start: 25, end: 40 },
  ];
  assert.equal(spanIndexFor(spans, 0), 0);
  assert.equal(spanIndexFor(spans, 9), 0);
  assert.equal(spanIndexFor(spans, 11), 1, "a character in the gap belongs to the span that follows");
  assert.equal(spanIndexFor(spans, 24), 1);
  assert.equal(spanIndexFor(spans, 25), 2);
  assert.equal(spanIndexFor(spans, 999), 2, "past the end stays in the last span");
  assert.equal(spanIndexFor([], 3), -1);
  assert.equal(spanIndexFor(null, 3), -1);
});

// ---------------------------------------------------------------------------
// Where a sentence actually ends.
// ---------------------------------------------------------------------------

test("a title's full stop does not end a sentence", () => {
  assert.deepEqual(split("The study was led by Dr. Mair and Prof. Ito. Both agreed."), [
    "The study was led by Dr. Mair and Prof. Ito.",
    "Both agreed.",
  ]);
});

test("a dotted initialism is one word, however many stops it contains", () => {
  assert.deepEqual(split("Ship it to the U.S. market in Q3. Europe follows."), [
    "Ship it to the U.S. market in Q3.",
    "Europe follows.",
  ]);
  assert.deepEqual(split("J. R. R. Tolkien wrote it. Slowly."), [
    "J. R. R. Tolkien wrote it.",
    "Slowly.",
  ]);
  assert.deepEqual(split("The talk starts at 9 a.m. sharp. Be early."), [
    "The talk starts at 9 a.m. sharp.",
    "Be early.",
  ]);
});

test("editorial shorthand does not end a sentence either", () => {
  assert.deepEqual(split("Use a flag, e.g. --dry-run, first. Then commit."), [
    "Use a flag, e.g. --dry-run, first.",
    "Then commit.",
  ]);
  assert.deepEqual(split("See Fig. 2 for the layout. It repeats on p. 14."), [
    "See Fig. 2 for the layout.",
    "It repeats on p. 14.",
  ]);
  assert.deepEqual(split("Mair et al. measured it in Sept. 1974. Nobody repeated it."), [
    "Mair et al. measured it in Sept. 1974.",
    "Nobody repeated it.",
  ]);
});

test("a sentence ends after the quote or bracket that closes it, not before", () => {
  assert.deepEqual(split('She said "Stop." He did not.'), ['She said "Stop."', "He did not."]);
  assert.deepEqual(split("Ask them (if you can.) Later, perhaps."), [
    "Ask them (if you can.)",
    "Later, perhaps.",
  ]);
  assert.deepEqual(split('He shouted "Why?" Nobody answered.'), [
    'He shouted "Why?"',
    "Nobody answered.",
  ]);
  assert.deepEqual(split("She wrote ‘enough’. Then left."), ["She wrote ‘enough’.", "Then left."]);
});

test("a bracket that closes mid-sentence is not mistaken for the end of one", () => {
  assert.deepEqual(split("Use the flag (the short one) carefully. Then commit."), [
    "Use the flag (the short one) carefully.",
    "Then commit.",
  ]);
});

test("full stops that really do end a sentence still end one", () => {
  assert.deepEqual(split("The mill closed in 1974. Nothing replaced it."), [
    "The mill closed in 1974.",
    "Nothing replaced it.",
  ]);
  // `etc.` and `No.` are left off the abbreviation list on purpose: both
  // finish sentences more often than they sit inside one.
  assert.deepEqual(split("Wheels, sluices, gates, etc. The list is long."), [
    "Wheels, sluices, gates, etc.",
    "The list is long.",
  ]);
  assert.deepEqual(split("It costs 3.14 dollars. Really."), ["It costs 3.14 dollars.", "Really."]);
  assert.deepEqual(split("Stop! Then go? Now."), ["Stop!", "Then go?", "Now."]);
});

test("an abbreviation at the very end of the text closes the last sentence", () => {
  assert.deepEqual(split("It was published by Acme Inc."), ["It was published by Acme Inc."]);
  assert.deepEqual(split("Written by Dr."), ["Written by Dr."]);
});

test("a newline still ends a sentence, abbreviation or not", () => {
  assert.deepEqual(split("Notes from Dr. Mair\nThe tide was the clock."), [
    "Notes from Dr. Mair",
    "The tide was the clock.",
  ]);
});

// ---------------------------------------------------------------------------
// Stepping between sentences.
// ---------------------------------------------------------------------------

test("stepping over an abbreviation moves a sentence, not a title", () => {
  const text = "The study was led by Dr. Mair and Prof. Ito. Both of them agreed.";
  const spans = sentences(text);

  assert.equal(
    landedOn(text, sentenceStartFrom(spans, 0, 1)),
    "Both",
    "one step forward should clear the whole first sentence",
  );
  assert.equal(
    sentenceStartFrom(spans, at(text, "Mair"), 0),
    0,
    "the sentence being read starts at its first word, not at the title",
  );
});

test("stepping back from a quoted sentence reaches the one that opened it", () => {
  const text = 'The miller refused. He said "Not at this tide." They waited.';
  const spans = sentences(text);
  const last = at(text, "They");

  assert.equal(landedOn(text, sentenceStartFrom(spans, last, -1)), "He");
});

test("stepping back from mid-sentence can re-read that sentence", () => {
  const spans = sentences(PARAGRAPH);
  const middle = at(PARAGRAPH, "dawn");

  assert.equal(
    sentenceStartFrom(spans, middle, 0),
    at(PARAGRAPH, "A mill"),
    `offset 0 landed on ${landedOn(PARAGRAPH, sentenceStartFrom(spans, middle, 0))}`,
  );
});

test("stepping back from the start of a sentence reaches the one before it", () => {
  const spans = sentences(PARAGRAPH);
  const start = at(PARAGRAPH, "A mill");

  assert.equal(sentenceStartFrom(spans, start, -1), 0);
  assert.equal(landedOn(PARAGRAPH, sentenceStartFrom(spans, start, -1)), "Grinding");
});

test("stepping forward reaches the first character of the next sentence", () => {
  const spans = sentences(PARAGRAPH);

  assert.equal(sentenceStartFrom(spans, 0, 1), at(PARAGRAPH, "A mill"));
  assert.equal(
    sentenceStartFrom(spans, at(PARAGRAPH, "dawn"), 1),
    at(PARAGRAPH, "Millers"),
    "forward from mid-sentence skips the rest of it",
  );
});

test("stepping forward lands on a word start, never on the space before it", () => {
  const spans = sentences(PARAGRAPH);
  let cursor = 0;
  const visited = [];
  for (let step = 0; step < 10; step += 1) {
    const next = sentenceStartFrom(spans, cursor, 1);
    if (next < 0) break;
    assert.equal(wordStartAt(PARAGRAPH, next), next, `step ${step} landed mid-word`);
    assert.ok(next > cursor, "each step must move forward");
    visited.push(landedOn(PARAGRAPH, next));
    cursor = next;
  }
  assert.deepEqual(visited, ["A", "Millers"]);
});

test("stepping past either end of the text reports that there is nowhere to go", () => {
  const spans = sentences(PARAGRAPH);

  assert.equal(sentenceStartFrom(spans, 0, -1), -1, "nothing before the first sentence");
  assert.equal(sentenceStartFrom(spans, PARAGRAPH.length - 1, 1), -1, "nothing after the last");
  assert.equal(sentenceStartFrom(spans, 10_000, 1), -1, "a character past the end is in the last sentence");
  assert.equal(sentenceStartFrom([], 5, 1), -1);
  assert.equal(sentenceStartFrom(spans, -5, 1), at(PARAGRAPH, "A mill"), "a negative index is the first sentence");
});

test("a paragraph break ends a sentence, so stepping follows the layout", () => {
  const text = "A heading with no full stop\nAnd the paragraph under it. Then one more.";
  const spans = sentences(text);

  assert.equal(sentenceStartFrom(spans, 0, 1), at(text, "And the"));
  assert.equal(landedOn(text, sentenceStartFrom(spans, at(text, "And the"), 1)), "Then");
  assert.equal(sentenceStartFrom(spans, at(text, "paragraph"), 0), at(text, "And the"));
});

test("an ellipsis ends a step; unspaced text is one step however it is punctuated", () => {
  // Sentence ends count only where whitespace follows, which is also how the
  // aligner groups characters into words. Text written without spaces after
  // its stops — as Japanese and Chinese usually are — therefore steps as one
  // unit rather than being cut mid-script.
  const text = "まず第一に。それから第二に！ Then English… And more?";
  const spans = sentences(text);
  const heads = [];
  let cursor = 0;
  for (;;) {
    heads.push(landedOn(text, cursor));
    const next = sentenceStartFrom(spans, cursor, 1);
    if (next < 0) break;
    cursor = next;
  }
  assert.deepEqual(heads, ["まず第一に。それから第二に！", "Then", "And"]);
});

test("text with no sentence punctuation at all is one step", () => {
  const text = "no punctuation here at all";
  const spans = sentences(text);

  assert.equal(sentenceStartFrom(spans, 10, 0), 0);
  assert.equal(sentenceStartFrom(spans, 10, 1), -1);
  assert.equal(sentenceStartFrom(spans, 10, -1), -1);
});

test("a sentence that crosses a chunk join is still that sentence just after the join", () => {
  // The opening request is capped, so a long sentence is cut in two. The
  // clock of the chunk just begun is not the sentence starting over.
  const opener = "TOKENOPEN The sluice was shut at dawn.";
  const head = "TOKENLONG The keeper walked the whole length of the dam";
  const fill = " and looked at another peg in the frame";
  const tail = " until CHUNKTWOTOKEN showed up in this same sentence and the brake still held firm.";
  const after = "TOKENAFTER The brake was logged and the gate left shut.";
  let body = head;
  while (opener.length + 1 + body.length < 560) body += fill;
  body += tail;
  const text = `${opener}\n${body}\n${after}`;
  const spans = sentences(text);
  const ranges = chunkRanges(text, 2000, { firstChars: 240 });
  assert.equal(spans.length, 3);
  assert.ok(ranges.length > 1, "the long sentence should cross the opening chunk");
  const long = spans[1];
  const join = ranges[1].start;
  assert.ok(long.start < join && long.end > join, "the second sentence runs through the join");

  const pieces = ranges.map((range) => {
    const slice = text.slice(range.start, range.end);
    const fake = fakeTimestamps(slice, 0.05);
    return {
      start: range.start,
      end: range.end,
      timeline: buildChunkTimeline({
        text: slice,
        graphChars: fake.graphChars,
        graphTimes: fake.graphTimes,
        duration: fake.duration,
        globalStart: range.start,
      }),
    };
  });
  const atTail = text.indexOf("CHUNKTWOTOKEN");
  const playhead = 0.04;
  const elapsed = spokenIntoSentence({
    spans,
    charIndex: atTail,
    pieces,
    current: 1,
    playhead,
  });
  const prior = pieces[0].timeline.duration - ns.align.timeForCharIndex(pieces[0].timeline, long.start);
  assert.ok(prior > 1.5, `the sentence already ran ${prior}s before the join`);
  assert.ok(Math.abs(elapsed - (prior + playhead)) < 1e-6, `elapsed ${elapsed}, expected ${prior + playhead}`);

  assert.equal(
    sentenceStepTarget(spans, atTail, -1, { elapsed, replayAfter: 1.5 }),
    long.start,
    "back replays the sentence still being spoken",
  );
  assert.equal(text.slice(long.start, long.start + 9), "TOKENLONG");
  assert.equal(
    sentenceStepTarget(spans, atTail, 1, { elapsed, replayAfter: 1.5 }),
    spans[2].start,
    "forward leaves the whole sentence, not the chunk the join opened",
  );
  assert.equal(text.slice(spans[2].start, spans[2].start + 10), "TOKENAFTER");
  assert.notEqual(
    sentenceStepTarget(spans, atTail, 1, { elapsed: 0, replayAfter: 1.5 }),
    join,
    "the join is not a sentence start",
  );
});

test("back still reaches the previous sentence when the crossed part has barely begun", () => {
  const text = "Alpha sentence ends here. Beta goes on past the join and finishes later. Gamma is next.";
  const spans = sentences(text);
  const beta = spans[1].start;
  const cut = beta + 8;
  const pieces = [timelinePiece(text, 0, cut), timelinePiece(text, cut, text.length)];
  const playhead = 0.04;
  const elapsed = spokenIntoSentence({ spans, charIndex: cut + 2, pieces, current: 1, playhead });
  assert.ok(elapsed < 1.5, `a few characters across the join is ${elapsed}s, not a sentence already heard`);
  assert.equal(sentenceStepTarget(spans, cut + 2, -1, { elapsed, replayAfter: 1.5 }), spans[0].start);
  assert.equal(sentenceStepTarget(spans, cut + 2, 1, { elapsed, replayAfter: 1.5 }), spans[2].start);
});

test("a sentence that starts on the chunk boundary has barely begun at the boundary", () => {
  const text = "Alpha sentence ends here. Beta starts the next chunk cleanly. Gamma follows it.";
  const spans = sentences(text);
  const beta = spans[1].start;
  const pieces = [
    timelinePiece(text, 0, beta),
    timelinePiece(text, beta, text.length),
  ];
  const elapsed = spokenIntoSentence({ spans, charIndex: beta + 3, pieces, current: 1, playhead: 0.04 });
  assert.ok(elapsed < 1.5, elapsed);
  assert.equal(sentenceStepTarget(spans, beta + 3, -1, { elapsed, replayAfter: 1.5 }), spans[0].start);
});

test("audio no longer in hand still counts the sentence heard before the join", () => {
  const text = `Alpha sentence ends here. ${"Beta keeps going ".repeat(8)}and then stops. Gamma.`;
  const spans = sentences(text);
  const beta = spans[1].start;
  const cut = beta + 80;
  const pieces = [
    { start: 0, end: cut, secondsPerChar: 0.05 },
    timelinePiece(text, cut, text.length),
  ];
  const elapsed = spokenIntoSentence({ spans, charIndex: cut + 4, pieces, current: 1, playhead: 0.04 });
  const priorChars = cut - beta;
  assert.ok(Math.abs(elapsed - (priorChars * 0.05 + 0.04)) < 1e-9, elapsed);
  assert.equal(sentenceStepTarget(spans, cut + 4, -1, { elapsed, replayAfter: 1.5 }), beta);
});

test("inside one chunk, back still replays only once the sentence is under way", () => {
  const text = "Alpha sentence ends here. Beta is the sentence being read right now. Gamma follows.";
  const spans = sentences(text);
  const beta = spans[1].start;
  const pieces = [timelinePiece(text, 0, text.length)];
  const start = timeAt(pieces[0], beta);
  const early = spokenIntoSentence({ spans, charIndex: beta + 5, pieces, current: 0, playhead: start + 0.2 });
  const later = spokenIntoSentence({
    spans,
    charIndex: beta + 5,
    pieces,
    current: 0,
    playhead: start + 2,
  });
  assert.ok(early < 1.5 && later > 1.5, `early ${early}, later ${later}`);
  assert.equal(sentenceStepTarget(spans, beta + 5, -1, { elapsed: early, replayAfter: 1.5 }), 0);
  assert.equal(sentenceStepTarget(spans, beta + 5, -1, { elapsed: later, replayAfter: 1.5 }), beta);
  assert.equal(sentenceStepTarget(spans, beta + 5, 1, { elapsed: later, replayAfter: 1.5 }), spans[2].start);
});

test("stepping is stable across the chunk joins it has to cross", () => {
  // The reader steps over sentence spans built from the whole document, not
  // from the chunk being played, so a sentence split across two requests is
  // still one step.
  const text = `${PARAGRAPH}\n`.repeat(4);
  const spans = sentences(text);
  const starts = Array.from(spans).map((span) => span.start);

  let cursor = 0;
  const walked = [cursor];
  for (;;) {
    const next = sentenceStartFrom(spans, cursor, 1);
    if (next < 0) break;
    walked.push(next);
    cursor = next;
  }
  assert.deepEqual(walked, starts, "forward steps should visit every sentence once, in order");

  for (let i = walked.length - 1; i > 0; i -= 1) {
    assert.equal(sentenceStartFrom(spans, walked[i], -1), walked[i - 1], `back from step ${i}`);
  }
});
