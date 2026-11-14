import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Browser, contentBundle, findChrome, fixtureUrl } from "./headless.js";

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

/** Loads a fixture with the content scripts already injected. */
async function read(fixture) {
  const page = await browser.open(fixtureUrl(fixture), contentBundle());
  pages.push(page);
  return {
    page,
    extract: (scope = "page", options = {}) =>
      page.evaluate(`
        (() => {
          const doc = globalThis.__readAloud.extract.extract(
            ${JSON.stringify(scope)},
            ${JSON.stringify(options)},
          );
          return doc ? { text: doc.text, scope: doc.scope } : null;
        })()
      `),
    mainTag: () =>
      page.evaluate(`
        (() => {
          const root = globalThis.__readAloud.extract.findMainContent();
          if (!root) return null;
          return root.tagName + (root.dataset?.route ? "[" + root.dataset.route + "]" : "");
        })()
      `),
  };
}

test("reads the entry a router left on screen, not the hidden route behind it", { skip }, async () => {
  const { extract, mainTag } = await read("app-router-changelog.html");

  assert.equal(await mainTag(), "ARTICLE", "should root on the rendered entry");

  const doc = await extract();
  assert.ok(doc, "whole-page extraction returned nothing");
  assert.equal(doc.scope, "page");
  assert.ok(
    doc.text.includes("two assistants for the last mile of shipping code"),
    "the entry's opening paragraph is missing",
  );
  assert.ok(doc.text.includes("reporting change health per environment"));
  assert.ok(doc.text.length > 1000, `only ${doc.text.length} characters were extracted`);
});

test("a display: contents wrapper does not hide the prose under it", { skip }, async () => {
  const { page, extract } = await read("app-router-changelog.html");

  const display = await page.evaluate(
    `getComputedStyle(document.querySelector(".layout-passthrough")).display`,
  );
  assert.equal(display, "contents", "fixture no longer exercises the box-less wrapper");

  const doc = await extract();
  // Everything in the entry below the wrapper, including the last paragraph.
  assert.ok(doc.text.includes("Both assistants are off by default"));
});

test("the article's own title is read, unlike site furniture", { skip }, async () => {
  const { extract } = await read("app-router-changelog.html");
  const doc = await extract();

  assert.ok(doc.text.includes("Shipping rollouts and review"), "the <h1> in the entry header was dropped");
  assert.ok(!doc.text.includes("Site header"), "site header leaked in");
  assert.ok(!doc.text.includes("Navigation:"), "navigation leaked in");
  assert.ok(!doc.text.includes("Footer:"), "footer leaked in");
});

test("text left behind by the previous route is never read", { skip }, async () => {
  const { extract } = await read("app-router-changelog.html");
  const doc = await extract();

  assert.ok(!doc.text.includes("Stale index"), "hidden previous route leaked in");
  assert.ok(!doc.text.includes("Workspaces group the projects"));
});

test("hidden paragraphs and code blocks stay unread", { skip }, async () => {
  const { extract } = await read("app-router-changelog.html");
  const doc = await extract();

  assert.ok(!doc.text.includes("Hidden paragraph"), "display:none text leaked in");
  assert.ok(!doc.text.includes("telemetry: provider-of-choice"), "a code block leaked in");
});

test("falls back to the visible body when the chosen container is nearly empty", { skip }, async () => {
  const { extract, mainTag } = await read("empty-container.html");

  assert.equal(await mainTag(), "MAIN", "the decoy landmark should win the scoring");

  const doc = await extract();
  assert.ok(doc, "fallback produced nothing");
  assert.ok(doc.text.includes("A rope ferry crosses a river without an engine"));
  assert.ok(doc.text.includes("The cable is the whole machine"));
  assert.ok(doc.text.length > 600, `only ${doc.text.length} characters were extracted`);
  assert.ok(!doc.text.includes("Get the notebook by email"), "the signup form leaked in");
});

test("the body fallback still drops navigation, header, aside and footer", { skip }, async () => {
  const { extract } = await read("empty-container.html");
  const doc = await extract();

  assert.ok(!doc.text.includes("Navigation:"));
  assert.ok(!doc.text.includes("Site header:"));
  assert.ok(!doc.text.includes("Sidebar:"));
  assert.ok(!doc.text.includes("Footer:"));
  assert.ok(!doc.text.includes("Hidden note"));
});

test("a sidebar inside the article is still a sidebar", { skip }, async () => {
  const { page, extract } = await read("article.html");

  assert.ok(
    await page.evaluate(`Boolean(document.querySelector("article aside"))`),
    "fixture no longer has an aside inside the article",
  );

  const doc = await extract();
  assert.ok(doc.text.includes("How tide mills turned the sea into flour"), "the title was dropped");
  assert.ok(doc.text.includes("A tide mill is a water mill"));
  assert.ok(!doc.text.includes("Sidebar:"), "an in-article aside was read");
  assert.ok(!doc.text.includes("Navigation:"));
  assert.ok(!doc.text.includes("Footer:"));
  assert.ok(!doc.text.includes("display none and must never be read"));
});

