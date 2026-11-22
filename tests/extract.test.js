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

test("a space between inline elements is kept, and a line break is a break", { skip }, async () => {
  const { extract } = await read("spaces.html");
  const doc = await extract();

  assert.ok(doc, "whole-page extraction returned nothing");
  const kept = [
    "The wheel turns only while the pond holds water.",
    "The miller sleeps lightly near the wheel.",
    "The pond and the wheel are the whole machine.",
    "See the gate and the marks cut into the wall.",
    "It stores 20 km of head and lifts 12 kg.",
    "The account ends here. The next thought is a separate sentence.",
    "extraordinary",
    "The compound tide mill is two words, and millpond is one.",
    "Line one\nLine two stays on its own line.",
    "Wrapped one\nWrapped two stays on its own line.",
    "Keep together please, this is one line.",
    "Stay together on this line as well.",
    "First line\nSecond line of the separator.",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  assert.ok(doc.text.includes("\u200D"), "a zero-width joiner inside an emoji was dropped");
  const absent = ["\u00A0", "\u00AD", "\u200B", "\u200E", "\u2028", "onlywhile", "pondand", "20km", "Line oneLine", "sleeps\nlightly"];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }
  assert.ok(!doc.text.includes("Hidden boilers"), "a hidden paragraph was read");
  assert.ok(!doc.text.includes("Navigation:"), "navigation leaked in");
  assert.ok(!doc.text.includes("Footer:"), "footer leaked in");
});

