/**
 * The read on the browser's own media controls.
 *
 * Most of this is about what the extension writes into `navigator.mediaSession`
 * and when, so most of it runs against a stand-in for that object — which is
 * also the only way to press a button the operating system owns. The last test
 * runs the same module against a real Chrome, because the one thing a stand-in
 * cannot answer is whether the actions being registered are actions a browser
 * actually has.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Browser, contentBundle, findChrome, fixtureUrl } from "./headless.js";
import { loadContentNamespace } from "./load-content.js";

const ALL_ACTIONS = ["play", "pause", "stop", "previoustrack", "nexttrack"];

/**
 * A media session the tests can both read and press. `supported` is the list
 * of actions this pretend browser knows; anything else throws the way a real
 * one does.
 */
function fakeBrowser({ supported = ALL_ACTIONS, hasSession = true } = {}) {
  const handlers = new Map();
  const mediaSession = {
    playbackState: "none",
    metadata: null,
    setActionHandler(action, handler) {
      if (!supported.includes(action)) throw new TypeError(`Unsupported action: ${action}`);
      if (handler === null) handlers.delete(action);
      else handlers.set(action, handler);
    },
  };

  class MediaMetadata {
    constructor(init = {}) {
      Object.assign(this, init);
    }
  }

  const globals = {
    navigator: hasSession ? { mediaSession } : {},
    location: { hostname: "tidemills.example" },
    MediaMetadata,
  };

  const ns = loadContentNamespace(["util.js", "controls.js"], globals);
  return { controls: ns.controls, mediaSession, handlers, press: (action) => handlers.get(action)?.() };
}

/** A reader that records what the controls asked it to do. */
function fakeReader() {
  const asked = [];
  return {
    asked,
    actions: {
      play: () => asked.push("play"),
      pause: () => asked.push("pause"),
      stop: () => asked.push("stop"),
      previous: () => asked.push("previous"),
      next: () => asked.push("next"),
    },
  };
}

test("until a read starts, the page keeps its own media session", () => {
  const { controls, mediaSession } = fakeBrowser();

  controls.update({ status: "playing", title: "Tide mills" });

  assert.equal(mediaSession.playbackState, "none", "a read that never started claimed the controls");
  assert.equal(mediaSession.metadata, null);
});

test("starting a read puts every button on the controls", () => {
  const { controls, handlers } = fakeBrowser();

  assert.equal(controls.attach(fakeReader().actions), true);
  assert.deepEqual([...handlers.keys()].sort(), [...ALL_ACTIONS].sort());
});

test("each button reaches the reader", () => {
  const { controls, press } = fakeBrowser();
  const reader = fakeReader();
  controls.attach(reader.actions);

  for (const action of ALL_ACTIONS) press(action);

  assert.deepEqual(reader.asked, ["play", "pause", "stop", "previous", "next"]);
});

test("an action this browser has never heard of does not take the others with it", () => {
  const { controls, handlers } = fakeBrowser({ supported: ["play", "pause"] });

  assert.equal(controls.attach(fakeReader().actions), true);
  assert.deepEqual([...handlers.keys()].sort(), ["pause", "play"]);
});

test("a button whose action throws is a button that did nothing", () => {
  const { controls, press } = fakeBrowser();
  controls.attach({
    pause: () => {
      throw new Error("the reader fell over");
    },
    next: () => Promise.reject(new Error("and again")),
  });

  assert.doesNotThrow(() => press("pause"));
  assert.doesNotThrow(() => press("next"));
});

test("the controls offer the button the read's state calls for", () => {
  const { controls, mediaSession } = fakeBrowser();
  controls.attach(fakeReader().actions);

  controls.update({ status: "playing", title: "Tide mills" });
  assert.equal(mediaSession.playbackState, "playing");

  // A chunk being fetched mid-read is still a read in progress; the button
  // must not flip to play at every join.
  controls.update({ status: "loading", title: "Tide mills" });
  assert.equal(mediaSession.playbackState, "playing");

  controls.update({ status: "paused", title: "Tide mills" });
  assert.equal(mediaSession.playbackState, "paused");

  controls.update({ status: "error", title: "Tide mills" });
  assert.equal(mediaSession.playbackState, "none");
});

test("the controls name the page and the site it came from", () => {
  const { controls, mediaSession } = fakeBrowser();
  controls.attach(fakeReader().actions);

  controls.update({ status: "playing", title: "How tide mills turned the sea into flour" });

  assert.equal(mediaSession.metadata.title, "How tide mills turned the sea into flour");
  assert.equal(mediaSession.metadata.artist, "tidemills.example");
});

