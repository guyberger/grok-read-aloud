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
  ${contentBundle(["util.js", "stretch.js", "player.js"])}
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

/**
 * Speed. The element must never be the thing that speeds the voice up — that
 * is where the warble comes from — so a rate change swaps in audio that has
 * been stretched already, and the element goes on playing it at 1×.
 */
async function measurePlayedPitch(page) {
  // What the element is actually playing, decoded and measured by zero
  // crossings: a pure tone crosses upward once a cycle.
  return page.evaluate(`
    (async () => {
      const element = globalThis.__elements[0];
      const data = await (await fetch(element.src)).arrayBuffer();
      const decoded = await new OfflineAudioContext(1, 1, 24000).decodeAudioData(data);
      const samples = decoded.getChannelData(0);
      const from = Math.floor(samples.length * 0.1);
      const to = Math.floor(samples.length * 0.9);
      let crossings = 0;
      for (let i = from + 1; i < to; i += 1) if (samples[i - 1] < 0 && samples[i] >= 0) crossings += 1;
      return { hz: crossings / ((to - from) / 24000), seconds: decoded.duration };
    })()
  `);
}

test("a faster rate plays stretched audio at 1x, from the same place, at the same pitch", { skip }, async () => {
  const page = await browser.open(fixtureUrl("article.html"), PREAMBLE);
  pages.push(page);
  const bytes = JSON.stringify([...toneWav({ seconds: 4, hz: 440 })]);
  const result = await page.evaluate(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      globalThis.events = [];
      const player = (globalThis.player = globalThis.__readAloud.player.createPlayer({
        onEnded: () => globalThis.events.push("ended"),
        onPausedOutside: () => globalThis.events.push("paused-outside"),
        onResumedOutside: () => globalThis.events.push("resumed-outside"),
      }));
      await player.load(new Uint8Array(${bytes}), "audio/wav");
      await player.play();
      await sleep(500);
      const before = player.getTime();
      player.setRate(2);
      // Long enough for the render and the swap.
      await sleep(400);
      const swapped = player.getTime();
      await sleep(500);
      const after = player.getTime();
      return {
        before,
        swapped,
        advanced: after - swapped,
        playback: player.playback,
        elementRate: globalThis.__elements[0].playbackRate,
        preservesPitch: globalThis.__elements[0].preservesPitch,
        duration: player.getDuration(),
        events: globalThis.events,
      };
    })()
  `);

  assert.equal(result.elementRate, 1, "the element itself was sped up");
  assert.equal(result.preservesPitch, true);
  assert.deepEqual(result.playback, { engine: "media", rate: 2, stretchedRate: 2, pitchPreserving: true });
  // Half a second of 2x is a second of the original audio.
  assert.ok(result.advanced > 0.75 && result.advanced < 1.25, `advanced ${result.advanced.toFixed(3)}s in 0.5s`);
  assert.ok(result.swapped >= result.before, `the swap went back from ${result.before} to ${result.swapped}`);
  assert.ok(Math.abs(result.duration - 4) < 0.05, `duration reads ${result.duration}s, not the original 4s`);
  assert.deepEqual(result.events, [], "the swap was reported as a pause from outside");

  const played = await measurePlayedPitch(page);
  assert.ok(Math.abs(played.hz - 440) / 440 < 0.02, `the 440 Hz tone plays at ${played.hz.toFixed(1)} Hz`);
  assert.ok(Math.abs(played.seconds - 2) < 0.05, `the stretched audio lasts ${played.seconds}s`);
});

test("a chunk loaded at a rate starts stretched, and seeks in original seconds", { skip }, async () => {
  const page = await browser.open(fixtureUrl("article.html"), PREAMBLE);
  pages.push(page);
  const bytes = JSON.stringify([...toneWav({ seconds: 3, hz: 300 })]);
  const result = await page.evaluate(`
    (async () => {
      const player = (globalThis.player = globalThis.__readAloud.player.createPlayer({}));
      player.setRate(0.75);
      await player.load(new Uint8Array(${bytes}), "audio/wav");
      player.seek(1.5);
      return {
        time: player.getTime(),
        elementTime: globalThis.__elements[0].currentTime,
        playback: player.playback,
        elementRate: globalThis.__elements[0].playbackRate,
      };
    })()
  `);
  assert.equal(result.elementRate, 1);
  assert.equal(result.playback.stretchedRate, 0.75);
  assert.ok(Math.abs(result.time - 1.5) < 0.01, `seeked to ${result.time}`);
  assert.ok(Math.abs(result.elementTime - 2) < 0.01, `the element is at ${result.elementTime}s of the stretched audio`);
  const played = await measurePlayedPitch(page);
  assert.ok(Math.abs(played.hz - 300) / 300 < 0.02, `the 300 Hz tone plays at ${played.hz.toFixed(1)} Hz`);
});

test("on a page that refuses blob media, Web Audio keeps the pitch as well", { skip }, async () => {
  const page = await browser.open(fixtureUrl("csp-strict.html"), PREAMBLE);
  pages.push(page);
  const bytes = JSON.stringify([...toneWav({ seconds: 4, hz: 440 })]);
  const result = await page.evaluate(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const player = (globalThis.player = globalThis.__readAloud.player.createPlayer({}));
      await player.load(new Uint8Array(${bytes}), "audio/wav");
      await player.play();
      await sleep(300);
      player.setRate(2);
      await sleep(300);
      const a = player.getTime();
      await sleep(500);
      const advanced = player.getTime() - a;
      player.pause();
      const paused = player.getTime();
      await sleep(200);
      return { advanced, held: player.getTime() - paused, playback: player.playback, duration: player.getDuration() };
    })()
  `);
  assert.deepEqual(result.playback, { engine: "webaudio", rate: 2, stretchedRate: 2, pitchPreserving: true });
  assert.ok(result.advanced > 0.75 && result.advanced < 1.25, `advanced ${result.advanced.toFixed(3)}s in 0.5s`);
  assert.equal(result.held, 0);
  assert.ok(Math.abs(result.duration - 4) < 0.05, `duration reads ${result.duration}s`);
});

test("a speed change while play is still starting does not fail the play", { skip }, async () => {
  const page = await browser.open(fixtureUrl("article.html"), PREAMBLE);
  pages.push(page);
  const bytes = JSON.stringify([...toneWav({ seconds: 3, hz: 300 })]);
  const result = await page.evaluate(`
    (async () => {
      const player = (globalThis.player = globalThis.__readAloud.player.createPlayer({}));
      await player.load(new Uint8Array(${bytes}), "audio/wav");
      const started = player.play().then(() => "ok", (error) => error.name + ": " + error.message);
      player.setRate(0.5);
      const outcome = await started;
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { outcome, time: player.getTime(), paused: globalThis.__elements[0].paused, playback: player.playback };
    })()
  `);
  assert.equal(result.outcome, "ok");
  assert.equal(result.paused, false, "the swap left it paused");
  assert.equal(result.playback.stretchedRate, 0.5);
  assert.ok(result.time > 0, "it never got going");
});