test("a soft hyphen stays in the page and out of the spoken word", { skip }, async () => {
  const { page } = await read("spaces.html");

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const doc = extract.extract("page");
      const at = doc.text.indexOf("extraordinary");
      const range = at < 0 ? null : extract.rangeFor(doc, at, at + "extraordinary".length);
      const whileAt = doc.text.indexOf("while");
      const whileRange = whileAt < 0 ? null : extract.rangeFor(doc, whileAt, whileAt + "while".length);
      const kmAt = doc.text.indexOf("km");
      const kmRange = kmAt < 0 ? null : extract.rangeFor(doc, kmAt, kmAt + "km".length);
      return {
        spoken: range ? range.toString() : "",
        whileParent: whileRange ? whileRange.startContainer.parentElement.tagName : "",
        kmParent: kmRange ? kmRange.startContainer.parentElement.tagName : "",
      };
    })()
  `);

  assert.equal(mapped.spoken, "extra\u00ADordinary");
  assert.equal(mapped.whileParent, "EM", "the word after a space of its own was glued to the one before");
  assert.equal(mapped.kmParent, "SPAN", "a no-break space glued the unit to the number");
});

test("a line break ends the sentence, and a no-break space does not swallow the next one", { skip }, async () => {
  const page = await browser.open(fixtureUrl("spaces.html"), contentBundle(["util.js", "extract.js", "align.js"]));
  pages.push(page);

  const spoken = await page.evaluate(`
    (() => {
      const ns = globalThis.__readAloud;
      const doc = ns.extract.extract("page");
      return ns.align.sentences(doc.text).map((span) => doc.text.slice(span.start, span.end).trim());
    })()
  `);

  assert.ok(spoken.includes("Line one"));
  assert.ok(spoken.includes("Line two stays on its own line."));
  assert.ok(spoken.includes("The account ends here."));
  assert.ok(spoken.includes("The next thought is a separate sentence."));
  assert.ok(spoken.includes("The miller sleeps lightly near the wheel."));
});

test("a selection across a space of its own keeps the space", { skip }, async () => {
  const { page, extract } = await read("spaces.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("emphasis"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc, "the selection extracted to nothing");
  assert.equal(doc.scope, "selection");
  assert.ok(doc.text.includes("only while"));
  assert.ok(!doc.text.includes("onlywhile"));
});

test("a formula is read once, from the copy on the screen", { skip }, async () => {
  const { extract } = await read("formulas.html");
  const doc = await extract();

  assert.ok(doc, "whole-page extraction returned nothing");
  const kept = [
    "The relation E=mc2 holds for the wheel.",
    "Power is P = F v when the gate is open.",
    "Area is A=πr of the pond.",
    "The old drawing h = 3 is an image.",
    "Native a+b stays visible.",
    "Doubled x once.",
    "See a+b beside the mill",
    "A mark y=x sits beside the formula.",
    "Before the block.\nF=ma\nAfter the block.",
    "The pond stores the tide",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  assert.equal(doc.text.split("E=mc2").length - 1, 1, `the formula was read more than once\n---\n${doc.text}`);
  assert.equal(doc.text.split("a+b").length - 1, 2, `a visible formula was read twice or dropped\n---\n${doc.text}`);
  const dropped = [
    "E=mc^2",
    "TEXSOURCE",
    "h=3",
    "svg title of the area",
    "the mill at dusk",
    "q=9",
    "z=0",
    "Skip to the formula",
    "Navigation:",
    "Footer:",
    "P=Fv",
    "Doubled x x",
    "mark *",
  ];
  for (const phrase of dropped) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }
});

test("a formula is highlighted on the drawing the page shows", { skip }, async () => {
  const { page } = await read("formulas.html");

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const doc = extract.extract("page");
      const hit = (selector) => {
        const el = document.querySelector(selector);
        el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        return extract.charIndexFromPoint(doc, rect.left + rect.width / 2, rect.top + rect.height / 2);
      };
      const word = (needle) => {
        const at = doc.text.indexOf(needle);
        const range = at < 0 ? null : extract.rangeFor(doc, at, at + needle.length);
        let node = range && range.startContainer;
        if (node && node.nodeType === Node.ELEMENT_NODE && node.childNodes[range.startOffset]?.nodeType === Node.ELEMENT_NODE) {
          node = node.childNodes[range.startOffset];
        } else if (node && node.nodeType !== Node.ELEMENT_NODE) {
          node = node.parentElement;
        }
        const box = node && node.closest("svg, img, .katex-html, .katex-mathml, mjx-math");
        return {
          at,
          spoken: range ? range.toString().replace(/\\s+/g, "") : "",
          box: box ? box.tagName + (box.className && box.className.baseVal === undefined ? "." + String(box.className).split(" ")[0] : "") : "",
          width: range ? Math.round(range.getBoundingClientRect().width) : 0,
        };
      };
      return {
        katex: word("E=mc2"),
        letter: word("E"),
        svg: word("A=πr"),
        image: word("h = 3"),
        svgHit: hit("mjx-container[jax=SVG] svg"),
        imageHit: hit("#img-sentence img"),
      };
    })()
  `);

  assert.equal(mapped.katex.box, "SPAN.katex-html", `the formula was mapped onto ${mapped.katex.box}`);
  assert.ok(mapped.katex.spoken.includes("E=mc2"), "the highlighted formula was not the one on screen");
  assert.equal(mapped.letter.box, "SPAN.katex-html", "a letter of the formula was mapped onto the hidden copy");
  assert.equal(mapped.svg.box, "svg", `the path formula was mapped onto ${mapped.svg.box}`);
  assert.ok(mapped.svg.width >= 60, "the path formula was highlighted as a clipped pixel");
  assert.equal(mapped.image.box, "IMG.formula-img", `the image formula was mapped onto ${mapped.image.box}`);
  assert.ok(mapped.image.width >= 40, "the image formula was highlighted as nothing");

  const text = await page.evaluate(`globalThis.__readAloud.extract.extract("page").text`);
  assert.equal(text.slice(mapped.svgHit, mapped.svgHit + 4), "A=πr", "a click on the drawing missed the formula");
  assert.equal(text.slice(mapped.imageHit, mapped.imageHit + 5), "h = 3", "a click on the image missed its alt");
});

test("a selection of the on-screen formula reads that copy", { skip }, async () => {
  const { page, extract } = await read("formulas.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#katex-sentence .katex-html"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc, "a selected formula extracted to nothing");
  assert.equal(doc.scope, "selection");
  assert.ok(doc.text.includes("E=mc2"), "the formula on screen was dropped");
  assert.ok(!doc.text.includes("E=mc^2"), "the hidden TeX source was read with the selection");
});

