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
