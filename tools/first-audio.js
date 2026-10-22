/**
 * Measures time-to-first-audio: pressing read, to the first moment the audio
 * is actually advancing.
 *
 * It drives the same Chrome and mock API that tools/e2e.js uses — see the
 * README for the one-off setup — and reports the wait in three parts:
 *
 *   press → request      everything before the API sees anything: waking the
 *                        worker, reaching the page, reading settings,
 *                        extracting the text, cutting the first chunk
 *   request → response   the API itself, under whatever latency model the mock
 *                        was started with, driven by the first chunk's size
 *   response → audible   decoding the audio and getting it playing
 *
 * The middle part is a model. The outer two are measured, and the size of the
 * first request — the thing the extension controls — is reported with them.
 *
 *   node tools/first-audio.js --extension "$PWD/dist/chrome-test" --runs 5
 */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const CDP = args.get("cdp") ?? "http://127.0.0.1:9333";
const PAGE_URL = args.get("page") ?? "http://127.0.0.1:8777/article.html";
const EXTENSION_DIR = args.get("extension") ?? new URL("../dist/chrome-test", import.meta.url).pathname;
const RUNS = Number(args.get("runs") ?? 5);
const CHUNK_CHARS = Number(args.get("chunk-chars") ?? 1200);
const LABEL = args.get("label") ?? "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Session {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.contexts = [];
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error(`cannot connect to ${this.url}`));
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
      }, 60000);
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

  /** The isolated world that holds a live reader. */
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
      await sleep(200);
    }
    throw new Error("content script execution context never appeared");
  }

  close() {
    this.socket.close();
  }
}

async function findTarget(predicate, label) {
  for (let i = 0; i < 50; i += 1) {
    const list = await (await fetch(`${CDP}/json/list`)).json();
    const found = list.find(predicate);
    if (found?.webSocketDebuggerUrl) return found;
    await sleep(300);
  }
  throw new Error(`target not found: ${label}`);
}

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    median: sorted[(sorted.length - 1) >> 1],
    mean: sum / sorted.length,
    max: sorted.at(-1),
  };
}

const ms = (value) => `${Math.round(value)}ms`;

async function main() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const browser = await new Session(version.webSocketDebuggerUrl).open();

  let extensionId = args.get("id");
  if (!extensionId) {
    extensionId = (await browser.send("Extensions.loadUnpacked", { path: EXTENSION_DIR })).id;
  }

  // Any tab on the fixture server will do; every run navigates it to the page
  // under measurement anyway.
  const origin = new URL(PAGE_URL).origin;
  const articleTarget = await findTarget((t) => t.url.startsWith(origin), origin);
  await browser.send("Target.activateTarget", { targetId: articleTarget.id });
  await browser.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/options/options.html`,
    background: true,
  });
  const uiTarget = await findTarget((t) => t.url.endsWith("options/options.html"), "options page");
  const ui = await new Session(uiTarget.webSocketDebuggerUrl).open();
  await ui.send("Runtime.enable");

  await ui.evaluate(`
    chrome.storage.local.set({
      apiKey: "test-key-for-local-mock",
      voiceId: "eve",
      language: "en",
      rate: 1,
      chunkChars: ${CHUNK_CHARS},
      autoScroll: true,
    }).then(() => true)
  `);

  const requests = async () =>
    JSON.parse(
      await ui.evaluate(
        `fetch("https://api.x.ai/debug/requests").then((r) => r.json()).then((b) => JSON.stringify(b.requests))`,
      ),
    );

  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    // A fresh document every run: nothing cached, nothing injected, the
    // content script not yet there — the state a first read actually starts in.
    const page = await new Session(articleTarget.webSocketDebuggerUrl).open();
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Page.navigate", { url: PAGE_URL });
    await sleep(1200);
    await browser.send("Target.activateTarget", { targetId: articleTarget.id });

    const before = (await requests()).length;

    // Both clocks are wall clock on one machine, so the page can be watched
    // from the page and the press timed in the extension context.
    const pressedAt = await ui.evaluate(`
      (() => {
        const pressedAt = Date.now();
        // From the top every run: a position left behind by an earlier run
        // would shorten the first request and flatter the measurement.
        chrome.runtime.sendMessage({
          type: "control",
          action: "start",
          args: { scope: "page", from: "start" },
        });
        return pressedAt;
      })()
    `);

    // The reader reports progress only once the playhead has actually moved,
    // which is the first moment there is something to hear.
    const world = await page.isolatedContextId();
    const audibleAt = await page.evaluate(
      `
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 40000;
        const tick = () => {
          const snapshot = globalThis.__readAloud?.reader?.snapshot?.();
          if (snapshot?.error) return reject(new Error(snapshot.error));
          if (snapshot?.status === "playing" && snapshot.progress > 0) return resolve(Date.now());
          if (Date.now() > deadline) return reject(new Error("never became audible"));
          setTimeout(tick, 5);
        };
        tick();
      })
    `,
      world,
    );

    const served = (await requests()).slice(before);
    const first = served[0];
    if (!first) throw new Error("the API was never asked for anything");

    samples.push({
      total: audibleAt - pressedAt,
      toRequest: first.receivedAt - pressedAt,
      api: first.respondedAt - first.receivedAt,
      toAudible: audibleAt - first.respondedAt,
      chars: first.chars,
      requestsBeforeAudible: served.filter((entry) => entry.receivedAt <= audibleAt).length,
    });

    await ui.evaluate(
      `new Promise((res) => chrome.runtime.sendMessage({ type: "control", action: "stop" }, res))`,
    );
    page.close();
    await sleep(400);
  }

  const field = (name) => summarise(samples.map((sample) => sample[name]));
  const total = field("total");
  console.log(`\ntime to first audio${LABEL ? ` — ${LABEL}` : ""} (${RUNS} runs, chunkChars=${CHUNK_CHARS})\n`);
  console.log(`  first request        ${samples[0].chars} characters`);
  console.log(`  requests before audio ${samples[0].requestsBeforeAudible}`);
  console.log(`  press → request      ${ms(field("toRequest").median)} median  (${ms(field("toRequest").min)}–${ms(field("toRequest").max)})`);
  console.log(`  request → response   ${ms(field("api").median)} median  (modelled)`);
  console.log(`  response → audible   ${ms(field("toAudible").median)} median  (${ms(field("toAudible").min)}–${ms(field("toAudible").max)})`);
  console.log(`  total                ${ms(total.median)} median  (${ms(total.min)}–${ms(total.max)}, mean ${ms(total.mean)})`);
  console.log(`\n  runs: ${samples.map((sample) => ms(sample.total)).join(", ")}`);

  ui.close();
  browser.close();
}

main().catch((error) => {
  console.error(`first-audio failed: ${error.message}`);
  process.exit(1);
});