test("a closed disclosure is left folded, and its summary is read", { skip }, async () => {
  const { extract } = await read("details.html");
  const doc = await extract();

  assert.ok(doc, "whole-page extraction returned nothing");
  const kept = [
    "How a mill pond holds the tide",
    "the miller watches the gate.\nHow the gate works",
    "How the gate works\nWhat stays open",
    "What stays open\nThe open answer describes the head race and the wheel.",
    "The open contents phrase stays in the sentence.",
    "The open relation E=mc2 is on the page.",
    "is on the page.\nNested gate",
    "Nested gate\nExclusive gate one",
    "Exclusive gate one\nExclusive gate two",
    "Exclusive open answer about the second pond.",
    "still read in full, including the words past the second line.",
    "Millers slept in shifts",
    "This paragraph sits below the fold and is still part of the page.",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  const absent = [
    "Folded loose words",
    "folded answer explains the sluice",
    "Q=ir",
    "Q=ir-tex",
    "E=mc^2",
    "stays shut",
    "A second label",
    "Folded contents phrase",
    "nested folded answer",
    "Exclusive folded answer",
    "No summary element",
    "Navigation:",
    "Footer:",
  ];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }
  assert.equal(doc.text.split("E=mc2").length - 1, 1, `the open formula was read more than once\n---\n${doc.text}`);
});

test("a closed disclosure's summary is highlighted on the summary", { skip }, async () => {
  const { page } = await read("details.html");

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const doc = extract.extract("page");
      const at = doc.text.indexOf("How the gate works");
      const range = at < 0 ? null : extract.rangeFor(doc, at, at + "How the gate works".length);
      const openAt = doc.text.indexOf("head race");
      const openRange = openAt < 0 ? null : extract.rangeFor(doc, openAt, openAt + "head race".length);
      return {
        summary: range ? range.startContainer.parentElement.closest("summary").id : "",
        spoken: range ? range.toString().replace(/\\s+/g, " ") : "",
        answer: openRange ? openRange.startContainer.parentElement.closest("p").id : "",
      };
    })()
  `);

  assert.equal(mapped.summary, "closed-summary");
  assert.equal(mapped.spoken, "How the gate works");
  assert.equal(mapped.answer, "open-answer");
});

test("a selection inside an open disclosure is read, and a folded one is not", { skip }, async () => {
  const { page, extract } = await read("details.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("open-answer"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const open = await extract("selection");
  assert.ok(open, "the open answer extracted to nothing");
  assert.equal(open.scope, "selection");
  assert.ok(open.text.includes("head race and the wheel"));

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("closed-answer"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const folded = await extract("selection");
  assert.equal(folded, null);
});

test("a box collapsed to nothing is left shut, and the text around it is read", { skip }, async () => {
  const { extract } = await read("collapsed.html");
  const doc = await extract();

  assert.ok(doc, "whole-page extraction returned nothing");
  const kept = [
    "How a mill pond holds the tide",
    "How the gate works\nThe pond lasts until the next tide.",
    "What stays open\nThe open answer describes the head race and the wheel.",
    "The wheel turns for as long as the pond lasts.",
    "through an inline box",
    "through a boxless wrapper",
    "A paragraph that clips its overflow and is still read in full.",
    "including the words past the painted edge",
    "First line of the scrollport stays.",
    "Scrolled out line of the scrollport stays too.",
    "Fixed bar still on screen.",
    "Absolute note outside a static box.",
    "The open relation E=mc2 is on the page.",
    "still read in full, including the words past the second line.",
    "Millers slept in shifts",
    "This paragraph sits below the fold and is still part of the page.",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  const absent = [
    "Folded loose words",
    "folded answer explains the sluice",
    "Height zero answer",
    "Clip answer about the wheel",
    "Vertical clip answer",
    "Drawer answer",
    "Grid answer",
    "Sticky line",
    "secretly",
    "turnsfor",
    "Fixed bar inside a transformed box",
    "Fixed bar behind a filter",
    "Absolute note inside a positioned box",
    "nested folded answer",
    "Q=ir",
    "Q=ir-tex",
    "E=mc^2",
    "Navigation:",
    "Footer:",
  ];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }
  assert.equal(doc.text.split("E=mc2").length - 1, 1, `the open formula was read more than once\n---\n${doc.text}`);
});

test("a word beside a collapsed box still maps back to that word", { skip }, async () => {
  const { page } = await read("collapsed.html");

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const doc = extract.extract("page");
      const at = (needle) => {
        const index = doc.text.indexOf(needle);
        const range = index < 0 ? null : extract.rangeFor(doc, index, index + needle.length);
        const parent = range && range.startContainer.parentElement;
        return {
          spoken: range ? range.toString() : "",
          id: parent ? parent.id : "",
          tag: parent ? parent.tagName : "",
        };
      };
      const sentence = doc.text.indexOf("for as long as the pond lasts");
      const lastsAt = sentence < 0 ? -1 : sentence + "for as long as the pond ".length;
      const lastsRange = lastsAt < 0 ? null : extract.rangeFor(doc, lastsAt, lastsAt + "lasts".length);
      const lastsParent = lastsRange && lastsRange.startContainer.parentElement;
      return {
        lasts: {
          spoken: lastsRange ? lastsRange.toString() : "",
          tag: lastsParent ? lastsParent.tagName : "",
        },
        bar: at("Fixed bar still on screen."),
        open: at("head race"),
      };
    })()
  `);

  assert.equal(mapped.lasts.spoken, "lasts");
  assert.equal(mapped.lasts.tag, "P", "the word after a collapsed box was mapped onto the box");
  assert.equal(mapped.bar.id, "fixed-bar");
  assert.equal(mapped.bar.spoken, "Fixed bar still on screen.");
  assert.equal(mapped.open.id, "open-answer");
});

