import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Browser, contentBundle, findChrome, fixtureUrl } from "./headless.js";
import { fakeTimestamps, loadContentNamespace } from "./load-content.js";

const ns = loadContentNamespace();
const { chunkRanges, wordStartAt, chunkIndexFor, timeForCharIndex, buildChunkTimeline } = ns.align;

const PARAGRAPH =
  "A tide mill is a water mill that runs on the rise and fall of the sea. " +
  "The builders dammed a creek and let the tide fill a holding pond. " +
  "The trapped water drained back out through a wheel as the tide retreated.";

// ---------------------------------------------------------------------------
// Character index to word, chunk and time.
// ---------------------------------------------------------------------------

test("wordStartAt snaps to the first character of the word under the click", () => {
  const text = "Hello world. Bye!";
  assert.equal(wordStartAt(text, 0), 0);
  assert.equal(wordStartAt(text, 3), 0, "mid-word should snap back to the word start");
  assert.equal(wordStartAt(text, 4), 0);
  assert.equal(wordStartAt(text, 6), 6);
  assert.equal(wordStartAt(text, 10), 6, "punctuation belongs to the word before it");
  assert.equal(wordStartAt(text, 13), 13);
  assert.equal(wordStartAt(text, 16), 13);
});

test("wordStartAt resolves a click in the gap between words", () => {
  const text = "one  two\nthree";
  assert.equal(wordStartAt(text, 3), 5, "a space takes the word that follows");
  assert.equal(wordStartAt(text, 4), 5);
  assert.equal(wordStartAt(text, 8), 9, "a paragraph break takes the next paragraph");
});

test("wordStartAt stays inside the text for clicks past either end", () => {
  const text = "one two   ";
  assert.equal(wordStartAt(text, -5), 0);
  assert.equal(wordStartAt(text, 999), 4, "past the last word takes the last word");
  assert.equal(wordStartAt(text, 9), 4, "trailing whitespace takes the last word");
  assert.equal(wordStartAt("", 3), 0);
});

test("chunkIndexFor finds the chunk a character belongs to", () => {
  const chunks = [
    { start: 0, end: 10 },
    { start: 10, end: 25 },
    { start: 25, end: 40 },
  ];
  assert.equal(chunkIndexFor(chunks, 0), 0);
  assert.equal(chunkIndexFor(chunks, 9), 0);
  assert.equal(chunkIndexFor(chunks, 10), 1, "a chunk's first character is its own");
  assert.equal(chunkIndexFor(chunks, 24), 1);
  assert.equal(chunkIndexFor(chunks, 25), 2);
  assert.equal(chunkIndexFor(chunks, 999), 2, "past the end stays in the last chunk");
  assert.equal(chunkIndexFor([], 3), -1);
});

test("timeForCharIndex returns the media time the word starts being spoken", () => {
  const text = "The quick brown fox jumps.";
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration });

  assert.equal(timeForCharIndex(timeline, 0), 0);
  // "brown" starts at index 10, and every character takes 0.05s.
  assert.ok(Math.abs(timeForCharIndex(timeline, 10) - 0.5) < 1e-6, timeForCharIndex(timeline, 10));
  assert.ok(
    Math.abs(timeForCharIndex(timeline, 12) - 0.5) < 1e-6,
    "mid-word still returns the start of that word",
  );
  assert.equal(timeForCharIndex(null, 4), 0);
});

test("timeForCharIndex works in document coordinates, not chunk-local ones", () => {
  const text = "The quick brown fox jumps.";
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration, globalStart: 5000 });

  assert.ok(Math.abs(timeForCharIndex(timeline, 5010) - 0.5) < 1e-6);
  assert.equal(timeForCharIndex(timeline, 0), 0, "before the chunk, play it from the top");
});

