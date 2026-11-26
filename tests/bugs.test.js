/**
 * Reproductions of bugs found by driving the extension. Each open bug is
 * asserted as the behaviour a reader can rely on, and marked todo with the
 * bug's title so `npm test` stays green while the product still does the
 * wrong thing. A bug that has been fixed keeps the assertion and loses the todo.
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
import { panelState } from "../src/common/panel-cache.js";
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
  "transport.js",
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
        chunkChars: globalThis.__chunkChars || 4000,
        autoScroll: false,
        highlightColor: "#ffd34d",
        sentenceTint: true,
        clickToJump: globalThis.__clickToJump === true,
        readCodeBlocks: false,
        hasApiKey: true,
        signedIn: false,
        tierDenied: false,
        hasCredential: true,
      },
    };
  }

  function timestampsFor(text) {
    // One entry per Unicode code point, as audio_timestamps.graph_chars is.
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
      audio: wavBase64(globalThis.__audioSeconds || Math.min(1.2, Math.max(0.4, timing.duration))),
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
          globalThis.__synthCount = (globalThis.__synthCount || 0) + 1;
          if (globalThis.__failAfter != null && globalThis.__synthCount > globalThis.__failAfter) {
            return Promise.resolve({ ok: false, error: "The synthesis backend failed." });
          }
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
          if (globalThis.__mode === "delay") {
            return new Promise((resolve) => {
              setTimeout(() => resolve(audioFor(message.text || "")), 800);
            });
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
const EMPTY_TIMESTAMPS_BUG = "Empty timestamp arrays stick the highlight on the last word of the chunk";
const JUMP_ERROR_BUG = "A failed jump leaves the old audio playing and disables Stop";
const CJK_BUG = "A space-free Chinese paragraph is highlighted as one block";
const EDITABLE_BUG = "Editable text shows the jump cursor but a click does not move the read";
const SPA_BUG = "Replacing the article mid-read keeps speaking the text that was removed";
const VOICE_BUG = "Changing voice while a chunk is loading leaves playback stuck on Loading";
const SHADOW_BUG = "Article text inside an open shadow root is never read";
const PAUSE_BUG = "Pause during loading is ignored and the audio starts anyway";
const TEASER_BUG = "A sidebar teaser article is read instead of the story";
const POPUP_LOAD_BUG = "Opening the popup while a chunk is loading offers Resume and restarts the read";
const DUPLICATE_RESUME_BUG = "Continuing after new text is inserted above resumes at an earlier duplicate";

const TEASER_CARD = "TEASERTOKEN This recommended card describes a different creek and a newsletter the keeper never asked to hear. ";
const STORY_OPENING = "STORYTOKEN The mill at Blackwater has run on the tide for four hundred years, and every part of it that still moves is made of wood.";

function teaserPage() {
  const teaser = TEASER_CARD.repeat(5);
  return `<nav>Navigation: Home · Notes · Index</nav>
    <div id="story" class="story-body">
      <h1>How the tide mill keeps its wheel</h1>
      <p>${STORY_OPENING} Twice a day the pond fills through the sluice.</p>
      <p>The story keeps going with the brake, the pegs, and the elm buckets that have lain under water since the spring so they will not shrink.</p>
      <p>A third paragraph of the story mentions the gudgeon and the patience of driving every peg out with a mallet before the pond fills.</p>
      <p>The fourth paragraph of the story walks the length of the dam, names every peg the wheelwright drove home last spring, and records that the pond still empties through the same wooden wheel.</p>
    </div>
    <aside>
      <article id="teaser"><h1>Recommended mill</h1><p>${teaser}</p></article>
    </aside>`;
}

const DUPLICATE_PHRASE = "The sluice gate was drawn and set true before the spring tide reached the wheel and the brake.";

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

  test(EMOJI_BUG, () => {
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

  test(VOICE_BUG, { skip }, async () => {
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

  test(PAUSE_BUG, { skip }, async () => {
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

  test(SHADOW_BUG, { skip }, async () => {
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
            const { extract } = globalThis.__readAloud;
            const doc = extract.extract("page");
            const text = doc?.text ?? "";
            const at = text.indexOf("elm");
            const range = at < 0 ? null : extract.rangeFor(doc, at, at + 3);
            const rect = paragraph.getClientRects()[0];
            const hit = rect
              ? extract.charIndexFromPoint(doc, rect.left + 12, rect.top + rect.height / 2)
              : -1;
            return {
              text,
              markerFound: text.includes(${JSON.stringify(marker)}),
              highlighted: range ? range.toString() : "",
              inShadow: range ? range.startContainer.getRootNode() instanceof ShadowRoot : false,
              hit: hit >= 0 ? text.slice(hit, hit + 12) : "",
            };
          })()
        `),
      );
    }
    for (const result of results) {
      assert.equal(result.markerFound, true, JSON.stringify(results));
      assert.equal(result.highlighted, "elm", JSON.stringify(results));
      assert.equal(result.inShadow, true, JSON.stringify(results));
      assert.ok(result.text.includes(result.hit) && result.hit.length > 0, JSON.stringify(results));
    }
  });

  test("missing timestamps still spread words across the clip", () => {
    const text = "One two three four five";
    const timeline = buildChunkTimeline({ text, graphChars: null, graphTimes: null, duration: 5 });
    assert.equal(timeline.words.length, 5);
    assert.ok(timeline.words[4].t0 > timeline.words[0].t0);
  });

  test(EMPTY_TIMESTAMPS_BUG, { todo: EMPTY_TIMESTAMPS_BUG }, () => {
    const text = "One two three four five";
    const runs = [0, 1].map(() => buildChunkTimeline({ text, graphChars: [], graphTimes: [], duration: 5 }));
    for (const timeline of runs) {
      assert.equal(timeline.words.length, 5);
      assert.ok(
        timeline.words[4].t0 > timeline.words[0].t0 + 0.5,
        timeline.words.map((word) => word.t0).join(","),
      );
    }
  });

  test("a failed first request ends before any audio plays", { skip }, async () => {
    const page = await openReader();
    await page.evaluate(`globalThis.__failAfter = -1; globalThis.__synthCount = 0;`);
    await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
    let seen = null;
    for (let i = 0; i < 20; i += 1) {
      seen = await snapshot(page);
      if (seen.status === "error" || seen.status === "playing") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(seen.errors.length, 0, seen.errors.join(" | "));
    assert.equal(seen.status, "error", JSON.stringify(seen));
    assert.ok(seen.time === 0 || seen.paused !== false, JSON.stringify(seen));
  });

  test(JUMP_ERROR_BUG, { skip }, async () => {
    const paragraph = Array.from(
      { length: 24 },
      (_, index) =>
        `Sentence ${index} talks about the sluice gate and the wooden wheel that empties the pond.`,
    ).join(" ");
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const page = await openReader();
      await page.evaluate(`
        document.querySelector("#story").textContent = ${JSON.stringify(paragraph)};
        globalThis.__chunkChars = 220;
        globalThis.__audioSeconds = 8;
        globalThis.__failAfter = 1;
        globalThis.__synthCount = 0;
      `);
      await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
      let seen = null;
      for (let i = 0; i < 30; i += 1) {
        seen = await snapshot(page);
        if (seen.status === "playing" && seen.time > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      for (let i = 0; i < 8 && seen?.status !== "error"; i += 1) {
        await page.evaluate(`globalThis.__send({ type: "skipSentence", delta: 1 })`);
        await new Promise((resolve) => setTimeout(resolve, 40));
        seen = await snapshot(page);
      }
      const atError = seen;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const later = await snapshot(page);
      results.push({ atError, later });
    }
    for (const result of results) {
      assert.equal(result.later.errors.length, 0, result.later.errors.join(" | "));
      assert.equal(result.later.status, "error", JSON.stringify(results));
      assert.equal(result.later.paused, true, JSON.stringify(results));
      assert.ok(result.later.time <= result.atError.time + 0.05, JSON.stringify(results));
    }
  });

  test("an English sentence still splits into words", () => {
    const text = "The mill at Blackwater has run on the tide.";
    const timing = fakeTimestamps(text, 0.05);
    const timeline = buildChunkTimeline({
      text,
      graphChars: timing.graphChars,
      graphTimes: timing.graphTimes,
      duration: timing.duration,
    });
    assert.ok(timeline.words.length > 3, String(timeline.words.length));
  });

  test(CJK_BUG, { todo: CJK_BUG }, () => {
    const text = "这座潮汐磨坊已经依靠潮水运转了四百年，所有仍在转动的部件都是木头做的，每天两次池塘通过水闸灌满再通过水轮排空。";
    const runs = [0, 1].map(() => {
      const timing = fakeTimestamps(text, 0.05);
      return buildChunkTimeline({
        text,
        graphChars: timing.graphChars,
        graphTimes: timing.graphTimes,
        duration: timing.duration,
      });
    });
    for (const timeline of runs) {
      assert.ok(timeline.words.length > 1, String(timeline.words.length));
      assert.ok(timeline.words[1].t0 > timeline.words[0].t0);
    }
  });

  test("a read with click-to-jump enabled still starts", { skip }, async () => {
    const page = await openReader();
    await page.evaluate(`globalThis.__clickToJump = true;`);
    await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
    let seen = null;
    for (let i = 0; i < 30; i += 1) {
      seen = await snapshot(page);
      if (seen.status === "playing" && seen.time > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.equal(seen.status, "playing", JSON.stringify(seen));
    assert.equal(seen.errors.length, 0, seen.errors.join(" | "));
  });

  test(EDITABLE_BUG, { skip, todo: EDITABLE_BUG }, async () => {
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const page = await openReader();
      const landed = await page.evaluate(`
        (async () => {
          globalThis.__clickToJump = true;
          const story = document.querySelector("#story");
          story.setAttribute("contenteditable", "true");
          story.innerHTML = "<p id='dawn'>The dawn peg was loose before the pond filled today.</p><p id='spring'>The spring tide paragraph is the one a click should reach from here.</p>";
          await globalThis.__send({ type: "start", scope: "page", from: "start" });
          const deadline = Date.now() + 4000;
          let status = "";
          while (Date.now() < deadline) {
            status = globalThis.__readAloud.reader.snapshot().status;
            if (status === "playing") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const paragraph = document.querySelector("#spring");
          const rect = paragraph.getClientRects()[0];
          const point = { clientX: rect.left + 16, clientY: rect.top + 8, bubbles: true, cancelable: true, view: window };
          document.dispatchEvent(new PointerEvent("pointermove", { ...point, pointerType: "mouse" }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const cursor = getComputedStyle(paragraph).cursor;
          const marked = document.querySelectorAll("[data-read-aloud-jump]").length;
          paragraph.dispatchEvent(new MouseEvent("click", { ...point, button: 0, detail: 1 }));
          await new Promise((resolve) => setTimeout(resolve, 250));
          const highlight = CSS.highlights?.get?.("read-aloud-word");
          let word = "";
          if (highlight) for (const range of highlight) word = range.toString();
          return { status, cursor, marked, word, errors: globalThis.__errors.slice() };
        })()
      `);
      results.push(landed);
    }
    for (const result of results) {
      assert.equal(result.errors.length, 0, result.errors.join(" | "));
      // The attribute is the cue. The packaged extension turns it into a
      // pointer; this harness does not inject that stylesheet.
      assert.ok(result.marked > 0, JSON.stringify(results));
      assert.match(result.word, /spring|tide/, JSON.stringify(results));
    }
  });

  test("a story div is read when it is the only candidate", { skip }, async () => {
    const page = await browser.open(fixtureUrl("article.html"), contentBundle(["util.js", "extract.js"]));
    pages.push(page);
    const text = await page.evaluate(`
      (() => {
        document.body.innerHTML = ${JSON.stringify(`<div id="story" class="story-body"><h1>How the tide mill keeps its wheel</h1><p>${STORY_OPENING}</p><p>The brake and the pegs stay in the second paragraph of the story.</p><p>The gudgeon is mentioned in the third paragraph before the pond fills.</p></div>`)};
        return globalThis.__readAloud.extract.extract("page")?.text ?? "";
      })()
    `);
    assert.ok(text.includes("STORYTOKEN"), text.slice(0, 160));
  });

  test(TEASER_BUG, { skip }, async () => {
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const page = await browser.open(fixtureUrl("article.html"), contentBundle(["util.js", "extract.js"]));
      pages.push(page);
      results.push(
        await page.evaluate(`
          (() => {
            document.body.innerHTML = ${JSON.stringify(teaserPage())};
            const root = globalThis.__readAloud.extract.findMainContent();
            const doc = globalThis.__readAloud.extract.extract("page");
            return { root: root?.id ?? "", text: doc?.text ?? "" };
          })()
        `),
      );
    }
    for (const result of results) {
      assert.equal(result.root, "story", JSON.stringify({ root: result.root, text: result.text.slice(0, 180) }));
      assert.ok(result.text.includes("STORYTOKEN"), JSON.stringify({ root: result.root, text: result.text.slice(0, 180) }));
      assert.equal(result.text.includes("TEASERTOKEN"), false, JSON.stringify({ root: result.root, text: result.text.slice(0, 180) }));
    }
  });

  test("an article that is the only text is still read from an aside", { skip }, async () => {
    const page = await browser.open(fixtureUrl("article.html"), contentBundle(["util.js", "extract.js"]));
    pages.push(page);
    const text = await page.evaluate(`
      (() => {
        const copy = ${JSON.stringify(
          "The only article on the page sits in an aside, and it is still the thing to read because nothing else holds the story of the wheel, the pegs, and the pond.",
        )};
        document.body.innerHTML = \`<aside><article id="only"><h1>The wheel</h1><p>\${copy}</p><p>\${copy}</p><p>\${copy}</p></article></aside>\`;
        return globalThis.__readAloud.extract.extract("page")?.text ?? "";
      })()
    `);
    assert.ok(text.includes("still the thing to read"), text.slice(0, 180));
  });

  test("slotted text is read in slot order, once, and unassigned light text is not", { skip }, async () => {
    const page = await browser.open(fixtureUrl("article.html"), contentBundle(["util.js", "extract.js"]));
    pages.push(page);
    const read = await page.evaluate(`
      (() => {
        document.body.replaceChildren();
        const host = document.createElement("article");
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = "<div><slot name='second'></slot></div><slot name='first'></slot><slot name='spare'><p>FALLBACKSLOT the spare peg stays in the drawer.</p></slot>";
        const second = document.createElement("p");
        second.slot = "second";
        second.textContent = "SECONDSLOT the wheel was pegged before the pond filled today.";
        const first = document.createElement("p");
        first.slot = "first";
        first.textContent = "FIRSTSLOT the elm buckets were cut in the spring and kept wet.";
        const loose = document.createElement("p");
        loose.textContent = "UNASSIGNED this paragraph has no slot and is not on the page at all.";
        host.append(second, first, loose);
        document.body.append(host);
        const doc = globalThis.__readAloud.extract.extract("page");
        const text = doc?.text ?? "";
        const at = text.indexOf("SECONDSLOT");
        const range = at < 0 ? null : globalThis.__readAloud.extract.rangeFor(doc, at, at + "SECONDSLOT".length);
        return {
          text,
          secondBeforeFirst: text.indexOf("SECONDSLOT") >= 0 && text.indexOf("SECONDSLOT") < text.indexOf("FIRSTSLOT"),
          highlighted: range ? range.toString() : "",
        };
      })()
    `);
    assert.equal(read.secondBeforeFirst, true, read.text);
    assert.ok(read.text.includes("FIRSTSLOT"), read.text);
    assert.ok(read.text.includes("FALLBACKSLOT"), read.text);
    assert.equal(read.text.includes("UNASSIGNED"), false, read.text);
    assert.equal(read.text.split("SECONDSLOT").length - 1, 1, read.text);
    assert.equal(read.highlighted, "SECONDSLOT");
  });

  test("a playing snapshot stays marked playing in the panel cache", () => {
    const shown = panelState({ status: "playing", chunkIndex: 1, chunkCount: 3, progress: 0.4 });
    assert.equal(shown.status, "playing");
  });

  test(POPUP_LOAD_BUG, { todo: POPUP_LOAD_BUG }, async () => {
    const problems = [];
    const shown = panelState({ status: "loading", chunkIndex: 0, chunkCount: 2, progress: 0 });
    if (shown?.status !== "loading") problems.push(`cache shows ${shown?.status} for an in-flight load`);
    if (!skip) {
      for (let run = 0; run < 2; run += 1) {
        const page = await openReader();
        await page.evaluate(`globalThis.__mode = "delay"; globalThis.__synthCount = 0;`);
        await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
        const mid = await page.evaluate(`({
          status: globalThis.__readAloud.reader.snapshot().status,
          synth: globalThis.__synthCount || 0
        })`);
        if (mid.status !== "loading") {
          problems.push(`run ${run} left loading before the popup could open (${mid.status})`);
          continue;
        }
        const synth = await page.evaluate(
          `globalThis.__send({ type: "toggle", scope: "page" }).then(() => globalThis.__synthCount || 0)`,
        );
        // The mislabeled Resume button sends toggle. An in-flight load already
        // asked for its chunks; toggle must not start the read over.
        if (synth > mid.synth) problems.push(`run ${run} toggle during load grew requests ${mid.synth} → ${synth}`);
      }
    }
    assert.equal(problems.length, 0, problems.join("\n"));
  });

  test("a unique passage is found again after text is inserted above it", () => {
    const { positions } = loadContentNamespace(["util.js", "positions.js"]);
    const oldText = `${"The mill pond fills on the tide and the keeper notes the hour. ".repeat(8)}${DUPLICATE_PHRASE} The tail stays put.`;
    const at = oldText.indexOf(DUPLICATE_PHRASE);
    const entry = positions.entryFor({ text: oldText, charIndex: at });
    const next = `${"A notice was posted above the story. ".repeat(8)}\n${oldText}`;
    assert.equal(positions.locate(next, entry), next.indexOf(DUPLICATE_PHRASE));
  });

  test(DUPLICATE_RESUME_BUG, { todo: DUPLICATE_RESUME_BUG }, () => {
    const { positions } = loadContentNamespace(["util.js", "positions.js"]);
    const intro = "The mill pond fills on the tide and the keeper notes the hour. ".repeat(8);
    const middle = "Between the marks the brake stays quiet and the ledger stays open. ".repeat(3);
    const tail = "After both marks the wheel keeps turning until the pond is empty. ".repeat(10);
    const oldText = [intro.trim(), DUPLICATE_PHRASE, middle.trim(), DUPLICATE_PHRASE, tail.trim()].join("\n");
    const first = oldText.indexOf(DUPLICATE_PHRASE);
    const second = oldText.indexOf(DUPLICATE_PHRASE, first + DUPLICATE_PHRASE.length);
    const entry = positions.entryFor({ text: oldText, charIndex: second });
    assert.ok(positions.offered(entry), JSON.stringify(entry));
    const runs = [220, 360].map((size) => {
      const banner = "A new notice arrived above the story and pushed every paragraph down. ".repeat(8).slice(0, size);
      const next = `${banner}\n${oldText}`;
      const firstNext = next.indexOf(DUPLICATE_PHRASE);
      const secondNext = next.indexOf(DUPLICATE_PHRASE, firstNext + DUPLICATE_PHRASE.length);
      return { found: positions.locate(next, entry), secondNext };
    });
    for (const run of runs) {
      assert.equal(run.found, run.secondNext, JSON.stringify(runs));
    }
  });

  test("an unedited word highlight is a word from the article", { skip }, async () => {
    const page = await openReader();
    await page.evaluate(`globalThis.__send({ type: "start", scope: "page", from: "start" })`);
    let word = "";
    for (let i = 0; i < 30 && word.length < 2; i += 1) {
      word = await page.evaluate(`
        (() => {
          const highlight = CSS.highlights?.get?.("read-aloud-word");
          let text = "";
          if (highlight) for (const range of highlight) text = range.toString();
          return text;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const article = await page.evaluate(`document.querySelector("#story").innerText`);
    assert.ok(word.length > 1, "no highlight");
    assert.ok(article.includes(word), `${word} is not in the article`);
  });
});
