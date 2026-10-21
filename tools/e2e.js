/**
 * End-to-end check against a running Chrome, driving the extension the way the
 * popup does and asserting the highlight walks the article in time with the
 * audio. See README for the one-off Chrome and mock-server setup.
 *
 *   node tools/e2e.js --cdp http://127.0.0.1:9333 --page http://127.0.0.1:8777/article.html
 */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const CDP = args.get("cdp") ?? "http://127.0.0.1:9333";
const PAGE_URL = args.get("page") ?? "http://127.0.0.1:8777/article.html";
const EXTENSION_DIR = args.get("extension") ?? new URL("../dist/chrome", import.meta.url).pathname;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Session {
  constructor(socketUrl) {
    this.socketUrl = socketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.contexts = [];
  }

  /**
   * Content scripts run in an isolated world, so their globals are invisible
   * to a default-world evaluate. Reloading the extension leaves several
   * same-named isolated worlds behind, so pick the one that actually holds a
   * live reader rather than guessing by name or order.
   */
  async isolatedContextId({ timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const probe = `typeof globalThis.__readAloud?.reader?.snapshot === "function"`;
    while (Date.now() < deadline) {
      for (const context of this.contexts) {
        if (context.auxData?.type !== "isolated") continue;
        try {
          if (await this.evaluate(probe, context.id)) return context.id;
        } catch {
          // A detached world; try the next one.
        }
      }
      await sleep(250);
    }
    throw new Error("content script execution context never appeared");
  }

  async open() {
    this.socket = new WebSocket(this.socketUrl);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error(`cannot connect to ${this.socketUrl}`));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.executionContextCreated") {
        this.contexts.push(message.params.context);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    };
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  async evaluate(expression, contextId) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...(contextId ? { contextId } : {}),
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function findTarget(predicate, { label, timeoutMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${CDP}/json/list`)).json();
    const found = list.find(predicate);
    if (found?.webSocketDebuggerUrl) return found;
    await sleep(300);
  }
  throw new Error(`target not found: ${label}`);
}

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const browser = await new Session(version.webSocketDebuggerUrl).open();

  let extensionId = args.get("id");
  if (!extensionId) {
    const loaded = await browser.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
    extensionId = loaded.id;
  }
  console.log(`extension id: ${extensionId}\n`);

  // The article tab must stay active: commands without an explicit tab id go
  // to the active tab, which is the path the popup actually uses.
  // Any tab on the fixture server will do — the driver navigates it to the
  // article itself below, and the click-to-jump checks click a link that
  // leaves a fragment behind for the next run.
  const origin = new URL(PAGE_URL).origin;
  const articleTarget = await findTarget((target) => target.url.startsWith(origin), {
    label: PAGE_URL,
  });
  await browser.send("Target.activateTarget", { targetId: articleTarget.id });

  // Extension pages can message the background worker; the worker cannot
  // message itself, so all commands are issued from the options page.
  await browser.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/options/options.html`,
    background: true,
  });
  const uiTarget = await findTarget((target) => target.url.endsWith("options/options.html"), {
    label: "options page",
  });
  const ui = await new Session(uiTarget.webSocketDebuggerUrl).open();
  await ui.send("Runtime.enable");
  await browser.send("Target.activateTarget", { targetId: articleTarget.id });

  const command = (payload) =>
    ui.evaluate(`new Promise((res) => chrome.runtime.sendMessage(${JSON.stringify(payload)}, res))`);

  // Commands without an explicit tab id go to the active tab, so make sure the
  // article is the active tab every time rather than racing the options tab.
  const control = async (action, args_ = {}) => {
    await browser.send("Target.activateTarget", { targetId: articleTarget.id });
    return command({ type: "control", action, args: args_ });
  };

  /**
   * What the API was asked to synthesise, so the checks can be about requests
   * and characters rather than guesses. Fetched from the page, which is where
   * `api.x.ai` resolves to the mock.
   */
  const synthesised = async () =>
    JSON.parse(
      await ui.evaluate(
        `fetch("https://api.x.ai/debug/requests").then((r) => r.json()).then((b) => JSON.stringify(b.requests))`,
      ),
    );

  // 1. Settings, the way the options page saves them.
  await ui.evaluate(`
    chrome.storage.local.set({
      apiKey: "test-key-for-local-mock",
      voiceId: "eve",
      language: "en",
      rate: 1,
      chunkChars: 400,
      autoScroll: true,
    }).then(() => true)
  `);
  check("settings persist to storage.local", true);

  // 2. Voice list through the background worker.
  const voices = await command({ type: "listVoices" });
  check(
    "GET /v1/tts/voices succeeds from the background worker",
    Boolean(voices?.ok && voices.voices?.length),
    voices?.ok ? `${voices.voices.length} voices` : voices?.error,
  );

  // A fresh document each run: a content script left over from a previous run
  // belongs to the previous extension instance and can no longer reach it.
  const page = await new Session(articleTarget.webSocketDebuggerUrl).open();
  await page.send("Page.enable");
  await page.send("Page.navigate", { url: PAGE_URL });
  await sleep(1500);
  await page.send("Runtime.enable");

  // 3. Start reading the page.
  const beforeFirstRead = (await synthesised()).length;
  const started = await control("start", { scope: "page" });
  check("start command reaches the page", Boolean(started?.ok), started?.error);

  const world = await page.isolatedContextId();
  await control("setRate", { rate: 2.5 });

  const probe = `
    (() => {
      const highlight = CSS.highlights.get("read-aloud-word");
      let word = null;
      if (highlight) for (const range of highlight) { word = range.toString(); break; }
      // The tinted sentence, which lasts seconds rather than a fraction of
      // one, so a check can name where the playhead is without racing it.
      const tint = CSS.highlights.get("read-aloud-sentence");
      let sentence = null;
      if (tint) for (const range of tint) { sentence = range.toString().trim().slice(0, 30); break; }
      const snapshot = globalThis.__readAloud?.reader?.snapshot?.() ?? {};
      return { word, sentence, status: snapshot.status, chunkIndex: snapshot.chunkIndex,
               chunkCount: snapshot.chunkCount, progress: snapshot.progress,
               engine: snapshot.engine, aligned: snapshot.aligned, error: snapshot.error,
               scrollY: Math.round(window.scrollY) };
    })()
  `;

  // 4. Watch the highlight advance.
  const observed = [];
  let sawPlaying = false;
  let chunkCount = 0;
  let engine = "";
  let failure = "";
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    const sample = await page.evaluate(probe, world);
    if (sample.status === "playing") sawPlaying = true;
    if (sample.chunkCount) chunkCount = sample.chunkCount;
    if (sample.engine && sample.engine !== "none") engine = sample.engine;
    if (sample.error) {
      failure = sample.error;
      break;
    }
    if (sample.word && observed.at(-1)?.word !== sample.word) observed.push(sample);
    if (sample.status === "idle" && sawPlaying) break;
  }

  check("no error during playback", !failure, failure);
  check("playback reached the playing state", sawPlaying, `engine: ${engine}`);
  check("article was split into chunks", chunkCount > 1, `${chunkCount} chunks`);
  check("words were highlighted", observed.length > 5, `${observed.length} distinct words`);

  // The wait before the first sound is the first request's size, so the shape
  // of the opening requests is worth asserting rather than just measuring.
  const opening = (await synthesised()).slice(beforeFirstRead);
  check(
    "the read opens with a short request",
    opening[0]?.chars > 0 && opening[0].chars <= 240,
    `${opening[0]?.chars} characters`,
  );
  check(
    "the opening request ends on a sentence boundary",
    /[.!?…。！？]["')\]]?$/.test(opening[0]?.tail.trimEnd() ?? ""),
    JSON.stringify(opening[0]?.tail.slice(-24)),
  );
  check(
    "later requests are bigger than the first",
    opening[1]?.chars > opening[0]?.chars,
    `${opening.slice(0, 4).map((entry) => entry.chars).join(" → ")} characters`,
  );
  // Whether the next request is issued alongside the first or only once the
  // first is playing is a question about timing, which this mock answers in
  // tens of milliseconds either way. tools/first-audio.js is where that is
  // measured; all that belongs here is that the request was made at all.
  check("the chunk after the first is fetched before it is needed", opening.length > 1, `${opening.length} requests`);

  // 5. The highlighted words must come from the article, in document order.
  const articleText = await page.evaluate(`document.querySelector("article").innerText.replace(/\\s+/g, " ")`);
  const found = observed.map((entry) => entry.word.trim()).filter(Boolean);
  const missing = found.filter((word) => !articleText.includes(word));
  check(
    "every highlighted word comes from the article",
    found.length > 0 && missing.length === 0,
    missing.slice(0, 5).join(", "),
  );

  let inOrder = found.length > 0;
  let cursor = 0;
  for (const word of found) {
    const at = articleText.indexOf(word, cursor);
    if (at < 0) {
      inOrder = false;
      break;
    }
    cursor = at;
  }
  check("highlights advance in document order", inOrder, found.slice(0, 8).join(" "));

  const skipped = ["Navigation:", "Sidebar:", "Footer:", "paragraph", "none"];
  check(
    "navigation, sidebar, footer and display:none text were skipped",
    !found.some((word) => skipped.includes(word)),
  );
  check("timestamps were used for alignment", observed.every((entry) => entry.aligned !== false));
  check(
    "auto-scroll followed the text",
    observed.some((entry) => entry.scrollY > 0),
    `max scrollY ${Math.max(0, ...observed.map((entry) => entry.scrollY))}`,
  );
  check(
    "playback crossed a chunk boundary",
    observed.some((entry) => entry.chunkIndex > 0),
    `reached chunk ${Math.max(0, ...observed.map((entry) => entry.chunkIndex)) + 1}`,
  );

  // 6. Pause, resume, stop.
  await control("start", { scope: "page" });
  await sleep(3000);
  const paused = await control("pause");
  const frozen = await page.evaluate(`
    (async () => {
      const before = globalThis.__readAloud.reader.snapshot().progress;
      await new Promise((r) => setTimeout(r, 800));
      return { before, after: globalThis.__readAloud.reader.snapshot().progress };
    })()
  `, world);
  check("pause halts the transport", paused?.state?.status === "paused", paused?.state?.status);
  check("progress freezes while paused", Math.abs(frozen.after - frozen.before) < 1e-6);

  const resumed = await control("resume");
  await sleep(1500);
  const afterResume = await page.evaluate(`globalThis.__readAloud.reader.snapshot().progress`, world);
  check(
    "resume continues from where it paused",
    resumed?.state?.status === "playing" && afterResume > frozen.after,
    `${frozen.after.toFixed(3)} → ${afterResume.toFixed(3)}`,
  );

  // 7. Speed control.
  await control("setRate", { rate: 2 });
  const fast = await page.evaluate(`
    (async () => {
      const a = globalThis.__readAloud.reader.snapshot().progress;
      await new Promise((r) => setTimeout(r, 1200));
      return globalThis.__readAloud.reader.snapshot().progress - a;
    })()
  `, world);
  await control("setRate", { rate: 1 });
  const normal = await page.evaluate(`
    (async () => {
      const a = globalThis.__readAloud.reader.snapshot().progress;
      await new Promise((r) => setTimeout(r, 1200));
      return globalThis.__readAloud.reader.snapshot().progress - a;
    })()
  `, world);
  check("2x plays faster than 1x", fast > normal * 1.4, `${fast.toFixed(4)} vs ${normal.toFixed(4)} per 1.2s`);

  const stopped = await control("stop");
  await sleep(400);
  const cleared = await page.evaluate(`
    (() => ({
      status: globalThis.__readAloud.reader.snapshot().status,
      highlight: CSS.highlights.get("read-aloud-word") ? "present" : "cleared",
    }))()
  `, world);
  check("stop resets the transport", stopped?.state?.status === "idle" && cleared.status === "idle");
  check("stop clears the highlight", cleared.highlight === "cleared");

  // 8. Selection scope.
  await page.evaluate(`
    (() => {
      const paragraph = document.querySelectorAll("article p")[2];
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()
  `);
  await control("start", { scope: "selection" });
  await sleep(3500);
  const selectionRun = await page.evaluate(`
    (() => {
      const snapshot = globalThis.__readAloud.reader.snapshot();
      const highlight = CSS.highlights.get("read-aloud-word");
      let word = null;
      if (highlight) for (const range of highlight) { word = range.toString(); break; }
      const paragraph = document.querySelectorAll("article p")[2].innerText.replace(/\\s+/g, " ");
      return { scope: snapshot.scope, chunkCount: snapshot.chunkCount, word,
               inParagraph: word ? paragraph.includes(word.trim()) : false };
    })()
  `, world);
  check("selection scope is honoured", selectionRun.scope === "selection", `${selectionRun.chunkCount} chunk(s)`);
  check("selection reading stays inside the selection", selectionRun.inParagraph, selectionRun.word ?? "no word");

  // 9. Click to jump.
  //
  // Clicks go through the input pipeline rather than `dispatchEvent`, so the
  // reader sees exactly what a user produces: a trusted pointerdown, mouseup
  // and click at real viewport coordinates, resolved through
  // `caretPositionFromPoint` against whatever is actually laid out there.
  await page.evaluate(
    `
    (() => {
      /**
       * Viewport centre of one word of an element, picked by its text so the
       * checks below can assert on a word that appears nowhere else — a jump
       * to "the" would be indistinguishable from not jumping at all.
       */
      window.wordPoint = (selector, elementIndex, needle) => {
        const element = document.querySelectorAll(selector)[elementIndex];
        const node = [...element.childNodes].find((child) => child.nodeType === 3 && child.data.includes(needle));
        const match = [...node.data.matchAll(/\\S+/g)].find((word) => word[0] === needle);
        if (!match) throw new Error("no word " + needle + " in " + selector + "[" + elementIndex + "]");
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getClientRects()[0];
        const occurrences = document.querySelector("article").innerText.split(/\\s+/)
          .filter((word) => word === needle).length;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, word: match[0], occurrences };
      };
      window.showElement = (selector, index = 0) => {
        document.querySelectorAll(selector)[index].scrollIntoView({ block: "center" });
        return window.scrollY;
      };
      return true;
    })()
  `,
    world,
  );

  const wordPoint = async (selector, elementIndex, needle) => {
    const point = JSON.parse(
      await page.evaluate(
        `JSON.stringify(window.wordPoint(${JSON.stringify(selector)}, ${elementIndex}, ${JSON.stringify(needle)}))`,
        world,
      ),
    );
    if (point.occurrences !== 1) throw new Error(`"${needle}" appears ${point.occurrences} times in the article`);
    return point;
  };

  const clickAt = async ({ x, y }) => {
    const common = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
  };

  /** Samples the highlight until `word` is the one being spoken. */
  const awaitHighlight = async (word, { timeoutMs = 2500 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    const seen = [];
    let sample = null;
    while (Date.now() < deadline) {
      sample = await page.evaluate(probe, world);
      const current = sample.word?.trim();
      if (current && seen.at(-1) !== current) seen.push(current);
      if (current === word) return { matched: true, seen, sample };
      await sleep(60);
    }
    return { matched: false, seen, sample };
  };

  /** Samples the reader until it reports `status`. */
  const awaitStatus = async (status, { timeoutMs = 15000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let sample = null;
    while (Date.now() < deadline) {
      sample = await page.evaluate(probe, world);
      if (sample.status === status || sample.error) return sample;
      await sleep(80);
    }
    return sample;
  };

  // A click outside the selection is outside everything a selection read knows
  // about, so it must do nothing. Paused, because a jump would resume playing.
  await control("pause");
  await page.evaluate(`window.showElement("article p", 0)`, world);
  const outsideSelection = await wordPoint("article p", 0, "dammed");
  const beforeOutside = await page.evaluate(probe, world);
  await clickAt(outsideSelection);
  await sleep(700);
  const afterOutside = await page.evaluate(probe, world);
  check(
    "a click outside the selection does not move a selection read",
    afterOutside.status === "paused" &&
      Math.abs(afterOutside.progress - beforeOutside.progress) < 1e-6,
    `${afterOutside.status}, progress ${beforeOutside.progress.toFixed(3)} → ${afterOutside.progress.toFixed(3)}`,
  );

  await control("stop");
  await control("start", { scope: "page" });
  await control("setRate", { rate: 0.5 });
  for (let i = 0; i < 80; i += 1) {
    const sample = await page.evaluate(probe, world);
    if (sample.status === "playing" && sample.word) break;
    await sleep(250);
  }

  // 9a. A word in the chunk already playing: a seek, no new request. The
  // opening chunk is deliberately short, so this is a word inside the first
  // sentence rather than at the end of the paragraph.
  const near = await wordPoint("article p", 0, "river.");
  const beforeNear = await page.evaluate(probe, world);
  const requestsBeforeNear = (await synthesised()).length;
  await clickAt(near);
  const nearJump = await awaitHighlight(near.word);
  const afterNear = await page.evaluate(probe, world);
  const requestsAfterNear = (await synthesised()).length;
  check(
    "clicking a word in the chunk being read jumps to it",
    nearJump.matched,
    `clicked "${near.word}", saw ${nearJump.seen.slice(-4).join(" ") || "nothing"}`,
  );
  check(
    "a jump inside the chunk does not change chunk",
    afterNear.chunkIndex === beforeNear.chunkIndex,
    `chunk ${beforeNear.chunkIndex} → ${afterNear.chunkIndex}`,
  );
  check(
    "a jump inside the chunk moves the playhead forward",
    afterNear.progress > beforeNear.progress,
    `${beforeNear.progress.toFixed(3)} → ${afterNear.progress.toFixed(3)}`,
  );
  check(
    "a jump inside the chunk costs no request",
    requestsAfterNear === requestsBeforeNear,
    `${requestsBeforeNear} → ${requestsAfterNear} requests`,
  );

  // 9b. A word in a chunk that has not been fetched, from a paused read:
  // the jump crosses chunks and playback resumes on its own.
  const held = await control("pause");
  check("paused before the cross-chunk jump", held?.state?.status === "paused", held?.state?.status);
  await page.evaluate(`window.showElement("article p", 4)`, world);
  const far = await wordPoint("article p", 4, "engineering");
  const beforeFar = await page.evaluate(probe, world);
  const requestsBeforeFar = await synthesised();
  await clickAt(far);
  const farJump = await awaitHighlight(far.word, { timeoutMs: 15000 });
  const afterFar = await awaitStatus("playing", { timeoutMs: 5000 });
  const newRequests = (await synthesised()).slice(requestsBeforeFar.length);
  check(
    "clicking into a chunk that was never fetched jumps to it",
    farJump.matched,
    `clicked "${far.word}", saw ${farJump.seen.slice(-4).join(" ") || "nothing"}`,
  );
  check(
    "the jump crossed into a later chunk",
    afterFar.chunkIndex > beforeFar.chunkIndex,
    `chunk ${beforeFar.chunkIndex} → ${afterFar.chunkIndex} of ${afterFar.chunkCount}`,
  );
  check("a jump from paused resumes playing", afterFar.status === "playing", afterFar.status);
  check(
    "the audio fetched for the jump starts on the clicked word",
    newRequests[0]?.head.startsWith(far.word),
    newRequests.map((entry) => `${entry.chars} chars: ${JSON.stringify(entry.head.slice(0, 24))}`).join(", "),
  );
  check("the jump kept timestamp alignment", afterFar.aligned !== false);
  check("no error during the jumps", !afterFar.error, afterFar.error);

  // The highlight and the scroll follow the jump rather than the old position.
  await sleep(1200);
  const framed = await page.evaluate(`
    (() => {
      const highlight = CSS.highlights.get("read-aloud-word");
      for (const range of highlight ?? []) {
        const rect = range.getBoundingClientRect();
        return { visible: rect.top >= 0 && rect.bottom <= window.innerHeight, word: range.toString() };
      }
      return { visible: false, word: null };
    })()
  `, world);
  check("the highlight stays on screen after the jump", framed.visible, framed.word ?? "no word");

  // 9c. A link inside the text keeps its own click. Paused, because a jump
  // would resume playing — so "still paused" is the whole assertion.
  await control("pause");
  await page.evaluate(`window.showElement("article a")`, world);
  const linkPoint = await page.evaluate(`
    (() => {
      const rect = document.querySelector("article a").getClientRects()[0];
      return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    })()
  `, world).then(JSON.parse);
  const beforeLink = await page.evaluate(probe, world);
  await clickAt(linkPoint);
  await sleep(700);
  const afterLink = await page.evaluate(probe, world);
  check(
    "a click on a link inside the text is not a jump",
    afterLink.status === "paused" && afterLink.chunkIndex === beforeLink.chunkIndex,
    `${afterLink.status}, chunk ${beforeLink.chunkIndex} → ${afterLink.chunkIndex}`,
  );
  check(
    "the link kept its own behaviour",
    await page.evaluate(`location.hash === "#tide-tables"`),
    await page.evaluate(`location.hash`),
  );

  // 9d. The setting turns it off.
  await ui.evaluate(`chrome.storage.local.set({ clickToJump: false }).then(() => true)`);
  await sleep(600);
  await page.evaluate(`window.showElement("article p", 3)`, world);
  const disabled = await wordPoint("article p", 3, "visitors");
  const beforeDisabled = await page.evaluate(probe, world);
  await clickAt(disabled);
  await sleep(700);
  const afterDisabled = await page.evaluate(probe, world);
  check(
    "clicking does nothing once the setting is off",
    afterDisabled.status === "paused" &&
      afterDisabled.chunkIndex === beforeDisabled.chunkIndex &&
      Math.abs(afterDisabled.progress - beforeDisabled.progress) < 1e-6,
    `${afterDisabled.status}, chunk ${beforeDisabled.chunkIndex} → ${afterDisabled.chunkIndex}`,
  );
  await ui.evaluate(`chrome.storage.local.set({ clickToJump: true }).then(() => true)`);

  // 9e. With nothing playing, a click is just a click.
  await control("stop");
  await sleep(300);
  const idlePoint = await wordPoint("article p", 3, "arrived,");
  await clickAt(idlePoint);
  await sleep(600);
  const afterIdle = await page.evaluate(probe, world);
  check(
    "clicking text with no read in progress does nothing",
    afterIdle.status === "idle" && !afterIdle.word,
    `${afterIdle.status}, ${afterIdle.word ?? "no highlight"}`,
  );

  // 10. Stepping a sentence at a time.
  //
  // The playhead is parked by clicking the first word of a paragraph, which
  // makes the audio in hand begin exactly there — so every step below stays
  // inside one request's audio and the assertions can name the word each one
  // must land on.
  await control("start", { scope: "page" });
  await control("setRate", { rate: 0.5 });
  for (let i = 0; i < 80; i += 1) {
    const sample = await page.evaluate(probe, world);
    if (sample.status === "playing" && sample.word) break;
    await sleep(250);
  }
  await page.evaluate(`window.showElement("article p", 2)`, world);
  const anchor = await wordPoint("article p", 2, "Grinding");
  await clickAt(anchor);
  const anchored = await awaitHighlight(anchor.word, { timeoutMs: 15000 });
  check("parked on the first word of a paragraph", anchored.matched, anchored.seen.slice(-3).join(" "));

  const requestsBeforeSteps = (await synthesised()).length;
  const step = async (delta) => {
    const response = await control("skipSentence", { delta });
    const sample = await page.evaluate(probe, world);
    return { ...sample, ok: Boolean(response?.ok), error: response?.error ?? sample.error };
  };

  const beforeForward = await page.evaluate(probe, world);
  const forward = await step(1);
  check(
    "stepping forward reaches the next sentence",
    forward.sentence?.startsWith("A mill that was busy") && forward.progress > beforeForward.progress,
    `${JSON.stringify(forward.sentence)}, progress ${beforeForward.progress.toFixed(3)} → ${forward.progress.toFixed(3)}`,
  );
  check("stepping forward keeps playing", forward.status === "playing", forward.status || forward.error);

  const second = await step(1);
  check(
    "a step lands on the first word of the sentence, not inside it",
    second.sentence?.startsWith("Millers slept") && second.word?.trim() === "Millers",
    `${JSON.stringify(second.word)} in ${JSON.stringify(second.sentence)}`,
  );

  // Back from the start of a sentence means the one before it, because there
  // is nothing of this one to have missed yet.
  const backFromStart = await step(-1);
  check(
    "stepping back from the start of a sentence reaches the one before it",
    backFromStart.sentence?.startsWith("A mill that was busy") &&
      backFromStart.progress < second.progress,
    `${JSON.stringify(backFromStart.sentence)}, progress ${second.progress.toFixed(3)} → ${backFromStart.progress.toFixed(3)}`,
  );

  // Back from the middle of one re-reads that sentence instead.
  await sleep(4000);
  const settled = await page.evaluate(probe, world);
  const replay = await step(-1);
  check(
    "stepping back from mid-sentence re-reads that sentence",
    replay.sentence?.startsWith("A mill that was busy") && replay.progress < settled.progress,
    `${JSON.stringify(replay.word)} in ${JSON.stringify(replay.sentence)}, progress ${settled.progress.toFixed(3)} → ${replay.progress.toFixed(3)}`,
  );
  check(
    "the sentence it re-reads is the one it was already in",
    settled.sentence?.startsWith("A mill that was busy"),
    JSON.stringify(settled.sentence),
  );

  const requestsAfterSteps = (await synthesised()).length;
  check(
    "steps within the audio already fetched cost no requests",
    requestsAfterSteps === requestsBeforeSteps,
    `${requestsBeforeSteps} → ${requestsAfterSteps} requests`,
  );

  // Stepping from paused behaves like clicking a word: it moves and plays on.
  await control("pause");
  const resumedByStep = await step(1);
  check(
    "a step from paused starts playing again",
    resumedByStep.status === "playing",
    resumedByStep.status || resumedByStep.error,
  );

  // Off the end there is nowhere to go, and saying so must not break the read.
  await control("stop");
  const stepWhileIdle = await step(1);
  check(
    "stepping with nothing being read does nothing",
    stepWhileIdle.ok && stepWhileIdle.status === "idle" && !stepWhileIdle.word,
    `${stepWhileIdle.status}, ${stepWhileIdle.word ?? "no highlight"}`,
  );

  await control("setRate", { rate: 1 });
  await control("stop");
  ui.close();
  page.close();
  browser.close();

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(`e2e failed: ${error.message}`);
  process.exit(1);
});
