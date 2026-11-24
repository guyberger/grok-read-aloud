/**
 * Reproductions of bugs found by driving the extension. Each bug is asserted
 * as the behaviour a reader can rely on, and marked todo with the bug's title
 * so `npm test` stays green while the product still does the wrong thing.
 *
 * A passing neighbour sits beside every todo. That neighbour only checks that
 * the harness itself ran, so a broken reproduction fails the suite outright
 * instead of hiding inside an expected failure.
 *
 * Nothing here changes product code. The same bugs are driven again, against
 * the packaged extension and the mock API, by `npm run fuzz`.
 */
import assert from "node:assert/strict";
import test, { before, after, describe } from "node:test";
import { Browser, contentBundle, findChrome, fixtureUrl } from "./headless.js";
import { fakeTimestamps, loadContentNamespace } from "./load-content.js";

const skip = findChrome() ? false : "no Chrome binary found (set CHROME_PATH to run these)";

const { buildChunkTimeline, chunkRanges, leadingContext, withoutContext } = loadContentNamespace().align;

const READER_FILES = [
  "util.js",
  "extract.js",
  "docs.js",
  "align.js",
  "highlight.js",
  "pointer.js",
  "follow.js",
  "positions.js",
  "handoff.js",
  "pace.js",
  "audio-cache.js",
  "controls.js",
  "stretch.js",
  "player.js",
  "reader.js",
];

const ARTICLE = `
  <article id="story">
    <h1>How a tide mill keeps its wheel</h1>
    <p>
      The mill at Blackwater has run on the tide for four hundred years, and every
      part of it that still moves is made of wood. Twice a day the pond fills
      through the sluice and empties again through the wheel.
    </p>
    <p>
      A wheel left dry for a whole season opens at its joints, and a wheel that
      is never dry goes soft at the heart. Choosing between the two is the whole
      of the keeper's art.
    </p>
  </article>
`;

/**
 * Stands in for the worker the content scripts message. Synthesis can change
 * the voice, or pause, before it answers, which is the window a real round
 * trip leaves open.
 */
const HARNESS = `
  globalThis.__errors = [];
  globalThis.__rates = [];
  globalThis.__audios = [];
  globalThis.__voice = "eve";
  globalThis.__mode = "normal";
  globalThis.__listeners = [];
  window.addEventListener("error", (event) => {
    globalThis.__errors.push(String(event.message || event.error || "error"));
  });
  window.addEventListener("unhandledrejection", (event) => {
    globalThis.__errors.push(String(event.reason?.message || event.reason || "rejection"));
  });

  (() => {
    const Real = window.Audio;
    window.Audio = function PatchedAudio(...args) {
      const element = new Real(...args);
      globalThis.__audios.push(element);
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "playbackRate");
      if (desc?.set && desc?.get) {
        Object.defineProperty(element, "playbackRate", {
          configurable: true,
          enumerable: true,
          get: () => desc.get.call(element),
          set(value) {
            globalThis.__rates.push(Number(value));
            desc.set.call(element, value);
          },
        });
      }
      return element;
    };
  })();

  function publicSettings() {
    return {
      ok: true,
      settings: {
        voiceId: globalThis.__voice,
        language: "en",
        rate: 1,
        chunkChars: 4000,
        autoScroll: false,
        highlightColor: "#ffd34d",
        sentenceTint: true,
        clickToJump: false,
        readCodeBlocks: false,
        hasApiKey: true,
        signedIn: false,
        tierDenied: false,
        hasCredential: true,
      },
    };
  }

  function timestampsFor(text) {
    const chars = [...text];
    const seconds = 0.02;
    return {
      duration: chars.length * seconds,
      graphChars: chars,
      graphTimes: chars.map((_, index) => [index * seconds, (index + 1) * seconds]),
    };
  }

  function wavBase64(seconds) {
    const sampleRate = 8000;
    const samples = Math.max(1, Math.round(seconds * sampleRate));
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, samples * 2, true);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function audioFor(text) {
    const timing = timestampsFor(text);
    return {
      ok: true,
      audio: wavBase64(Math.min(1.2, Math.max(0.4, timing.duration))),
      contentType: "audio/wav",
      duration: timing.duration,
      graphChars: timing.graphChars,
      graphTimes: timing.graphTimes,
    };
  }

  const store = {};
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          globalThis.__listeners.push(fn);
        },
      },
      sendMessage(message) {
        if (message?.type === "getPublicSettings") return Promise.resolve(publicSettings());
        if (message?.type === "stateChanged" || message?.type === "abortSynthesis") {
          return Promise.resolve({ ok: true });
        }
        if (message?.type === "synthesize") {
          const answer = () => Promise.resolve(audioFor(message.text || ""));
          if (globalThis.__mode === "voice") {
            globalThis.__mode = "normal";
            globalThis.__voice = "ara";
            return globalThis.__send({ type: "settingsChanged" }).then(answer);
          }
          if (globalThis.__mode === "pause") {
            globalThis.__mode = "normal";
            return globalThis.__send({ type: "pause" }).then(answer);
          }
          return answer();
        }
        return Promise.resolve({ ok: false, error: "unhandled " + (message && message.type) });
      },
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: store[key] };
          if (Array.isArray(key)) {
            const out = {};
            for (const name of key) if (name in store) out[name] = store[name];
            return out;
          }
          return { ...store };
        },
        async set(values) {
          Object.assign(store, values);
        },
      },
      onChanged: { addListener() {} },
    },
  };

  globalThis.__send = (message) =>
    new Promise((resolve) => {
      const listener = globalThis.__listeners[0];
      if (!listener) {
        resolve({ ok: false, error: "no listener" });
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "no response" }), 8000);
      try {
        listener(message, {}, (value) => {
          clearTimeout(timer);
          finish(value);
        });
      } catch (error) {
        clearTimeout(timer);
        finish({ ok: false, error: String(error) });
      }
    });
`;