test("code written into a sentence is read as part of it", { skip }, async () => {
  const { extract } = await read("inline-code.html");
  const doc = await extract();

  // The whole clause, not just the word: a sentence that lost its subject
  // still reads as a sentence, which is what makes dropping it so quiet.
  assert.ok(
    doc.text.includes("Set autoCommit to false before the first nightly run"),
    "inline code was dropped out of the sentence around it",
  );
  assert.ok(doc.text.includes("lives in build.config.json at the root"), "an inline file name was dropped");
  assert.ok(doc.text.includes("Pass --dry-run the first time"), "an inline flag was dropped");
});

test("whole snippets are left out by default", { skip }, async () => {
  const { extract } = await read("inline-code.html");
  const doc = await extract();

  assert.ok(!doc.text.includes("scheduleCron"), "a <pre> code block was read");
  assert.ok(!doc.text.includes("timeoutMinutes"), "a <pre> code block was read");
  assert.ok(!doc.text.includes("rotateSecrets"), "a <code> laid out as a block was read");
});

test("a <code> the page lays out as a block is a snippet, whatever the tag says", { skip }, async () => {
  const { page } = await read("inline-code.html");

  const [inline, block] = await page.evaluate(`
    (() => {
      const { isCodeBlock } = globalThis.__readAloud.extract;
      const first = document.querySelector("article p code");
      const snippet = document.querySelector("code.snippet");
      return [isCodeBlock(first), isCodeBlock(snippet)];
    })()
  `);
  assert.equal(inline, false, "code in the run of a sentence was called a block");
  assert.equal(block, true, "a display:block <code> was called inline");
});

test("the setting reads the snippets too", { skip }, async () => {
  const { extract } = await read("inline-code.html");
  const doc = await extract("page", { readCodeBlocks: true });

  assert.ok(doc.text.includes("scheduleCron"), "the <pre> block was still skipped");
  assert.ok(doc.text.includes("rotateSecrets"), "the block-laid-out <code> was still skipped");
  assert.ok(doc.text.includes("Set autoCommit to false"), "the prose went missing with the setting on");
});

test("a selection of nothing but a snippet is read anyway", { skip }, async () => {
  const { page, extract } = await read("inline-code.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("pre"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  // Silence is not an answer to text the user picked out and pressed read on.
  const doc = await extract("selection");
  assert.ok(doc, "a selected code block extracted to nothing");
  assert.equal(doc.scope, "selection");
  assert.ok(doc.text.includes("scheduleCron"));
});

test("a selection around a snippet still drops it", { skip }, async () => {
  const { page, extract } = await read("inline-code.html");

  await page.evaluate(`
    (() => {
      const paragraphs = document.querySelectorAll("article p");
      const range = document.createRange();
      range.setStart(paragraphs[1], 0);
      range.setEnd(paragraphs[2], paragraphs[2].childNodes.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc.text.includes("lives in build.config.json"), "the prose either side was dropped");
  assert.ok(doc.text.includes("Pass --dry-run"), "the prose either side was dropped");
  assert.ok(!doc.text.includes("scheduleCron"), "the snippet between them was read");
});

test("text hidden from view is left out, including labels kept for assistive technology", { skip }, async () => {
  const { extract } = await read("visually-hidden.html");
  const doc = await extract();

  assert.ok(doc, "whole-page extraction returned nothing");
  assert.ok(doc.text.includes("How a mill pond holds the tide"), "the title was dropped");
  assert.ok(
    doc.text.includes("The wheel turns the stone for as long as the pond lasts"),
    "hiding a label inside a sentence glued the words, or dropped them",
  );
  assert.ok(doc.text.includes("through a boxless wrapper"), "a display:contents wrapper hid its text");
  assert.ok(doc.text.includes("hangs twelve pixels off the edge"), "a slight overlap was treated as off the page");
  assert.ok(doc.text.includes("Dimmed to forty percent"), "partial opacity was treated as hidden");
  assert.ok(
    doc.text.includes("including the words past the second line"),
    "a line clamp dropped the text past the painted lines",
  );
  assert.ok(doc.text.includes("Fixed bar still on screen"), "a fixed bar on screen was dropped");
  assert.ok(doc.text.includes("Overflows its one pixel box"), "text overflowing a one-pixel box was dropped");
  assert.ok(doc.text.includes("An absolutely positioned note at the top"), "a positioned note on the page was dropped");
  assert.ok(
    doc.text.includes("This paragraph sits below the fold"),
    "text below the fold was treated as hidden",
  );
  assert.ok(doc.text.includes("Millers slept in shifts"), "the body of the article was dropped");

  const hidden = [
    "Skip to the mill pond",
    "Back to the top link",
    "Clip rect hides this label",
    "Open the mill menu",
    "One pixel clipped label",
    "Inset hides this label",
    "Inset slit hides this label",
    "Circle hides this label",
    "Parked off the page",
    "Fixed jump label",
    "Transparent paragraph about boilers",
    "Transparent parent hides the note",
    "Content visibility hidden stays unread",
    "Navigation: site furniture",
    "Footer:",
  ];
  for (const phrase of hidden) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read`);
  }
});