test("a clicked character maps through to a chunk and a time within it", () => {
  const text = `${PARAGRAPH}\n`.repeat(6);
  const chunks = chunkRanges(text, 400);
  assert.ok(chunks.length > 1, "fixture should need more than one chunk");

  // Somewhere in the middle, mid-word on purpose.
  const clicked = text.indexOf("retreated", 900) + 4;
  const wordStart = wordStartAt(text, clicked);
  assert.equal(text.slice(wordStart, wordStart + 9), "retreated");

  const index = chunkIndexFor(chunks, wordStart);
  const chunk = chunks[index];
  assert.ok(wordStart >= chunk.start && wordStart < chunk.end);

  const chunkText = text.slice(chunk.start, chunk.end);
  const { graphChars, graphTimes, duration } = fakeTimestamps(chunkText, 0.05);
  const timeline = buildChunkTimeline({
    text: chunkText,
    graphChars,
    graphTimes,
    duration,
    globalStart: chunk.start,
  });

  const time = timeForCharIndex(timeline, wordStart);
  assert.ok(Math.abs(time - (wordStart - chunk.start) * 0.05) < 1e-6, `got ${time}`);
  assert.ok(time > 0 && time < duration);
});

// ---------------------------------------------------------------------------
// Re-cutting the chunks so one begins at the clicked word.
// ---------------------------------------------------------------------------

test("chunkRanges starts a chunk exactly at a forced boundary", () => {
  const text = `${PARAGRAPH}\n`.repeat(6);
  const at = text.indexOf("holding", 500);
  const ranges = chunkRanges(text, 400, [at]);

  assert.ok(
    Array.from(ranges).some((range) => range.start === at),
    "no chunk begins at the forced boundary",
  );
  for (const range of ranges) {
    assert.ok(range.end - range.start <= 400, `chunk of ${range.end - range.start} exceeds the limit`);
  }
});

test("a forced boundary keeps every word, in order", () => {
  const text = `${PARAGRAPH}\n`.repeat(4);
  const at = text.indexOf("wheel", 300);
  const rejoined = Array.from(chunkRanges(text, 350, [at]))
    .map((range) => text.slice(range.start, range.end))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
  assert.deepEqual(rejoined, text.split(/\s+/).filter(Boolean));
});

test("boundaries outside the text, or duplicated, change nothing", () => {
  const text = `${PARAGRAPH}\n`.repeat(3);
  const shape = (ranges) => Array.from(ranges).map((range) => `${range.start}:${range.end}`);
  const plain = shape(chunkRanges(text, 400));

  for (const boundaries of [[], [0], [-10], [text.length], [text.length + 50]]) {
    assert.deepEqual(
      shape(chunkRanges(text, 400, boundaries)),
      plain,
      `boundaries ${JSON.stringify(boundaries)} should be ignored`,
    );
  }
  assert.deepEqual(shape(chunkRanges(text, 400, [120, 120])), shape(chunkRanges(text, 400, [120])));
});

test("a forced boundary only disturbs the chunking around itself", () => {
  // Cutting is greedy from the start of each piece, so everything more than
  // one chunk's worth ahead of the boundary comes out exactly as it would
  // have without one. That is what keeps the chunk being played, and the one
  // before it, where they were.
  const text = `${PARAGRAPH}\n`.repeat(8);
  const plain = Array.from(chunkRanges(text, 400));
  const at = wordStartAt(text, plain[5].start + 120);
  const recut = Array.from(chunkRanges(text, 400, [at]));

  const settled = plain.filter((range) => range.end <= at - 400);
  assert.ok(settled.length > 1, "fixture should have chunks well ahead of the boundary");
  for (let i = 0; i < settled.length; i += 1) {
    assert.equal(recut[i].start, plain[i].start, `chunk ${i} moved`);
    assert.equal(recut[i].end, plain[i].end, `chunk ${i} moved`);
  }

  // And after it, the boundary is a chunk start and nothing is lost.
  assert.ok(recut.some((range) => range.start === at));
  assert.equal(recut.at(-1).end, plain.at(-1).end);
});

// ---------------------------------------------------------------------------
// Clicks in a real browser: a viewport point back to a character, and the
// gate that decides whether a click is the reader's at all.
// ---------------------------------------------------------------------------

const skip = findChrome() ? false : "no Chrome binary found (set CHROME_PATH to run these)";

let browser = null;
const pages = [];

before(async () => {
  if (skip) return;
  browser = await Browser.launch();
});

after(async () => {
  for (const page of pages) await page.close().catch(() => {});
  browser?.close();
});

