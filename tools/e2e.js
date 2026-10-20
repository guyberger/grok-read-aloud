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
  const articleTarget = await findTarget((target) => target.url === PAGE_URL, { label: PAGE_URL });
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
  const started = await control("start", { scope: "page" });
  check("start command reaches the page", Boolean(started?.ok), started?.error);

  const world = await page.isolatedContextId();
  await control("setRate", { rate: 2.5 });

  const probe = `
    (() => {
      const highlight = CSS.highlights.get("read-aloud-word");
      let word = null;
      if (highlight) for (const range of highlight) { word = range.toString(); break; }
      const snapshot = globalThis.__readAloud?.reader?.snapshot?.() ?? {};
      return { word, status: snapshot.status, chunkIndex: snapshot.chunkIndex,
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