test("opening a collapsed box reads the answer it was holding", { skip }, async () => {
  const { page, extract } = await read("collapsed.html");

  const shut = await extract();
  assert.ok(!shut.text.includes("folded answer explains the sluice"));

  await page.evaluate(`document.getElementById("shut-max").style.maxHeight = "none"`);
  const open = await extract();
  assert.ok(open.text.includes("The folded answer explains the sluice and the penstock."));
  assert.ok(open.text.includes("Folded loose words about the rack."));
  assert.ok(!open.text.includes("Q=ir-tex"), "opening the box read the formula's TeX source");
  assert.equal(open.text.split("Q=ir").length - 1, 1, "the folded formula was not read once it was open");
});

test("a selection inside a collapsed box reads only what the page still paints", { skip }, async () => {
  const { page, extract } = await read("collapsed.html");

  const select = async (id) => {
    await page.evaluate(`
      (() => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(${JSON.stringify(id)}));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()
    `);
    return extract("selection");
  };

  assert.equal(await select("shut-answer"), null);
  assert.equal(await select("abs-in"), null);

  const open = await select("open-answer");
  assert.ok(open, "the open answer extracted to nothing");
  assert.equal(open.scope, "selection");
  assert.ok(open.text.includes("head race and the wheel"));

  const bar = await select("fixed-bar");
  assert.ok(bar, "the fixed bar extracted to nothing");
  assert.ok(bar.text.includes("Fixed bar still on screen."));

  const note = await select("abs-out");
  assert.ok(note, "the absolute note extracted to nothing");
  assert.ok(note.text.includes("Absolute note outside a static box."));

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("inline-sentence"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);
  const around = await extract("selection");
  assert.ok(around.text.includes("The wheel turns for as long as the pond lasts."));
  assert.ok(!around.text.includes("secretly"), "the collapsed word inside the selection was read");
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

test("landmark roles are left out, and the article around them is read", { skip }, async () => {
  const { page, extract, mainTag } = await read("landmarks.html");

  assert.equal(await mainTag(), "ARTICLE", "the article should be the content root");

  const doc = await extract();
  assert.ok(doc, "whole-page extraction returned nothing");

  const kept = [
    "How a harbour keeps its tide",
    "Article masthead: the pond in March.",
    "A harbour mill holds the tide behind a gate",
    "The wheel turns for as long as the pond lasts.",
    "Region note: the gate is oak and iron.",
    "Region first: the sluice was rebuilt in oak.",
    "Note: the hours drift by fifty minutes a day.",
    "Presentation: the wheel is six feet across.",
    "Article header: the pond in April.",
    "Families who lived beside the pond",
    "There is only a gate, a pond, and a wheel",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  const absent = [
    "Site banner:",
    "Site navigation:",
    "Masthead navigation:",
    "Breadcrumb:",
    "Search the notes",
    "turnsfor",
    "Capital navigation:",
    "Menu list:",
    "Related:",
    "Contents sidebar:",
    "Search landmark:",
    "Content info:",
    "Form:",
    "Dialog:",
    "Alert:",
    "Header nav:",
    "Footer landmark:",
    "Footer:",
  ];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const built = extract.extract("page");
      const at = built.text.indexOf("for as long as the pond lasts");
      const range = at < 0 ? null : extract.rangeFor(built, at, at + "for".length);
      const parent = range && range.startContainer.parentElement;
      return { spoken: range ? range.toString() : "", id: parent ? parent.id : "" };
    })()
  `);
  assert.equal(mapped.spoken, "for");
  assert.equal(mapped.id, "around", "the word after an inline landmark was mapped onto the landmark");
});

test("a selection of a landmark is read, including one inside a sentence", { skip }, async () => {
  const { page, extract } = await read("landmarks.html");

  const select = async (id) => {
    await page.evaluate(`
      (() => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(${JSON.stringify(id)}));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()
    `);
    return extract("selection");
  };

  const only = await select("breadcrumb");
  assert.ok(only, "a selected landmark extracted to nothing");
  assert.equal(only.scope, "selection");
  assert.ok(only.text.includes("Breadcrumb: Home / Mills / Pond."));

  const around = await select("around");
  assert.ok(
    around.text.includes("The wheel turns Search the notes for as long as the pond lasts."),
    `selection dropped the landmark\n---\n${around?.text}`,
  );
});

test("the body fallback drops furniture written as a landmark role", { skip }, async () => {
  const { extract, mainTag } = await read("landmark-page.html");

  assert.equal(await mainTag(), "BODY", "a container should not have won the scoring");

  const doc = await extract();
  assert.ok(doc, "body fallback produced nothing");
  assert.ok(doc.text.includes("A rope ferry crosses a river without an engine"));
  assert.ok(doc.text.includes("The cable is the whole machine"));
  assert.ok(doc.text.includes("Region note: the cable sags on purpose."));
  assert.ok(doc.text.length > 400, `only ${doc.text.length} characters were extracted`);

  const absent = [
    "Site banner:",
    "Navigation:",
    "Site header:",
    "Sidebar:",
    "Search the ferry notes",
    "Footer landmark:",
    "Footer:",
  ];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }
});

test("a ruby annotation is left out, and the word under it is read in order", { skip }, async () => {
  const { page, extract } = await read("ruby.html");

  const rpDisplay = await page.evaluate(`getComputedStyle(document.querySelector("rp")).display`);
  assert.equal(rpDisplay, "inline", "the parentheses are no longer on the page, so the tag is not what hides them");

  const doc = await extract();
  assert.ok(doc, "whole-page extraction returned nothing");

  const kept = [
    "How a mill pond holds the tide",
    "The gate is marked 漢字 in the ledger.",
    "She said 明日 we leave.",
    "See the WWW note in the margin.",
    "A 漢字 through a boxless wrapper.",
    "Before 漢字 after the mark.",
    "The wheel turns for as long as the pond lasts.",
    "Millers wrote the hours down",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  const absent = [
    "かん",
    "じ",
    "よみ",
    "あした",
    "World Wide Web",
    "(",
    ")",
    "Navigation:",
    "Footer:",
    "marked漢字",
    "漢字in",
    "said明日",
    "明日we",
    "theWWW",
    "WWWnote",
  ];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }
  assert.ok(!doc.text.includes("漢\n字"), `a break inside the reading split the word\n---\n${doc.text}`);

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const built = extract.extract("page");
      const at = (needle) => {
        const index = built.text.indexOf(needle);
        const range = index < 0 ? null : extract.rangeFor(built, index, index + needle.length);
        const parent = range && range.startContainer.parentElement;
        return {
          spoken: range ? range.toString() : "",
          id: parent ? parent.id : "",
          tag: parent ? parent.tagName : "",
        };
      };
      return { word: at("明日"), after: at("in the ledger") };
    })()
  `);
  assert.equal(mapped.word.spoken, "明日");
  assert.equal(mapped.word.id, "ashita", "the word was mapped onto its reading");
  assert.equal(mapped.after.tag, "P", "the words after a ruby were mapped onto the reading");
  assert.equal(mapped.after.id, "interleaved");
});