let browser = null;
const pages = [];

before(async () => {
  if (skip) return;
  browser = await Browser.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  for (const page of pages) await page.close().catch(() => {});
  browser?.close();
});

async function openReader() {
  const page = await browser.open(fixtureUrl("article.html"), HARNESS + "\n" + contentBundle(READER_FILES));
  pages.push(page);
  await page.evaluate(`
    document.body.innerHTML = ${JSON.stringify(ARTICLE)};
    // Injection runs at document start, before documentElement exists, so the
    // reader's first settings refresh can throw. The page is ready now.
    globalThis.__errors.length = 0;
  `);
  return page;
}

async function snapshot(page) {
  return page.evaluate(`
    (() => {
      const audio = globalThis.__audios.at(-1);
      return {
        status: globalThis.__readAloud.reader.snapshot().status,
        error: globalThis.__readAloud.reader.snapshot().error,
        notice: globalThis.__readAloud.reader.snapshot().notice,
        voiceId: globalThis.__readAloud.reader.snapshot().voiceId,
        time: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        paused: audio ? audio.paused : null,
        rates: globalThis.__rates.slice(),
        errors: globalThis.__errors.slice(),
      };
    })()
  `);
}

const EMOJI_BUG = "A run of eight emoji collapses highlighting onto the last word and replays the lead-in";
const SPA_BUG = "Replacing the article mid-read keeps speaking the text that was removed";
const VOICE_BUG = "Changing voice while a chunk is loading leaves playback stuck on Loading";
const SHADOW_BUG = "Article text inside an open shadow root is never read";
const PAUSE_BUG = "Pause during loading is ignored and the audio starts anyway";

function emojiTiming(text) {
  const { graphChars, graphTimes, duration } = fakeTimestamps(text, 0.05);
  const timeline = buildChunkTimeline({ text, graphChars, graphTimes, duration });
  const starts = timeline.words.map((word) => Number(word.t0.toFixed(4)));
  return {
    words: timeline.words.map((word) => text.slice(word.start, word.end)),
    distinct: new Set(starts).size,
    count: timeline.words.length,
  };
}

