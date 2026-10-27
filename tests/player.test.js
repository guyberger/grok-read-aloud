/**
 * Playback that the extension did not ask for.
 *
 * The media controls, and anything in the system that takes audio over, reach
 * the audio element directly. The element's events say that it was paused, not
 * who paused it, and getting that distinction wrong is expensive both ways: a
 * read that treats the end of every chunk as an interruption stops after the
 * first one, and a read that treats an interruption as nothing goes on
 * claiming to play over a highlight that has frozen.
 *
 * So these drive a real audio element in a real browser — events, timing and
 * all — rather than a stub that would only confirm what the stub was written
 * to do.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Browser, contentBundle, findChrome, fixtureUrl } from "./headless.js";

const skip = findChrome() ? false : "no Chrome binary found (set CHROME_PATH to run these)";

/** A WAV of a quiet tone, which is the shortest real audio to hand a browser. */
function toneWav({ seconds = 1, sampleRate = 8000, hz = 440 } = {}) {
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i += 1) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((i / sampleRate) * hz * 2 * Math.PI) * 6000), true);
  }
  return bytes;
}

/**
 * The content scripts, with `Audio` wrapped so a test can reach the element
 * the player builds. That is what stands in for the world outside the
 * extension: pausing the element itself is exactly what a media key does.
 */
const PREAMBLE = `
  (() => {
    const Real = window.Audio;
    window.__elements = [];
    window.Audio = function WatchedAudio(...args) {
      const element = new Real(...args);
      window.__elements.push(element);
      return element;
    };
  })();
  ${contentBundle(["util.js", "player.js"])}
`;

let browser = null;
const pages = [];

before(async () => {
  if (skip) return;
  // The element has to actually play for a pause to mean anything, and a
  // headless browser blocks audio no gesture started.
  browser = await Browser.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  for (const page of pages) await page.close().catch(() => {});
  browser?.close();
});

/** Loads a page with a player on it, driving a one-second tone. */
async function playing() {
  const page = await browser.open(fixtureUrl("article.html"), PREAMBLE);
  pages.push(page);
  const bytes = JSON.stringify([...toneWav()]);
  const ready = await page.evaluate(`
    (async () => {
      globalThis.events = [];
      globalThis.player = globalThis.__readAloud.player.createPlayer({
        onEnded: () => globalThis.events.push("ended"),
        onPausedOutside: () => globalThis.events.push("paused-outside"),
        onResumedOutside: () => globalThis.events.push("resumed-outside"),
      });
      await globalThis.player.load(new Uint8Array(${bytes}), "audio/wav");
      await globalThis.player.play();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        engine: globalThis.player.engineName,
        elements: globalThis.__elements.length,
        time: globalThis.player.getTime(),
        events: globalThis.events,
      };
    })()
  `);
  return { page, ready };
}

test("the tone really is playing through the media element", { skip }, async () => {
  const { ready } = await playing();

  assert.equal(ready.engine, "media", "fell back to Web Audio, which nothing outside can reach");
  assert.equal(ready.elements, 1, "the player built more than one audio element");
  assert.ok(ready.time > 0, `playback never started (currentTime ${ready.time})`);
  assert.deepEqual(ready.events, [], "starting a read reported itself as an interruption");
});

test("a pause the extension asked for is not reported as one from outside", { skip }, async () => {
  const { page } = await playing();

  const events = await page.evaluate(`
    (async () => {
      globalThis.player.pause();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await globalThis.player.play();
      await new Promise((resolve) => setTimeout(resolve, 150));
      globalThis.player.stop();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return globalThis.events;
    })()
  `);

  assert.deepEqual(events, [], `the extension's own transport reported ${events.join(", ")}`);
});

test("a pause from outside the extension is reported, and so is playing again", { skip }, async () => {
  const { page } = await playing();

  const paused = await page.evaluate(`
    (async () => {
      globalThis.__elements[0].pause();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return globalThis.events;
    })()
  `);
  assert.deepEqual(paused, ["paused-outside"]);

  const resumed = await page.evaluate(`
    (async () => {
      await globalThis.__elements[0].play();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return globalThis.events;
    })()
  `);
  assert.deepEqual(resumed, ["paused-outside", "resumed-outside"]);
});

test("the pause at the end of a chunk is the chunk ending, not an interruption", { skip }, async () => {
  const { page } = await playing();

  const events = await page.evaluate(`
    (async () => {
      // Straight to the last tenth of a second rather than waiting out the tone.
      globalThis.player.seek(globalThis.player.getDuration() - 0.1);
      await new Promise((resolve) => setTimeout(resolve, 600));
      return globalThis.events;
    })()
  `);

  assert.deepEqual(events, ["ended"], "the end of the audio was taken for an interruption");
});