test("text scrolled out of the window is still read", { skip }, async () => {
  const { page, extract } = await read("visually-hidden.html");

  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  const doc = await extract();

  assert.ok(
    doc.text.includes("An absolutely positioned note at the top"),
    "scrolling away from a positioned note dropped it",
  );
  assert.ok(doc.text.includes("This paragraph sits below the fold"), "the paragraph now on screen was dropped");
  assert.ok(!doc.text.includes("Parked off the page"), "scrolling brought an off-page label into the read");
  assert.ok(!doc.text.includes("Fixed jump label"), "a fixed label parked off the viewport was read");
});

test("citation markers are left out of the sentence they interrupt", { skip }, async () => {
  const { extract } = await read("citations.html");
  const doc = await extract();

  assert.ok(doc, "whole-page extraction returned nothing");
  const kept = [
    "The wheel turns for as long as the pond holds water.",
    "A second gate lets the tide out, and a third is rarely used.",
    "Two sources agree that the pond lasts three hours.",
    "It drains the water, and then it waits.",
    "The pond lasts until the gate opens.",
    "The relation E = mc2 is not a footnote, and the 1st of May is a date.",
    "An asterisk and a dagger mark the older notes in the margin.",
    "See the pond section for the drawing",
    "mill catalogue",
    "[edit] stays, because those letters are a word.",
    "The pond held three hours of water.",
    "The second gate faces the sea.",
    "Families who lived beside the pond",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  const dropped = ["[1]", "[note 3]", "[4]", "[5]", "[6]", "[7]", "pondlasts", "water ,", "gate2"];
  for (const phrase of dropped) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }
  assert.ok(!doc.text.includes("^"), "a backlink caret was read");
  assert.ok(!doc.text.includes("↑"), "a backlink arrow was read");
  assert.ok(!doc.text.includes("Navigation: mill index"), "navigation leaked in");
  assert.ok(!doc.text.includes("Footer:"), "footer leaked in");
});

test("a word beside a citation still maps back to that word", { skip }, async () => {
  const { page } = await read("citations.html");

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const doc = extract.extract("page");
      const word = (needle, say = needle) => {
        const at = doc.text.indexOf(needle);
        const range = at < 0 ? null : extract.rangeFor(doc, at, at + say.length);
        const parent = range && range.startContainer.parentElement;
        return { at, spoken: range ? range.toString() : "", parent: parent ? parent.tagName : "" };
      };
      // "lasts until" is the word the mark was glued to. The earlier "lasts"
      // already had a space of its own.
      return { turns: word("turns"), lasts: word("lasts until", "lasts") };
    })()
  `);

  assert.ok(mapped.turns.at >= 0, "turns was not in the extracted text");
  assert.equal(mapped.turns.spoken, "turns");
  assert.equal(mapped.turns.parent, "P", "the word after a marker was mapped onto the marker");
  assert.equal(mapped.lasts.spoken, "lasts");
  assert.equal(mapped.lasts.parent, "P", "the word glued to a marker was mapped onto the marker");
});

test("a selection of nothing but a citation marker is read anyway", { skip }, async () => {
  const { page, extract } = await read("citations.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("marker-1"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc, "a selected citation marker extracted to nothing");
  assert.equal(doc.scope, "selection");
  assert.ok(doc.text.includes("[1]"), "the marker the user selected was dropped");
});

test("a selection around a citation marker still drops it", { skip }, async () => {
  const { page, extract } = await read("citations.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("opening"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc.text.includes("The wheel turns for as long as the pond holds water."));
  assert.ok(!doc.text.includes("[1]"), "the marker inside the selection was read");
});

test("a selection is read wherever it is, including inside page furniture", { skip }, async () => {
  const { page, extract } = await read("empty-container.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("aside"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc, "selection extraction returned nothing");
  assert.equal(doc.scope, "selection");
  assert.ok(doc.text.includes("Related notes on chain ferries"));
});
