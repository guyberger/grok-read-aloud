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
  // tab being driven is the active one rather than racing the options tab.
  const controlOn = async (targetId, action, args_ = {}) => {
    await browser.send("Target.activateTarget", { targetId });
    return command({ type: "control", action, args: args_ });
  };

  const control = (action, args_ = {}) => controlOn(articleTarget.id, action, args_);

  /** What the popup is handed when it opens on the article, state and all. */
  const tabState = async () => {
    await browser.send("Target.activateTarget", { targetId: articleTarget.id });
    return command({ type: "getTabState" });
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

  // Reassigned after a reload, which leaves the old isolated world behind.
  let world = await page.isolatedContextId();
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
               remainingSeconds: snapshot.remainingSeconds,
               engine: snapshot.engine, aligned: snapshot.aligned, error: snapshot.error,
               notice: snapshot.notice, scrollY: Math.round(window.scrollY) };
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

  /** Samples one tab's reader until it reports `status`. */
  const awaitStatusIn = async (session, contextId, status, { timeoutMs = 15000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let sample = null;
    while (Date.now() < deadline) {
      sample = await session.evaluate(probe, contextId);
      if (sample.status === status || sample.error) return sample;
      await sleep(80);
    }
    return sample;
  };

  /** Samples the article tab's reader until it reports `status`. */
  const awaitStatus = (status, options) => awaitStatusIn(page, world, status, options);

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

  // 11. Picking up where you left off.
  //
  // The page is reloaded between the two reads, so the content scripts, the
  // chunk list and every byte of audio are gone. All the second read has to go
  // on is what the first one wrote down.
  await control("start", { scope: "page" });
  await control("setRate", { rate: 0.5 });
  for (let i = 0; i < 80; i += 1) {
    const sample = await page.evaluate(probe, world);
    if (sample.status === "playing" && sample.word) break;
    await sleep(250);
  }
  // Deep enough into the article that continuing from it is worth offering,
  // and in a paragraph the checks below can name.
  await page.evaluate(`window.showElement("article p", 4)`, world);
  const leaveAt = await wordPoint("article p", 4, "engineering");
  await clickAt(leaveAt);
  const parked = await awaitHighlight(leaveAt.word, { timeoutMs: 15000 });
  check("parked deep in the article before leaving it", parked.matched, parked.seen.slice(-3).join(" "));

  const interrupted = await control("pause");
  check("the read is paused, not stopped", interrupted?.state?.status === "paused", interrupted?.state?.status);
  const leftOff = interrupted?.state?.resume;
  check(
    "a paused read reports where it was left off",
    (leftOff?.percent ?? 0) > 0.1,
    leftOff ? `${Math.round(leftOff.percent * 100)}% through` : "no position",
  );

  // Reloading is the honest version of coming back to a page later: nothing
  // of the previous read is still in memory to fall back on.
  await sleep(600);
  await page.send("Page.navigate", { url: PAGE_URL });
  await sleep(1500);
  const reloaded = await tabState();
  world = await page.isolatedContextId();
  check(
    "a freshly loaded page still knows where the read stopped",
    Math.abs((reloaded?.state?.resume?.percent ?? 0) - (leftOff?.percent ?? 0)) < 0.02,
    `${Math.round((reloaded?.state?.resume?.percent ?? 0) * 100)}% vs ${Math.round((leftOff?.percent ?? 0) * 100)}%`,
  );

  const beforeContinue = (await synthesised()).length;
  await control("start", { scope: "page" });
  const continued = await awaitStatus("playing", { timeoutMs: 20000 });
  const continueRequests = (await synthesised()).slice(beforeContinue);
  check("continuing a page starts playing", continued.status === "playing", continued.status || continued.error);
  // The request begins on the word the read was left on rather than carrying
  // the part of the page already heard — the same economy a jump gets.
  const continuedHead = continueRequests[0]?.head.slice(0, 30) ?? "";
  const headInParagraph = await page.evaluate(
    `
    (() => {
      const paragraph = document.querySelectorAll("article p")[4].innerText.replace(/\\s+/g, " ").trim();
      return paragraph.includes(${JSON.stringify(continuedHead)});
    })()
  `,
    world,
  );
  check(
    "the audio it asks for begins where the read left off, not at the top of the page",
    Boolean(continuedHead) && headInParagraph,
    `${continueRequests.length} request(s), first ${JSON.stringify(continuedHead)}`,
  );
  const landed = await page.evaluate(
    `
    (() => {
      const highlight = CSS.highlights.get("read-aloud-word");
      let word = null;
      for (const range of highlight ?? []) { word = range.toString().trim(); break; }
      const paragraph = document.querySelectorAll("article p")[4].innerText.replace(/\\s+/g, " ");
      return { word, inParagraph: word ? paragraph.includes(word) : false };
    })()
  `,
    world,
  );
  check(
    "the highlight comes back in the paragraph the read was left in",
    landed.inParagraph,
    landed.word ?? "no word",
  );
  check(
    "continuing does not renumber the page into one short piece",
    continued.chunkCount > 1 && continued.chunkIndex > 0,
    `part ${continued.chunkIndex + 1} of ${continued.chunkCount}`,
  );

  // Start over is the way back to the top, and it forgets the position so the
  // next read cannot be pulled into the middle again.
  const beforeOver = (await synthesised()).length;
  await control("start", { scope: "page", from: "start" });
  await awaitStatus("playing", { timeoutMs: 20000 });
  const overRequests = (await synthesised()).slice(beforeOver);
  check(
    "starting over asks for the opening of the page again",
    overRequests[0]?.head === opening[0]?.head,
    JSON.stringify(overRequests[0]?.head.slice(0, 40) ?? "no request"),
  );

  // Stop is the control that says this page is done with.
  await control("stop");
  await sleep(400);
  const afterStopped = await tabState();
  check(
    "stopping forgets the position",
    afterStopped?.state?.resume === null,
    JSON.stringify(afterStopped?.state?.resume),
  );

  // 12. Sign in with xAI.
  //
  // The whole flow, against the mock OAuth server: a device code, the
  // approval page in its own tab with a real click on it, the poll that
  // finishes once it is approved, a refresh, the 403 tier gate falling back to
  // the key, and sign-out. The mock issues opaque tokens that mean nothing
  // anywhere, and every assertion below is about what it was shown rather than
  // about the tokens themselves — nothing here ever reads one.
  const oauthDebug = async () =>
    JSON.parse(
      await ui.evaluate(
        `fetch("https://auth.x.ai/debug/oauth").then((r) => r.json()).then((b) => JSON.stringify(b))`,
      ),
    );
  const setGate = (on) =>
    ui.evaluate(`fetch("https://auth.x.ai/debug/oauth/gate?on=${on ? 1 : 0}", { method: "POST" }).then(() => true)`);
  const authState = () => command({ type: "xaiAuthState" });

  /** Samples the sign-in state until `predicate` holds, or gives up. */
  const awaitAuth = async (predicate, { timeoutMs = 20000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let state = null;
    while (Date.now() < deadline) {
      state = await authState();
      if (state?.ok && predicate(state)) return state;
      await sleep(200);
    }
    return state;
  };

  await ui.evaluate(`chrome.storage.local.remove("xaiOAuth").then(() => true)`);
  const signedOut = await authState();
  check(
    "starts signed out",
    signedOut?.ok && signedOut.status.signedIn === false,
    JSON.stringify(signedOut?.status),
  );

  // 11a. The device code, and the prompt it produces.
  const signIn = await command({ type: "xaiSignIn" });
  check(
    "sign-in asks xAI for a device code and a user code",
    Boolean(signIn?.ok && signIn.flow?.userCode && signIn.flow?.verificationUrl),
    signIn?.ok ? `code ${signIn.flow.userCode} at ${signIn.flow.verificationUrl}` : signIn?.error,
  );
  check(
    "the verification URL carries the user code, so approving needs no typing",
    signIn?.flow?.verificationUrlComplete?.includes(signIn.flow.userCode),
    signIn?.flow?.verificationUrlComplete,
  );

  const waiting = await authState();
  check(
    "a sign-in in progress is visible to any UI that opens",
    Boolean(waiting?.ok && waiting.pending && waiting.flow.userCode === signIn.flow.userCode),
    `pending: ${waiting?.pending}`,
  );

  // 11b. Approval, in the tab the worker opened, with a click on the page.
  const approvalTarget = await findTarget((target) => target.url.includes("accounts.x.ai/oauth2/device"), {
    label: "xAI approval page",
  });
  check("the approval page opens in its own tab", Boolean(approvalTarget), approvalTarget?.url);

  const approval = await new Session(approvalTarget.webSocketDebuggerUrl).open();
  await approval.send("Runtime.enable");
  const shownCode = await approval.evaluate(`document.getElementById("code")?.textContent ?? ""`);
  check(
    "the approval page shows the same code the extension did",
    shownCode === signIn.flow.userCode,
    `${shownCode} vs ${signIn.flow.userCode}`,
  );
  await approval.evaluate(`document.getElementById("approve").click()`);

  const approved = await awaitAuth((state) => state.status.signedIn);
  check(
    "approving finishes the sign-in",
    Boolean(approved?.status?.signedIn),
    approved?.status?.signedIn ? `expires in ${approved.status.expiresInSeconds}s` : JSON.stringify(approved?.status),
  );
  check("the finished sign-in can refresh itself", approved?.status?.canRefresh === true);
  check("the sign-in prompt is cleared once it is done", approved?.pending === false);
  check(
    "no token is in the state the UI is handed",
    !JSON.stringify(approved?.status ?? {}).includes("mock-oauth"),
    JSON.stringify(approved?.status),
  );
  approval.close();

  // 11c. From here the API is reached with the sign-in, not the key.
  const beforeSignedInRead = (await synthesised()).length;
  await control("start", { scope: "page" });
  await sleep(2500);
  const signedInRequests = (await synthesised()).slice(beforeSignedInRead);
  check(
    "a read while signed in goes out with the OAuth token",
    signedInRequests.length > 0 && signedInRequests.every((entry) => entry.auth === "oauth"),
    signedInRequests.map((entry) => entry.auth).join(", ") || "no requests",
  );
  await control("stop");

  // 11d. Refresh before expiry: a token nearly spent is swapped for a new one
  // on the next call, without anybody being asked to sign in again.
  const beforeRefresh = await oauthDebug();
  await ui.evaluate(`
    chrome.storage.local.get("xaiOAuth")
      .then(({ xaiOAuth }) =>
        chrome.storage.local.set({ xaiOAuth: { ...xaiOAuth, expiresAt: Date.now() + 30000 } }))
      .then(() => true)
  `);
  const afterRefreshCall = await command({ type: "listVoices" });
  const afterRefresh = await oauthDebug();
  check(
    "a nearly-expired token is refreshed before it is used",
    afterRefresh.issued > beforeRefresh.issued &&
      afterRefresh.tokenRequests.some((entry) => entry.grantType === "refresh_token"),
    `issued ${beforeRefresh.issued} → ${afterRefresh.issued}`,
  );
  check("the request after a refresh succeeds", Boolean(afterRefreshCall?.ok), afterRefreshCall?.error);
  check(
    "the spent refresh token is replaced rather than kept alongside",
    afterRefresh.liveRefreshTokens === 1,
    `${afterRefresh.liveRefreshTokens} live`,
  );

  // 11e. A token the API no longer knows: one refresh, then the same request
  // again. A 401 is a stale token until a second attempt says otherwise.
  await ui.evaluate(`
    chrome.storage.local.get("xaiOAuth")
      .then(({ xaiOAuth }) =>
        chrome.storage.local.set({
          xaiOAuth: { ...xaiOAuth, accessToken: "mock-oauth-access-never-issued" },
        }))
      .then(() => true)
  `);
  const beforeStale = await oauthDebug();
  const afterStale = await command({ type: "listVoices" });
  const staleDebug = await oauthDebug();
  check(
    "a 401 is retried once with a freshly refreshed token",
    Boolean(afterStale?.ok) && afterStale.source === "oauth" && staleDebug.issued > beforeStale.issued,
    afterStale?.ok ? `source ${afterStale.source}` : afterStale?.error,
  );

  // 11f. The tier gate. xAI answers 403 to OAuth accounts it will not let
  // through, and the key is what catches that.
  await setGate(true);
  const beforeGated = (await synthesised()).length;
  const gatedRead = await command({
    type: "synthesize",
    text: "Gated accounts fall back to the key.",
    voiceId: "eve",
    language: "en",
  });
  const gatedRequests = (await synthesised()).slice(beforeGated);
  check("a gated sign-in still produces audio", Boolean(gatedRead?.ok), gatedRead?.error);
  check(
    "the audio came from the API key, not the gated sign-in",
    gatedRequests.at(-1)?.auth === "apiKey",
    gatedRequests.map((entry) => entry.auth).join(" → ") || "no requests",
  );
  check(
    "the fallback says why it happened",
    /not let the signed-in account through/i.test(gatedRead?.notice ?? ""),
    JSON.stringify(gatedRead?.notice ?? ""),
  );
  const gatedState = await authState();
  check(
    "a gated account is recorded as signed in but gated",
    gatedState?.status?.signedIn === true && gatedState.status.tierDenied === true,
    JSON.stringify(gatedState?.status),
  );

  // Once gated, the sign-in is not tried again until something succeeds: the
  // next request goes straight out with the key.
  const beforeSecondGated = (await synthesised()).length;
  const secondGated = await command({
    type: "synthesize",
    text: "The second one leads with the key.",
    voiceId: "eve",
    language: "en",
  });
  const secondGatedRequests = (await synthesised()).slice(beforeSecondGated);
  check(
    "a gated sign-in is not retried on every request",
    secondGated?.ok && secondGatedRequests.length === 1 && secondGatedRequests[0].auth === "apiKey",
    `${secondGatedRequests.length} request(s): ${secondGatedRequests.map((entry) => entry.auth).join(", ")}`,
  );

  // 11g. Gated with no key to fall back on: the one case that has to fail, and
  // has to say why.
  await ui.evaluate(`chrome.storage.local.set({ apiKey: "" }).then(() => true)`);
  const strandedRead = await command({
    type: "synthesize",
    text: "Nothing to fall back to.",
    voiceId: "eve",
    language: "en",
  });
  check(
    "gated with no key fails with an explanation rather than a bare 403",
    strandedRead?.ok === false && /subscription tier/i.test(strandedRead.error ?? ""),
    strandedRead?.error,
  );
  await ui.evaluate(`chrome.storage.local.set({ apiKey: "test-key-for-local-mock" }).then(() => true)`);
  await setGate(false);

  // 11h. Sign out: the tokens go, the grant is revoked, and the key takes over.
  const beforeSignOut = await oauthDebug();
  const signedOutAgain = await command({ type: "xaiSignOut" });
  const afterSignOut = await oauthDebug();
  check("signing out reports no session", signedOutAgain?.status?.signedIn === false, signedOutAgain?.error);
  check(
    "signing out revokes the grant at xAI",
    beforeSignOut.liveRefreshTokens > 0 && afterSignOut.liveRefreshTokens === 0,
    `${beforeSignOut.liveRefreshTokens} → ${afterSignOut.liveRefreshTokens} live refresh tokens`,
  );
  const storedAfterSignOut = await ui.evaluate(
    `chrome.storage.local.get("xaiOAuth").then((v) => JSON.stringify(v))`,
  );
  check("signing out leaves nothing in storage", storedAfterSignOut === "{}", storedAfterSignOut);

  const beforeKeyOnly = (await synthesised()).length;
  const keyOnlyRead = await command({
    type: "synthesize",
    text: "Back to the key alone.",
    voiceId: "eve",
    language: "en",
  });
  const keyOnlyRequests = (await synthesised()).slice(beforeKeyOnly);
  check(
    "after signing out the key is used again, with nothing to explain",
    Boolean(keyOnlyRead?.ok) && !keyOnlyRead.notice && keyOnlyRequests.at(-1)?.auth === "apiKey",
    `${keyOnlyRequests.at(-1)?.auth}${keyOnlyRead?.notice ? `, notice: ${keyOnlyRead.notice}` : ""}`,
  );

  // 11i. Neither credential: the popup and the page have to say so, not hang.
  await ui.evaluate(`chrome.storage.local.set({ apiKey: "" }).then(() => true)`);
  await sleep(400);
  const noCredentials = await control("start", { scope: "page" });
  check(
    "with no credentials at all, the reader says what is missing",
    /sign in with xai/i.test(noCredentials?.state?.error ?? ""),
    noCredentials?.state?.error,
  );
  await ui.evaluate(`chrome.storage.local.set({ apiKey: "test-key-for-local-mock" }).then(() => true)`);
  await control("stop");

  // 13. One read at a time, across tabs.
  //
  // Two tabs on the same article, each with its own reader and neither able to
  // see the other. The tab that starts speaking last keeps the audio; the one
  // that had it pauses itself, says why, and keeps its place — so taking the
  // read back is one resume, which silences the second tab in turn.
  const secondUrl = `${PAGE_URL}?second=1`;
  await browser.send("Target.createTarget", { url: secondUrl, background: true });
  const secondTarget = await findTarget((target) => target.url.startsWith(secondUrl), {
    label: secondUrl,
  });
  const secondTab = await new Session(secondTarget.webSocketDebuggerUrl).open();
  await secondTab.send("Page.enable");
  await secondTab.send("Runtime.enable");

  await control("start", { scope: "page", from: "start" });
  world = await page.isolatedContextId();
  const firstReading = await awaitStatus("playing", { timeoutMs: 20000 });
  check(
    "the first tab is reading",
    firstReading.status === "playing",
    firstReading.status || firstReading.error,
  );

  await controlOn(secondTarget.id, "start", { scope: "page", from: "start" });
  const secondWorld = await secondTab.isolatedContextId();
  const secondReading = await awaitStatusIn(secondTab, secondWorld, "playing", { timeoutMs: 20000 });
  check(
    "a second tab can start its own read",
    secondReading.status === "playing",
    secondReading.status || secondReading.error,
  );

  const handedOver = await awaitStatusIn(page, world, "paused", { timeoutMs: 8000 });
  check(
    "the tab that was reading goes quiet when another starts",
    handedOver.status === "paused",
    handedOver.status || handedOver.error,
  );
  check(
    "the tab that went quiet says why",
    /another tab/i.test(handedOver.notice ?? ""),
    JSON.stringify(handedOver.notice ?? ""),
  );
  check(
    "the tab that took the read keeps playing",
    (await secondTab.evaluate(probe, secondWorld)).status === "playing",
  );

  // Resuming is how the read comes back, and it hands over the same way.
  await control("resume");
  const firstAgain = await awaitStatus("playing", { timeoutMs: 10000 });
  const secondQuiet = await awaitStatusIn(secondTab, secondWorld, "paused", { timeoutMs: 8000 });
  check(
    "resuming the quiet tab takes the read back",
    firstAgain.status === "playing",
    firstAgain.status || firstAgain.error,
  );
  check(
    "the tab it was taken from pauses in turn",
    secondQuiet.status === "paused",
    secondQuiet.status || secondQuiet.error,
  );
  check(
    "taking the read back drops the explanation",
    !firstAgain.notice,
    JSON.stringify(firstAgain.notice ?? ""),
  );
  check(
    "the tab that was paused carries on rather than starting again",
    firstAgain.chunkIndex === handedOver.chunkIndex &&
      firstAgain.progress >= handedOver.progress - 1e-6,
    `chunk ${handedOver.chunkIndex} → ${firstAgain.chunkIndex}, progress ${handedOver.progress.toFixed(3)} → ${firstAgain.progress.toFixed(3)}`,
  );

  await controlOn(secondTarget.id, "stop");
  await control("stop");
  secondTab.close();
  await browser.send("Target.closeTarget", { targetId: secondTarget.id }).catch(() => {});

  // 14. Code on a page, in its two forms.
  //
  // A documentation page is where this decides whether a sentence makes sense
  // at all, so this section reads one from top to bottom: code written into a
  // sentence has to be spoken and highlighted like any other word, and a whole
  // snippet has to be passed over unless the setting asks for it.
  const codePageUrl = new URL("inline-code.html", PAGE_URL).href;
  await page.send("Page.navigate", { url: codePageUrl });
  await sleep(1500);
  // Opening the popup is what injects the content scripts into a page that
  // has just loaded, so the isolated world only exists after this.
  await tabState();
  world = await page.isolatedContextId();

  const codeProbe = `
    (() => {
      const highlight = CSS.highlights.get("read-aloud-word");
      let word = null;
      let inCode = false;
      for (const range of highlight ?? []) {
        word = range.toString();
        let node = range.commonAncestorContainer;
        if (node.nodeType !== 1) node = node.parentElement;
        inCode = Boolean(node?.closest("code"));
        break;
      }
      const snapshot = globalThis.__readAloud?.reader?.snapshot?.() ?? {};
      return { word, inCode, status: snapshot.status, chunkCount: snapshot.chunkCount,
               error: snapshot.error };
    })()
  `;

  await control("start", { scope: "page", from: "start" });
  await control("setRate", { rate: 3 });

  const spoken = [];
  let codeChunkCount = 0;
  let codeError = "";
  let readCodeWord = false;
  let sawCodePlaying = false;
  for (let i = 0; i < 260; i += 1) {
    const sample = await page.evaluate(codeProbe, world);
    if (sample.status === "playing") sawCodePlaying = true;
    if (sample.chunkCount) codeChunkCount = sample.chunkCount;
    if (sample.error) {
      codeError = sample.error;
      break;
    }
    const current = sample.word?.trim();
    if (current && spoken.at(-1) !== current) spoken.push(current);
    if (current === "autoCommit" && sample.inCode) readCodeWord = true;
    if (sample.status === "idle" && sawCodePlaying) break;
    await sleep(150);
  }

  check("the documentation page was read to the end", !codeError && spoken.length > 20, codeError || `${spoken.length} words`);
  check(
    "code written into a sentence is spoken with it",
    spoken.includes("autoCommit") && spoken.includes("build.config.json"),
    spoken.slice(0, 8).join(" "),
  );
  check("the highlight lands on the code element itself", readCodeWord);
  const snippetWords = spoken.filter((word) => /scheduleCron|retainBuilds|timeoutMinutes|rotateSecrets/.test(word));
  check("whole snippets are passed over", snippetWords.length === 0, snippetWords.slice(0, 5).join(" "));

  await control("stop");
  await ui.evaluate(`chrome.storage.local.set({ readCodeBlocks: true }).then(() => true)`);
  await sleep(600);
  await control("start", { scope: "page", from: "start" });
  const withSnippets = await awaitStatus("playing", { timeoutMs: 20000 });
  check(
    "the setting puts the snippets back into the read",
    withSnippets.chunkCount > codeChunkCount,
    `${codeChunkCount} → ${withSnippets.chunkCount} parts`,
  );
  await control("stop");
  await ui.evaluate(`chrome.storage.local.set({ readCodeBlocks: false }).then(() => true)`);

  // 15. How long is left.
  //
  // The estimate is the characters left times the seconds a character takes,
  // with the chunk in hand timed rather than multiplied out — so the checks
  // are that it is in the region the audio itself implies, that it only ever
  // falls, that the speed control moves it, and that it is withdrawn rather
  // than left on screen when there is nothing being read.
  await page.send("Page.navigate", { url: PAGE_URL });
  await sleep(1500);
  await tabState();
  world = await page.isolatedContextId();

  const idleEstimate = await page.evaluate(probe, world);
  check(
    "with nothing being read there is no estimate to give",
    idleEstimate.remainingSeconds === null,
    JSON.stringify(idleEstimate.remainingSeconds),
  );

  await control("setRate", { rate: 1 });
  await control("start", { scope: "page", from: "start" });
  const timing = await awaitStatus("playing", { timeoutMs: 20000 });

  // What the mock's own audio says this article is worth: it answers with
  // 0.055 seconds of audio per character of text. `innerText` is the rendered
  // text, so the paragraph the fixture hides is already out of it — the same
  // text the extraction walk arrives at.
  const readableChars = await page.evaluate(
    `document.querySelector("article").innerText.replace(/\\s+/g, " ").trim().length`,
  );
  const impliedSeconds = readableChars * 0.055;
  check(
    "a read says how long is left, in the region the audio implies",
    timing.remainingSeconds > impliedSeconds * 0.6 && timing.remainingSeconds < impliedSeconds * 1.4,
    `${Math.round(timing.remainingSeconds)}s estimated against ${Math.round(impliedSeconds)}s of audio for ${readableChars} characters`,
  );

  // Sampled across a chunk boundary, where the estimate stops multiplying one
  // chunk out and starts timing the next — the one place it could jump.
  const falling = [];
  let crossed = 0;
  for (let i = 0; i < 60; i += 1) {
    const sample = await page.evaluate(probe, world);
    if (sample.status !== "playing") break;
    crossed = Math.max(crossed, sample.chunkIndex);
    falling.push(sample.remainingSeconds);
    await sleep(500);
    if (crossed > 0 && falling.length > 8) break;
  }
  const rose = falling.filter((seconds, i) => i > 0 && seconds > falling[i - 1] + 0.75);
  check(
    "the estimate falls as the read advances, including across a chunk boundary",
    falling.length > 4 && falling.at(-1) < falling[0] && rose.length === 0,
    `${falling.map((seconds) => Math.round(seconds)).join(" → ")}s over part ${crossed + 1}`,
  );

  const atNormalSpeed = (await page.evaluate(probe, world)).remainingSeconds;
  await control("setRate", { rate: 2 });
  await sleep(300);
  const atDoubleSpeed = (await page.evaluate(probe, world)).remainingSeconds;
  check(
    "reading twice as fast halves the time left",
    Math.abs(atDoubleSpeed - atNormalSpeed / 2) < Math.max(2, atNormalSpeed * 0.06),
    `${Math.round(atNormalSpeed)}s at 1x → ${Math.round(atDoubleSpeed)}s at 2x`,
  );
  await control("setRate", { rate: 1 });

  // Paused, the estimate is still the answer to how much is left; stopped,
  // there is nothing left to be left of.
  await control("pause");
  const pausedEstimate = await page.evaluate(probe, world);
  check(
    "a paused read still says how much is left",
    pausedEstimate.remainingSeconds > 0,
    `${Math.round(pausedEstimate.remainingSeconds ?? 0)}s`,
  );
  await control("stop");
  await sleep(300);
  const stoppedEstimate = await page.evaluate(probe, world);
  check(
    "stopping withdraws the estimate",
    stoppedEstimate.remainingSeconds === null,
    JSON.stringify(stoppedEstimate.remainingSeconds),
  );

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