async function read(fixture) {
  const page = await browser.open(
    fixtureUrl(fixture),
    contentBundle(["util.js", "extract.js", "align.js", "pointer.js"]),
  );
  pages.push(page);
  await page.evaluate(`
    (() => {
      const ns = globalThis.__readAloud;
      window.doc = ns.extract.extract("page");
      window.chunks = ns.align.chunkRanges(window.doc.text, 400);

      /** What clicking the middle of the characters [start, end) resolves to. */
      window.clickWord = (start, end) => {
        ns.extract.rangeFor(window.doc, start, end)
          .startContainer.parentElement.scrollIntoView({ block: "center" });
        const rect = ns.extract.rangeFor(window.doc, start, end).getClientRects()[0];
        const hit = ns.extract.charIndexFromPoint(
          window.doc, rect.left + rect.width / 2, rect.top + rect.height / 2,
        );
        if (hit < 0) return { hit, word: null };
        const wordStart = ns.align.wordStartAt(window.doc.text, hit);
        return {
          hit,
          wordStart,
          chunk: ns.align.chunkIndexFor(window.chunks, wordStart),
          word: window.doc.text.slice(wordStart).split(/\\s/)[0],
        };
      };

      window.spanOf = (needle) => {
        const start = window.doc.text.indexOf(needle);
        return start < 0 ? null : [start, start + needle.length];
      };
      return true;
    })()
  `);

  return {
    page,
    clickWord: async (needle) => {
      const span = await page.evaluate(`JSON.stringify(window.spanOf(${JSON.stringify(needle)}))`);
      assert.ok(span && span !== "null", `the text being read no longer contains "${needle}"`);
      const [start, end] = JSON.parse(span);
      const result = JSON.parse(
        await page.evaluate(`JSON.stringify(window.clickWord(${start}, ${end}))`),
      );
      return { ...result, start };
    },
  };
}

test("a click lands on the word under the pointer", { skip }, async () => {
  const { clickWord } = await read("article.html");

  for (const needle of ["tide", "builders", "retreated", "engineering"]) {
    const result = await clickWord(needle);
    assert.equal(
      result.wordStart,
      result.start,
      `clicking "${needle}" resolved to "${result.word}"`,
    );
  }
});

test("a clicked word maps to the chunk that holds it", { skip }, async () => {
  const { page, clickWord } = await read("article.html");

  const chunks = JSON.parse(await page.evaluate(`JSON.stringify(Array.from(window.chunks))`));
  assert.ok(chunks.length > 1, `the article should need more than one chunk, got ${chunks.length}`);

  const first = await clickWord("builders");
  const later = await clickWord("restraint");

  assert.equal(first.chunk, 0, "an opening word should be in the first chunk");
  assert.ok(later.chunk > 0, `a closing word should be in a later chunk, got ${later.chunk}`);
  assert.ok(later.wordStart >= chunks[later.chunk].start);
  assert.ok(later.wordStart < chunks[later.chunk].end);
});

test("a click outside the text being read resolves to nothing", { skip }, async () => {
  const { page } = await read("article.html");

  const outside = JSON.parse(
    await page.evaluate(`
      JSON.stringify(
        ["nav", "footer", "article aside"].map((selector) => {
          const element = document.querySelector(selector);
          element.scrollIntoView({ block: "center" });
          const rect = element.getBoundingClientRect();
          return globalThis.__readAloud.extract.charIndexFromPoint(
            window.doc, rect.left + 30, rect.top + rect.height / 2,
          );
        }),
      )
    `),
  );
  assert.deepEqual(outside, [-1, -1, -1], "page furniture should not be clickable");
});

test("a selection read is only clickable inside the selection", { skip }, async () => {
  const { page, clickWord } = await read("article.html");

  const scope = await page.evaluate(`
    (() => {
      const ns = globalThis.__readAloud;
      const paragraph = document.querySelectorAll("article p")[2];
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      window.doc = ns.extract.extract("selection");
      window.chunks = ns.align.chunkRanges(window.doc.text, 400);
      selection.removeAllRanges();
      return window.doc.scope;
    })()
  `);
  assert.equal(scope, "selection");

  const inside = await clickWord("Grinding");
  assert.equal(inside.wordStart, 0, "the first word of the selection should be clickable");

  const elsewhere = await page.evaluate(`
    (() => {
      const other = document.querySelectorAll("article p")[0];
      other.scrollIntoView({ block: "center" });
      const rect = other.getBoundingClientRect();
      return globalThis.__readAloud.extract.charIndexFromPoint(
        window.doc, rect.left + 20, rect.top + 8,
      );
    })()
  `);
  assert.equal(elsewhere, -1, "text outside the selection should not be clickable");
});

