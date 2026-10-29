/**
 * Who the view belongs to while a page is being read.
 *
 * Two halves, tested two ways. The decision itself is arithmetic over one
 * boolean and runs against the module alone. Whether the spoken word is in the
 * band that decision turns on is a question about a laid-out page, so the last
 * tests put a real article in a real Chrome and measure it.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Browser, contentBundle, findChrome, fixtureUrl } from "./headless.js";
import { loadContentNamespace } from "./load-content.js";

const { createFollow, scrollsTheDocument } = loadContentNamespace(["util.js", "follow.js"]).follow;

/** An event target a test can both watch and fire at. */
function fakeTarget() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    removeEventListener(type, handler) {
      const at = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (at >= 0) listeners.splice(at, 1);
    },
    fire(type, event = {}) {
      for (const entry of [...listeners]) if (entry.type === type) entry.handler(event);
    },
  };
}

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------

test("a read follows the voice until something says otherwise", () => {
  const follow = createFollow();

  assert.equal(follow.following, true);
  assert.equal(follow.wants(false), true, "a word out of the band is a word to scroll to");
  assert.equal(follow.wants(true), true);
});

test("a listener who scrolls away keeps the view", () => {
  const follow = createFollow();
  follow.release();

  assert.equal(follow.following, false);
  assert.equal(follow.wants(false), false);
  assert.equal(follow.wants(false), false, "and keeps it as the read goes on without them");
  assert.equal(follow.wants(false), false);
});

test("the view comes back when the voice reaches where they scrolled to", () => {
  const follow = createFollow();
  follow.release();
  assert.equal(follow.wants(false), false);

  assert.equal(follow.wants(true), true, "the spoken word is back in the band");
  assert.equal(follow.following, true);
  assert.equal(follow.wants(false), true, "so the next word out of it is followed again");
});

test("asking for a place in the text takes the view back at once", () => {
  const follow = createFollow();
  follow.release();

  follow.claim();
  assert.equal(follow.following, true);
  assert.equal(follow.wants(false), true);
});

// ---------------------------------------------------------------------------
// What counts as the listener scrolling.
// ---------------------------------------------------------------------------

test("a wheel or a touch drag is the listener taking the view", () => {
  for (const type of ["wheel", "touchmove"]) {
    const follow = createFollow();
    const target = fakeTarget();
    follow.watch(target);

    target.fire(type, {});
    assert.equal(follow.following, false, type);
  }
});

test("the keys that scroll a document are too", () => {
  for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]) {
    const follow = createFollow();
    const target = fakeTarget();
    follow.watch(target);

    target.fire("keydown", { key, target: { tagName: "BODY" } });
    assert.equal(follow.following, false, key);
  }
});

test("keys that do not scroll are not", () => {
  const follow = createFollow();
  const target = fakeTarget();
  follow.watch(target);

  for (const key of ["a", "Enter", "Escape", "Shift", "F5", "Tab"]) {
    target.fire("keydown", { key, target: { tagName: "BODY" } });
    assert.equal(follow.following, true, key);
  }
});

test("a space typed into a field is a space, not a page down", () => {
  for (const target of [
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
  ]) {
    assert.equal(scrollsTheDocument({ key: " ", target }), false, target.tagName);
    assert.equal(scrollsTheDocument({ key: "ArrowDown", target }), false, target.tagName);
  }

  assert.equal(scrollsTheDocument({ key: " ", target: { tagName: "P" } }), true);
  assert.equal(scrollsTheDocument({ key: " ", target: null }), true, "no target is the document");
  assert.equal(scrollsTheDocument({}), false);
  assert.equal(scrollsTheDocument(undefined), false);
});

test("watching the page can never be why it scrolled slowly", () => {
  const target = fakeTarget();
  createFollow().watch(target);

  for (const type of ["wheel", "touchmove"]) {
    const entry = target.listeners.find((listener) => listener.type === type);
    assert.equal(entry.options.passive, true, `${type} must not be cancellable`);
    assert.equal(entry.options.capture, true, `${type} must be heard before the page can stop it`);
  }
});

test("a read that ends takes the reader out of the page's scroll path", () => {
  const follow = createFollow();
  const target = fakeTarget();
  const unwatch = follow.watch(target);
  assert.equal(target.listeners.length, 3);

  unwatch();
  assert.equal(target.listeners.length, 0);

  target.fire("wheel", {});
  assert.equal(follow.following, true, "nothing is listening, so nothing was taken");
});

// ---------------------------------------------------------------------------
// The band, against a page a browser has actually laid out.
// ---------------------------------------------------------------------------

const skip = findChrome() ? false : "no Chrome binary found (set CHROME_PATH to run these)";

let browser = null;
let page = null;