test("a page with no title is named by its site rather than by nothing", () => {
  const { controls, mediaSession } = fakeBrowser();
  controls.attach(fakeReader().actions);

  controls.update({ status: "playing", title: "   " });

  assert.equal(mediaSession.metadata.title, "tidemills.example");
});

test("a selection read says so, since it is why the page stops talking early", () => {
  const { controls, mediaSession } = fakeBrowser();
  controls.attach(fakeReader().actions);

  controls.update({ status: "playing", title: "Tide mills", scope: "selection" });

  assert.equal(mediaSession.metadata.title, "Tide mills (selection)");
});

test("the metadata is written once, not at every state change", () => {
  const { controls, mediaSession } = fakeBrowser();
  controls.attach(fakeReader().actions);

  controls.update({ status: "playing", title: "Tide mills" });
  const first = mediaSession.metadata;
  controls.update({ status: "loading", title: "Tide mills" });
  controls.update({ status: "paused", title: "Tide mills" });

  assert.equal(mediaSession.metadata, first, "the same page was described again");

  // A single-page app can retitle the document under a read in progress.
  controls.update({ status: "playing", title: "Rope ferries" });
  assert.notEqual(mediaSession.metadata, first);
  assert.equal(mediaSession.metadata.title, "Rope ferries");
});

test("a read that finishes takes itself off the controls", () => {
  const { controls, mediaSession } = fakeBrowser();
  controls.attach(fakeReader().actions);
  controls.update({ status: "playing", title: "Tide mills" });

  controls.update({ status: "idle", title: "Tide mills" });

  assert.equal(mediaSession.playbackState, "none");
  assert.equal(mediaSession.metadata, null);
});

test("leaving the page hands the media session back", () => {
  const { controls, mediaSession, handlers } = fakeBrowser();
  controls.attach(fakeReader().actions);
  controls.update({ status: "playing", title: "Tide mills" });

  controls.detach();

  assert.equal(handlers.size, 0, "handlers outlived the read");
  assert.equal(mediaSession.playbackState, "none");
  assert.equal(mediaSession.metadata, null);

  controls.update({ status: "playing", title: "Tide mills" });
  assert.equal(mediaSession.playbackState, "none", "a detached session was written to again");
});

test("a browser with no media session at all is no reason for a read to fail", () => {
  const { controls } = fakeBrowser({ hasSession: false });

  assert.equal(controls.attach(fakeReader().actions), false);
  assert.doesNotThrow(() => controls.update({ status: "playing", title: "Tide mills" }));
  assert.doesNotThrow(() => controls.detach());
});

// ---------------------------------------------------------------------------
// Against a real browser, which is the only place the action names can be
// checked: a stand-in accepts whatever it is given.
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

test("Chrome accepts every action the extension registers, and shows the read", { skip }, async () => {
  const page = await browser.open(fixtureUrl("article.html"), contentBundle(["util.js", "controls.js"]));
  pages.push(page);

  const refused = await page.evaluate(`
    (() => {
      const refused = [];
      for (const action of globalThis.__readAloud.controls.actions) {
        try {
          navigator.mediaSession.setActionHandler(action, () => {});
          navigator.mediaSession.setActionHandler(action, null);
        } catch (error) {
          refused.push(action + ": " + error.message);
        }
      }
      return refused;
    })()
  `);
  assert.deepEqual(refused, [], "Chrome rejected an action the extension registers");

  const shown = await page.evaluate(`
    (() => {
      const { controls } = globalThis.__readAloud;
      controls.attach({});
      controls.update({ status: "playing", title: document.title, scope: "page" });
      const playing = {
        state: navigator.mediaSession.playbackState,
        title: navigator.mediaSession.metadata?.title,
        artist: navigator.mediaSession.metadata?.artist,
      };
      controls.update({ status: "paused", title: document.title, scope: "page" });
      const paused = navigator.mediaSession.playbackState;
      controls.detach();
      return { playing, paused, after: navigator.mediaSession.playbackState,
               metadata: navigator.mediaSession.metadata };
    })()
  `);

  assert.equal(shown.playing.state, "playing");
  assert.ok(shown.playing.title?.length, "the controls were given no title");
  assert.equal(shown.playing.artist, "", "a file:// page has no host to name");
  assert.equal(shown.paused, "paused");
  assert.equal(shown.after, "none", "the session was not handed back");
  assert.equal(shown.metadata, null);
});
