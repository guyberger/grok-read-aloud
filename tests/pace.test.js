import assert from "node:assert/strict";
import test from "node:test";
import { loadContentNamespace } from "./load-content.js";

const ns = loadContentNamespace(["util.js", "align.js", "pace.js"]);
const { createPace, remainingSeconds, DEFAULT_SECONDS_PER_CHAR } = ns.pace;

/** Minutes, because that is the unit the figure is ever shown in. */
const minutes = (seconds) => Number((seconds / 60).toFixed(2));

// ---------------------------------------------------------------------------
// The rate the estimate is built from.
// ---------------------------------------------------------------------------

test("the pace starts as an assumption and becomes a measurement", () => {
  const pace = createPace();

  assert.equal(pace.measured, false);
  assert.equal(pace.secondsPerChar, DEFAULT_SECONDS_PER_CHAR);

  pace.record(240, 12);
  assert.equal(pace.measured, true);
  assert.equal(pace.secondsPerChar, 0.05, "12 seconds of audio for 240 characters");
});

test("the pace is averaged over every chunk, not taken from the last one", () => {
  const pace = createPace();

  // A short chunk of dialogue that ran slowly, then a long ordinary one.
  pace.record(100, 10);
  pace.record(900, 45);

  assert.equal(pace.secondsPerChar, 55 / 1000);
  assert.ok(pace.secondsPerChar < 0.1, "one slow chunk does not drag the whole estimate to its rate");
});

test("a chunk that said nothing useful about the pace is ignored", () => {
  const pace = createPace();
  pace.record(500, 25);
  const measured = pace.secondsPerChar;

  // A response with no duration, and an empty one: neither is evidence, and
  // either one taken at face value would halve the estimate.
  pace.record(500, 0);
  pace.record(0, 30);
  pace.record(500, undefined);

  assert.equal(pace.secondsPerChar, measured);
});

test("a new read starts from the assumption again", () => {
  // Voice and language are settings, and either one changed between two reads
  // speaks at its own rate.
  const pace = createPace();
  pace.record(1000, 80);
  pace.reset();

  assert.equal(pace.measured, false);
  assert.equal(pace.secondsPerChar, DEFAULT_SECONDS_PER_CHAR);
});

test("the assumed rate is in the range human narration actually falls in", () => {
  const charsPerSecond = 1 / DEFAULT_SECONDS_PER_CHAR;
  assert.ok(charsPerSecond > 12 && charsPerSecond < 20, `${charsPerSecond.toFixed(1)} characters a second`);
});

// ---------------------------------------------------------------------------
// Turning characters left into seconds left.
// ---------------------------------------------------------------------------

test("what is left is the audio in hand plus the text beyond it", () => {
  const seconds = remainingSeconds({
    playedSeconds: 10,
    chunkDuration: 60,
    charsAfterChunk: 6000,
    secondsPerChar: 0.05,
  });

  assert.equal(seconds, 50 + 300, "50 seconds of this chunk left, five minutes of text after it");
  assert.equal(minutes(seconds), 5.83);
});

test("the chunk in hand is timed, not estimated", () => {
  // The same position described two ways: as a chunk whose duration came back
  // with its audio, and as one that has to be multiplied out. The API's own
  // duration is the one that counts, so a chunk that ran long is reported long.
  const timed = remainingSeconds({ playedSeconds: 0, chunkDuration: 90, charsAfterChunk: 0 });
  const guessed = remainingSeconds({ charsAfterChunk: 1000, secondsPerChar: 0.05 });

  assert.equal(timed, 90);
  assert.equal(guessed, 50);
});

test("speed divides the estimate, because the audio is replayed rather than re-made", () => {
  const options = { playedSeconds: 0, chunkDuration: 60, charsAfterChunk: 1200, secondsPerChar: 0.05 };

  assert.equal(remainingSeconds({ ...options, rate: 1 }), 120);
  assert.equal(remainingSeconds({ ...options, rate: 2 }), 60, "twice the speed, half the wait");
  assert.equal(remainingSeconds({ ...options, rate: 0.5 }), 240);
  assert.equal(remainingSeconds({ ...options, rate: 0 }), 120, "a nonsense speed falls back to 1x");
});

test("the end of a read counts down to zero and stops there", () => {
  // The audio element can report a time a shade past the duration it was given.
  assert.equal(remainingSeconds({ playedSeconds: 61, chunkDuration: 60, charsAfterChunk: 0 }), 0);
  assert.equal(remainingSeconds({ charsAfterChunk: -500, secondsPerChar: 0.05 }), 0);
  assert.equal(remainingSeconds({}), 0);
  assert.equal(remainingSeconds(), 0);
});

test("the estimate only ever falls as a read advances", () => {
  const text = 20000;
  const secondsPerChar = 0.055;
  let previous = Infinity;

  // Walk a read the way one happens: whole chunks behind the playhead, part of
  // one in hand, and the rest of the page ahead.
  for (let played = 0; played < text; played += 500) {
    const chunkEnd = Math.min(text, Math.ceil((played + 1) / 1200) * 1200);
    const seconds = remainingSeconds({
      playedSeconds: (played - (chunkEnd - 1200)) * secondsPerChar,
      chunkDuration: 1200 * secondsPerChar,
      charsAfterChunk: text - chunkEnd,
      secondsPerChar,
    });
    assert.ok(seconds <= previous + 1e-9, `rose at character ${played}: ${previous} → ${seconds}`);
    previous = seconds;
  }
  assert.ok(previous < 60, `the last sample should be nearly nothing, was ${previous}`);
});

test("a page's whole estimate is what its characters and its measured pace say", () => {
  // The number a listener sees when a read begins: nothing is in hand yet, so
  // it is the whole extracted text at the rate the first chunk reported.
  const pace = createPace();
  pace.record(240, 240 * 0.055);

  const article = remainingSeconds({
    charsAfterChunk: 11000,
    secondsPerChar: pace.secondsPerChar,
  });

  assert.equal(Math.round(article / 60), 10, `an 11,000 character article is about ten minutes`);
});