before(async () => {
  if (skip) return;
  browser = await Browser.launch();
  page = await browser.open(
    fixtureUrl("article.html"),
    contentBundle(["util.js", "extract.js", "highlight.js", "follow.js"]),
  );
  await page.evaluate(`
    (() => {
      const ns = globalThis.__readAloud;
      // Room above and below the article, so a word can be put anywhere in
      // the viewport. The fixture is one screen of prose; what is being
      // measured here is the band, not how far this page happens to scroll.
      document.body.style.padding = "100vh 0";
      window.doc = ns.extract.extract("page");

      /** A range over the first occurrence of \`needle\` in the text being read. */
      window.rangeFor = (needle) => {
        const start = window.doc.text.indexOf(needle);
        if (start < 0) throw new Error("no " + needle + " in the article");
        return ns.extract.rangeFor(window.doc, start, start + needle.length);
      };

      /** Puts \`needle\` at \`fraction\` of the way down the viewport. */
      window.put = (needle, fraction) => {
        const rect = window.rangeFor(needle).getBoundingClientRect();
        window.scrollBy({ top: rect.top - window.innerHeight * fraction });
        return Math.round(window.rangeFor(needle).getBoundingClientRect().top);
      };
      return true;
    })()
  `);
});

after(async () => {
  await page?.close().catch(() => {});
  browser?.close();
});

const evaluate = (expression) => page.evaluate(expression);

test("a word in the middle of the viewport is where a read keeps it", { skip }, async () => {
  await evaluate(`window.put("Millers slept", 0.4)`);
  assert.equal(await evaluate(`__readAloud.highlight.inBand(window.rangeFor("Millers slept"))`), true);
});

test("a word at either edge of the viewport is not", { skip }, async () => {
  await evaluate(`window.put("Millers slept", 0.05)`);
  assert.equal(
    await evaluate(`__readAloud.highlight.inBand(window.rangeFor("Millers slept"))`),
    false,
    "too close to the top",
  );

  await evaluate(`window.put("Millers slept", 0.9)`);
  assert.equal(
    await evaluate(`__readAloud.highlight.inBand(window.rangeFor("Millers slept"))`),
    false,
    "too close to the bottom",
  );
});

test("a word nothing has laid out is in no band at all", { skip }, async () => {
  assert.equal(await evaluate(`__readAloud.highlight.inBand(null)`), false);
  assert.equal(await evaluate(`__readAloud.highlight.inBand(document.createRange())`), false);
});

test("the band is what a following read scrolls on, and nothing else", { skip }, async () => {
  // In the band: the read leaves the view alone, whoever put it there.
  await evaluate(`window.put("Millers slept", 0.4)`);
  const settled = await evaluate(`
    (async () => {
      const before = Math.round(window.scrollY);
      __readAloud.highlight.scrollTo(window.rangeFor("Millers slept"));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { before, after: Math.round(window.scrollY) };
    })()
  `);
  assert.equal(settled.after, settled.before, "a word already in the band is not scrolled to");

  // Out of it: the read brings it back, and lands it inside the band.
  await evaluate(`window.put("Millers slept", 0.95)`);
  const brought = await evaluate(`
    (async () => {
      const before = Math.round(window.scrollY);
      __readAloud.highlight.scrollTo(window.rangeFor("Millers slept"));
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        moved: Math.round(window.scrollY) !== before,
        inBand: __readAloud.highlight.inBand(window.rangeFor("Millers slept")),
      };
    })()
  `);
  assert.equal(brought.moved, true, "a word below the band is scrolled to");
  assert.equal(brought.inBand, true, "and ends up inside it");
});

test("a listener who scrolled away is left there until the voice reaches them", { skip }, async () => {
  // The whole loop the reader runs, with the view where a listener put it.
  const walked = await evaluate(`
    (async () => {
      const follow = __readAloud.follow.createFollow();
      const highlight = __readAloud.highlight;
      const word = () => window.rangeFor("Millers slept");

      // The listener scrolls the spoken word off the band, and the read goes
      // on arriving at words out of sight.
      window.put("Millers slept", 0.95);
      follow.release();
      const parked = Math.round(window.scrollY);
      for (let i = 0; i < 5; i += 1) {
        if (follow.wants(highlight.inBand(word()))) highlight.scrollTo(word());
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const held = Math.round(window.scrollY);

      // Then they scroll back to where the voice is, and it follows again.
      window.put("Millers slept", 0.4);
      const followsAgain = follow.wants(highlight.inBand(word()));
      return { parked, held, followsAgain, following: follow.following };
    })()
  `);
  assert.equal(walked.held, walked.parked, "the view stayed where the listener put it");
  assert.equal(walked.followsAgain, true);
  assert.equal(walked.following, true);
});