/** Dispatches clicks and reports whether the reader would act on each one. */
async function clickGate(page) {
  await page.evaluate(`
    (() => {
      window.accepted = [];
      globalThis.__readAloud.pointer.watch((event) => window.accepted.push(event.target.nodeName));
      return true;
    })()
  `);
  return async (script) => {
    const before = await page.evaluate(`window.accepted.length`);
    await page.evaluate(script);
    return (await page.evaluate(`window.accepted.length`)) > before;
  };
}

test("plain clicks on text are the reader's; everything else is not", { skip }, async () => {
  const { page } = await read("article.html");
  const dispatch = await clickGate(page);

  const clickOn = (selector, options = {}) => `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: "center" });
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, button: 0, detail: 1,
        clientX: rect.left + 10, clientY: rect.top + 5,
        ...${JSON.stringify(options)},
      }));
      return true;
    })()
  `;

  assert.equal(await dispatch(clickOn("article p")), true, "a plain click on a paragraph");
  assert.equal(await dispatch(clickOn("article p", { ctrlKey: true })), false, "ctrl-click");
  assert.equal(await dispatch(clickOn("article p", { metaKey: true })), false, "command-click");
  assert.equal(await dispatch(clickOn("article p", { shiftKey: true })), false, "shift-click");
  assert.equal(await dispatch(clickOn("article p", { button: 2 })), false, "right click");
  assert.equal(await dispatch(clickOn("article p", { detail: 2 })), false, "the second of a double click");
  assert.equal(await dispatch(clickOn("article p", { detail: 0 })), false, "a keyboard-driven click");
});

test("links, buttons and editable text keep their own clicks", { skip }, async () => {
  const { page } = await read("article.html");
  const dispatch = await clickGate(page);

  await page.evaluate(`
    (() => {
      document.querySelector("article p").insertAdjacentHTML("afterend", \`
        <p id="probe-row">
          <a id="probe-link" href="#tide-tables">tide tables</a>
          <button id="probe-button">Subscribe</button>
          <input id="probe-input" value="email" />
          <span id="probe-editable" contenteditable="true">notes</span>
          <span id="probe-role" role="button">Expand</span>
          <span id="probe-text">ordinary words</span>
        </p>\`);
      return true;
    })()
  `);

  const click = (selector) => `
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: "center" });
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, button: 0, detail: 1,
        clientX: rect.left + 4, clientY: rect.top + 4,
      }));
      return true;
    })()
  `;

  assert.equal(await dispatch(click("#probe-link")), false, "a link");
  assert.equal(await dispatch(click("#probe-button")), false, "a button");
  assert.equal(await dispatch(click("#probe-input")), false, "a text field");
  assert.equal(await dispatch(click("#probe-editable")), false, "an editable region");
  assert.equal(await dispatch(click("#probe-role")), false, "role=button");
  assert.equal(await dispatch(click("#probe-text")), true, "ordinary words beside them");
});

test("a drag, and the click that ends a selection, are not jumps", { skip }, async () => {
  const { page } = await read("article.html");
  const dispatch = await clickGate(page);

  const drag = `
    (() => {
      const element = document.querySelector("article p");
      element.scrollIntoView({ block: "center" });
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, clientX: rect.left + 10, clientY: rect.top + 5,
      }));
      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, button: 0, detail: 1,
        clientX: rect.left + 140, clientY: rect.top + 5,
      }));
      return true;
    })()
  `;
  assert.equal(await dispatch(drag), false, "a press that travelled before releasing");

  const afterSelection = `
    (() => {
      const element = document.querySelector("article p");
      element.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, clientX: rect.left + 10, clientY: rect.top + 5,
      }));
      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, button: 0, detail: 1,
        clientX: rect.left + 10, clientY: rect.top + 5,
      }));
      return true;
    })()
  `;
  assert.equal(await dispatch(afterSelection), false, "a click that leaves a selection behind");
});