describe("reproduced bugs", { concurrency: 1 }, () => {
  test("emoji timing can be measured without throwing", () => {
    const timing = emojiTiming(`Wow ${"😂".repeat(8)} and then more words follow here.`);
    assert.ok(timing.count > 4, JSON.stringify(timing));
  });

  test(EMOJI_BUG, { todo: EMOJI_BUG }, () => {
    const emoji = "😂".repeat(8);
    const sentence = `Wow ${emoji} and then the sentence continues with more words here.`;
    const problems = [];
    const runs = [emojiTiming(sentence), emojiTiming(sentence)];
    for (const run of runs) {
      // Every word needs its own start. Sharing one time is the highlight
      // sitting on the last word for the rest of the chunk.
      if (!(run.count > 4) || run.distinct !== run.count) problems.push(JSON.stringify(run));
    }

    const text =
      "The opening sentence is perfectly ordinary and long enough to be its own chunk of speech. " +
      `Then a reaction ${emoji} lands in the middle of the paragraph and the words after it ` +
      "should still be highlighted in order as they are spoken, one after another, until the paragraph ends.";
    const ranges = chunkRanges(text, 500, { firstChars: 240 });
    assert.ok(ranges.length > 1, "fixture did not reach a second chunk");
    const leads = ranges.slice(1).map((range) => {
      const context = leadingContext(text, range.start);
      const submission = context + text.slice(range.start, range.end);
      const fake = fakeTimestamps(submission, 0.05);
      const spoken = withoutContext({
        submission,
        contextChars: context.length,
        graphChars: fake.graphChars,
        graphTimes: fake.graphTimes,
        duration: fake.duration,
      });
      return {
        contextPoints: [...context].length,
        expected: [...context].length * 0.05,
        lead: spoken.lead,
      };
    });
    for (const lead of leads) {
      if (lead.contextPoints < 8) continue;
      if (!(Math.abs(lead.lead - lead.expected) / lead.expected < 0.25)) {
        problems.push(`lead-in played from ${lead.lead.toFixed(3)}s instead of ${lead.expected.toFixed(3)}s`);
      }
    }
    assert.equal(problems.length, 0, problems.join("\n"));
  });

  test("a normal paragraph starts playing through the stubbed reader", { skip }, async () => {
    const page = await openReader();
    const started = await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
    assert.equal(started?.ok, undefined);
    assert.equal(started?.status, "loading", JSON.stringify(started));
    let seen = null;
    for (let i = 0; i < 30; i += 1) {
      seen = await snapshot(page);
      if (seen.status === "playing" && seen.time > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const word = await page.evaluate(`
      (() => {
        const highlight = CSS.highlights?.get?.("read-aloud-word");
        let text = "";
        if (highlight) for (const range of highlight) text = range.toString();
        return text;
      })()
    `);
    assert.equal(seen.errors.length, 0, seen.errors.join(" | "));
    assert.equal(seen.status, "playing", JSON.stringify(seen));
    assert.ok(seen.time > 0, JSON.stringify(seen));
    assert.ok(word.length > 0, "playing audio never highlighted a word");
    assert.ok(seen.rates.every((rate) => rate === 1), JSON.stringify(seen.rates));
  });

  test("changing voice during load settles without throwing", { skip }, async () => {
    const page = await openReader();
    await page.evaluate(`globalThis.__mode = "voice";`);
    await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const seen = await snapshot(page);
    assert.equal(seen.errors.length, 0, seen.errors.join(" | "));
    assert.ok(["loading", "playing", "paused", "error"].includes(seen.status), JSON.stringify(seen));
  });

  test(VOICE_BUG, { skip, todo: VOICE_BUG }, async () => {
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const page = await openReader();
      await page.evaluate(`globalThis.__mode = "voice";`);
      await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      results.push(await snapshot(page));
    }
    // The chunk was already requested in the old voice. It should play in that
    // voice, and the one after it should use the new one. Stuck on Loading,
    // with the main control disabled, is the bug.
    for (const seen of results) {
      assert.equal(seen.errors.length, 0, seen.errors.join(" | "));
      assert.equal(seen.status, "playing", JSON.stringify(results));
      assert.ok(seen.time > 0, JSON.stringify(results));
    }
  });

  test("pausing during load settles without throwing", { skip }, async () => {
    const page = await openReader();
    await page.evaluate(`globalThis.__mode = "pause";`);
    await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const seen = await snapshot(page);
    assert.equal(seen.errors.length, 0, seen.errors.join(" | "));
    assert.ok(["loading", "playing", "paused", "error"].includes(seen.status), JSON.stringify(seen));
  });

  test(PAUSE_BUG, { skip, todo: PAUSE_BUG }, async () => {
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const page = await openReader();
      await page.evaluate(`globalThis.__mode = "pause";`);
      await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      results.push(await snapshot(page));
    }
    for (const seen of results) {
      assert.equal(seen.errors.length, 0, seen.errors.join(" | "));
      assert.equal(seen.status, "paused", JSON.stringify(results));
      assert.ok(seen.time === 0 || seen.paused === true, JSON.stringify(results));
    }
  });

  test("extraction of a light-dom article still returns text", { skip }, async () => {
    const page = await browser.open(fixtureUrl("article.html"), contentBundle(["util.js", "extract.js"]));
    pages.push(page);
    const text = await page.evaluate(`
      globalThis.__readAloud.extract.extract("page")?.text ?? ""
    `);
    assert.ok(text.length > 200, text.slice(0, 80));
  });

  test(SPA_BUG, { skip, todo: SPA_BUG }, async () => {
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const page = await openReader();
      await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
      let seen = null;
      for (let i = 0; i < 30 && !(seen?.status === "playing" && seen.word); i += 1) {
        seen = await page.evaluate(`
          (() => {
            const highlight = CSS.highlights?.get?.("read-aloud-word");
            let word = "";
            if (highlight) for (const range of highlight) word = range.toString();
            return { status: globalThis.__readAloud.reader.snapshot().status, word };
          })()
        `);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await page.evaluate(`
        document.querySelector("#story").innerHTML = "<h1>Second route</h1><p>The replacement is about the brake and the spring tide only.</p>";
      `);
      await new Promise((resolve) => setTimeout(resolve, 400));
      results.push(
        await page.evaluate(`
          (() => {
            const highlight = CSS.highlights?.get?.("read-aloud-word");
            let word = "";
            let connected = false;
            if (highlight) {
              for (const range of highlight) {
                word = range.toString();
                connected = Boolean(range.startContainer?.isConnected);
              }
            }
            const visible = document.querySelector("#story")?.innerText ?? "";
            return {
              status: globalThis.__readAloud.reader.snapshot().status,
              word,
              connected,
              visibleHasWord: word ? visible.includes(word) : true,
            };
          })()
        `),
      );
    }
    for (const result of results) {
      assert.ok(result.visibleHasWord || result.status !== "playing", JSON.stringify(results));
      assert.equal(result.connected || !result.word, true, JSON.stringify(results));
    }
  });

  test(SHADOW_BUG, { skip, todo: SHADOW_BUG }, async () => {
    const marker = "the shadow article asks for a new elm bucket";
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const page = await browser.open(fixtureUrl("article.html"), contentBundle(["util.js", "extract.js"]));
      pages.push(page);
      results.push(
        await page.evaluate(`
          (() => {
            document.body.replaceChildren();
            const host = document.createElement("article");
            host.id = "story";
            const root = host.attachShadow({ mode: "open" });
            const paragraph = document.createElement("p");
            paragraph.textContent = ${JSON.stringify(
              `${marker}. The keeper cuts the bucket from elm that has lain under water since the spring, ` +
                "because elm kept wet will not shrink, and a bucket that shrinks rattles itself to pieces within a winter. " +
                "Nothing else on this page is text. The words live only in the open shadow root of the article.",
            )};
            root.append(paragraph);
            document.body.append(host);
            const doc = globalThis.__readAloud.extract.extract("page");
            return { text: doc?.text ?? "", markerFound: Boolean(doc?.text?.includes(${JSON.stringify(marker)})) };
          })()
        `),
      );
    }
    for (const result of results) {
      assert.equal(result.markerFound, true, JSON.stringify(results));
    }
  });
});