test("a selection of nothing but a ruby annotation is read anyway", { skip }, async () => {
  const { page, extract } = await read("ruby.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("www-reading"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc, "the annotation extracted to nothing");
  assert.equal(doc.scope, "selection");
  assert.equal(doc.text, "World Wide Web");
});

test("a selection around a ruby annotation still drops it", { skip }, async () => {
  const { page, extract } = await read("ruby.html");

  await page.evaluate(`
    (() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("group"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);

  const doc = await extract("selection");
  assert.ok(doc, "the selection extracted to nothing");
  assert.equal(doc.scope, "selection");
  assert.ok(doc.text.includes("She said 明日 we leave."));
  assert.ok(!doc.text.includes("あした"), "the reading inside the selection was read");
  assert.ok(!doc.text.includes("("), "the ruby parentheses inside the selection were read");
});

test("text an indent has pushed out of sight is left unread", { skip }, async () => {
  const { page, extract } = await read("indented.html");

  const displays = await page.evaluate(`
    (() => {
      const of = (selector) => getComputedStyle(document.querySelector(selector)).display;
      return { contents: of(".contents"), logo: of(".logo") };
    })()
  `);
  assert.equal(displays.contents, "contents", "fixture no longer exercises the boxless wrapper");
  assert.equal(displays.logo, "inline-block", "the logo is no longer its own block");

  const doc = await extract();
  assert.ok(doc, "whole-page extraction returned nothing");

  const kept = [
    "How a mill pond holds the tide",
    "The wheel turns for as long as the pond lasts.",
    "A label sits in the sentence.",
    "The framed note stays.",
    "Spilled indent stays visible beside its box.",
    "The hanging line starts early and is still the sentence.",
    "The first line is indented a little and the rest of the paragraph stays with it.",
    "The tail of the line still shows in the box.",
    "Alpha begins the indented paragraph and the lines under it stay on the page for the miller to read.",
    "Indented inside a scrollport and still read in full.",
    "Millers slept in shifts beside the wheel",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  const absent = [
    "Mill pond home",
    "Skip to the sluice",
    "Replaced heading words",
    "Opposite label stays unread",
    "Parked by a wide indent",
    "Framed label off to the side",
    "Secret",
    "Hidden inside a scrollport",
    "Navigation:",
    "Footer:",
    "turnsfor",
    "labelsits",
  ];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const built = extract.extract("page");
      const at = built.text.indexOf("for as long as the pond lasts");
      const range = at < 0 ? null : extract.rangeFor(built, at, at + "for".length);
      const parent = range && range.startContainer.parentElement;
      return { spoken: range ? range.toString() : "", id: parent ? parent.id : "" };
    })()
  `);
  assert.equal(mapped.spoken, "for");
  assert.equal(mapped.id, "opening", "the word after an indented label was mapped onto the label");
});

test("giving the indent a normal size reads the line it was hiding", { skip }, async () => {
  const { page, extract } = await read("indented.html");

  const hidden = await extract();
  assert.ok(!hidden.text.includes("Replaced heading words"));
  assert.ok(!hidden.text.includes("Parked by a wide indent"));

  await page.evaluate(`
    (() => {
      document.getElementById("full").style.textIndent = "0px";
      document.getElementById("offpage").style.textIndent = "0px";
      return true;
    })()
  `);

  const shown = await extract();
  assert.ok(shown.text.includes("Replaced heading words"), "clearing the indent left the heading unread");
  assert.ok(shown.text.includes("Parked by a wide indent"), "clearing the indent left the parked line unread");
  assert.ok(shown.text.includes("The wheel turns for as long as the pond lasts."));
  assert.ok(!shown.text.includes("Mill pond home"), "a different indent was cleared along with this one");
});

test("a selection of an indented label reads nothing, and one around it drops the label", { skip }, async () => {
  const { page, extract } = await read("indented.html");

  const select = async (id) => {
    await page.evaluate(`
      (() => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(${JSON.stringify(id)}));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()
    `);
    return extract("selection");
  };

  assert.equal(await select("full"), null);
  assert.equal(await select("offpage"), null);

  const around = await select("opening");
  assert.ok(around, "the sentence extracted to nothing");
  assert.equal(around.scope, "selection");
  assert.ok(around.text.includes("The wheel turns for as long as the pond lasts."));
  assert.ok(!around.text.includes("Mill pond home"), "the indented label inside the selection was read");
});

test("text the page has marked inert is left unread, and the article around it is read", { skip }, async () => {
  const { page, extract } = await read("inert.html");

  const setup = await page.evaluate(`
    (() => {
      const decoy = document.getElementById("decoy");
      const real = document.getElementById("real");
      const style = getComputedStyle(decoy);
      return {
        id: globalThis.__readAloud.extract.findMainContent()?.id ?? "",
        display: style.display,
        ariaHidden: decoy.getAttribute("aria-hidden"),
        inert: decoy.hasAttribute("inert"),
        decoyChars: decoy.textContent.length,
        realChars: real.textContent.length,
      };
    })()
  `);
  assert.equal(setup.display, "block", "the decoy article is no longer painted");
  assert.equal(setup.ariaHidden, null, "the decoy is hidden by aria-hidden rather than by inert");
  assert.equal(setup.inert, true, "the decoy article is no longer inert");
  assert.ok(setup.decoyChars > setup.realChars, "the decoy no longer outruns the article on raw text");
  assert.equal(setup.id, "real", "an inert article was chosen over the one on screen");

  const doc = await extract();
  assert.ok(doc, "whole-page extraction returned nothing");

  const kept = [
    "How a mill pond holds the tide",
    "The wheel turns for as long as the pond lasts.",
    "A pond lasts the winter.",
    "Water, and then the wheel.",
    "The gate holds through the night.",
    "The wheel turns.\nThe pond refills.",
    "Passed the sentence stays one sentence.",
    "Kept beside the wheel.",
    "The visible slide is the one on screen.",
    "Before the panel.\nAfter the panel.",
    "The relation stays a sentence.",
    "Power is E=mc2 when the gate is open.",
    "The drawing stays a drawing.",
    "Fixed bar still on screen.",
    "including the words past the second line",
    "This paragraph sits below the fold",
    "Millers slept in turns",
  ];
  for (const phrase of kept) {
    assert.ok(doc.text.includes(phrase), `missing "${phrase}"\n---\n${doc.text}`);
  }

  const absent = [
    "Decoy slide",
    "held back label",
    "pondlasts",
    "pond held",
    "Water ,",
    "The gate\nholds",
    "shut",
    "through a held wrapper",
    "boxless held label",
    "The next slide is held",
    "The third slide is held",
    "eel traps",
    "nested inside the held",
    "Qx=9",
    "QXHELD",
    "E=mc^2",
    "h = 3",
    "Fixed bar inside a held panel",
    "Padded slide",
    "Navigation:",
    "Footer:",
    "turnsheld",
    "gatestays",
  ];
  for (const phrase of absent) {
    assert.ok(!doc.text.includes(phrase), `"${phrase}" was read\n---\n${doc.text}`);
  }

  assert.equal(doc.text.split("E=mc2").length - 1, 1, `the live formula was read more than once\n---\n${doc.text}`);

  const mapped = await page.evaluate(`
    (() => {
      const { extract } = globalThis.__readAloud;
      const built = extract.extract("page");
      const at = built.text.indexOf("lasts the winter");
      const range = at < 0 ? null : extract.rangeFor(built, at, at + "lasts".length);
      const parent = range && range.startContainer.parentElement;
      const held = document.getElementById("tight-held");
      held.scrollIntoView({ block: "center" });
      const rect = held.getBoundingClientRect();
      const hit = extract.charIndexFromPoint(built, rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { spoken: range ? range.toString() : "", id: parent ? parent.id : "", hit };
    })()
  `);
  assert.equal(mapped.spoken, "lasts");
  assert.equal(mapped.id, "tight", "the word after a held label was mapped onto the label");
  assert.equal(mapped.hit, -1, "a click on held text landed in the read");
});

test("taking inert off reads what the page was holding, including a formula", { skip }, async () => {
  const { page, extract } = await read("inert.html");

  const hidden = await extract();
  assert.ok(!hidden.text.includes("eel traps"));
  assert.ok(!hidden.text.includes("Qx=9"));
  assert.ok(!hidden.text.includes("The next slide is held"));

  await page.evaluate(`
    (() => {
      document.getElementById("panel").removeAttribute("inert");
      document.querySelector("#held-formula .katex").removeAttribute("inert");
      document.querySelector(".slides p[inert]").removeAttribute("inert");
      return true;
    })()
  `);

  const shown = await extract();
  assert.ok(shown.text.includes("The folded answer about eel traps stays unread until the panel is opened."));
  assert.ok(
    !shown.text.includes("nested inside the held"),
    "opening the outer panel read the nested one that is still inert",
  );
  assert.ok(shown.text.includes("The relation Qx=9 stays a sentence."), `formula was ${shown.text}`);
  assert.ok(!shown.text.includes("QXHELD"), "the TeX annotation of a shown formula was read");
  assert.ok(shown.text.includes("The next slide is held until it is shown."));
  assert.ok(!shown.text.includes("The third slide is held"), "a slide still marked inert was read");
  assert.ok(shown.text.includes("Before the panel."));
  assert.ok(shown.text.includes("After the panel."));
  assert.ok(!shown.text.includes("Decoy slide"), "clearing one inert attribute read the decoy article");
});

test("the article is still read when it is itself inert, and a selection of a held part is read", { skip }, async () => {
  const { page, extract } = await read("inert.html");

  await page.evaluate(`
    (() => {
      document.getElementById("decoy").remove();
      document.getElementById("real").setAttribute("inert", "");
      return true;
    })()
  `);

  const doc = await extract();
  assert.ok(doc, "an inert article extracted to nothing");
  assert.ok(doc.text.includes("How a mill pond holds the tide"), "marking the article inert dropped the page");
  assert.ok(doc.text.includes("Millers slept in turns"));
  assert.ok(!doc.text.includes("eel traps"), "a held panel inside an inert article was read");
  assert.ok(!doc.text.includes("Decoy slide"));

  const select = async (id) => {
    await page.evaluate(`
      (() => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(${JSON.stringify(id)}));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()
    `);
    return extract("selection");
  };

  const only = await select("panel");
  assert.ok(only, "a selection of the held panel extracted to nothing");
  assert.equal(only.scope, "selection");
  assert.ok(only.text.includes("eel traps"));
  assert.ok(!only.text.includes("nested inside the held"), "the nested held panel inside the selection was read");
  assert.ok(!only.text.includes("How a mill pond holds the tide"), "the selection spread to the whole page");

  const label = await select("tight-held");
  assert.ok(label, "a selection of the held label extracted to nothing");
  assert.equal(label.text, "held");

  const around = await select("tight");
  assert.ok(around, "the sentence extracted to nothing");
  assert.equal(around.scope, "selection");
  assert.ok(around.text.includes("A pond lasts the winter."));
  assert.ok(!around.text.includes("held"), "the held label inside the selection was read");
});

test("a box padded with inert text does not outscore the notes beside it", { skip }, async () => {
  const { page, extract } = await read("inert.html");

  const picked = await page.evaluate(`
    (() => {
      document.getElementById("decoy").remove();
      document.getElementById("real").remove();
      const pile = document.getElementById("pile");
      const padded = document.getElementById("padded");
      return {
        id: globalThis.__readAloud.extract.findMainContent()?.id ?? "",
        pileChars: pile.textContent.length,
        paddedChars: padded.textContent.length,
      };
    })()
  `);
  assert.ok(picked.paddedChars > picked.pileChars, "the padded box no longer holds more text");
  assert.equal(picked.id, "pile", "inert text inside a box was allowed to win the score");

  const doc = await extract();
  assert.ok(doc.text.includes("Pile one."));
  assert.ok(doc.text.includes("Pile three."));
  assert.ok(!doc.text.includes("Padded slide"), "the held slide was read with the notes");
  assert.ok(!doc.text.includes("Pad one."), "the padded box was chosen as the page");
});
