/**
 * TEMPORARY DIAGNOSTIC — not part of the build or the checks.
 *
 * `src/dev/reload.js` guards its `chrome.runtime.reload()` with `popupIsOpen()`
 * so a rebuild cannot close the panel mid-click. This measures how good that
 * guard is, in two parts:
 *
 *   1. The sampling gap. `popupIsOpen()` asks
 *      `chrome.runtime.getContexts({ contextTypes: ["POPUP"] })`. A popup that
 *      is being created is not necessarily in that list yet, so this times the
 *      first moment the worker can see an opening popup and compares it with
 *      the moment the popup document actually came into existence. Anything in
 *      between is a window in which the guard answers "no popup" about a popup
 *      the user is already looking at.
 *
 *   2. The staleness gap. `check()` samples the guard once, then pings the
 *      active tab (up to 2 s) and reloads it (up to 2 s) before it reloads the
 *      extension. This replays the real sequence and reports how long the
 *      decision is already old by the time it is acted on.
 *
 *   node tools/popup-reload-race.js --runs 10
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const RUNS = Number(args.get("runs") ?? 10);
const CDP_PORT = Number(args.get("port") ?? 9560);
const FIXTURE_PORT = Number(args.get("fixture-port") ?? 8860);
const EXTENSION_DIR = resolve(args.get("extension") ?? new URL("../dist/chrome-test", import.meta.url).pathname);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const unpackedExtensionId = (path) =>
  [...createHash("sha256").update(path).digest("hex").slice(0, 32)]
    .map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)))
    .join("");

function serveFixtures() {
  const root = new URL("../tests/fixtures/", import.meta.url);
  const server = createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
      const body = await readFile(new URL(name, root), "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((done) => server.listen(FIXTURE_PORT, "127.0.0.1", () => done(server)));
}

class Session {
  constructor(url) {
    this.url = url;
    this.id = 1;
    this.pending = new Map();
  }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.socket.onopen = res;
      this.socket.onerror = () => rej(new Error(`cannot connect to ${this.url}`));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    };
    return this;
  }
  send(method, params = {}) {
    const id = this.id++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => this.pending.delete(id) && rej(new Error(`${method} timed out`)), 60000);
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
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

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) ?? [];
}

async function waitForTarget(predicate, { label, tries = 60, every = 250 }) {
  for (let i = 0; i < tries; i += 1) {
    const found = (await targets()).find(predicate);
    if (found) return found;
    await sleep(every);
  }
  throw new Error(`target never appeared: ${label}`);
}

function stats(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  return {
    median: clean[Math.floor(clean.length / 2)],
    p90: clean[Math.min(clean.length - 1, Math.floor(clean.length * 0.9))],
    min: clean[0],
    max: clean.at(-1),
  };
}

const row = (label, s) =>
  s
    ? `${label.padEnd(44)} median ${s.median.toFixed(1).padStart(7)}ms   p90 ${s.p90.toFixed(1).padStart(7)}ms   ` +
      `min ${s.min.toFixed(1).padStart(7)}ms   max ${s.max.toFixed(1).padStart(7)}ms`
    : `${label.padEnd(44)} no samples`;

async function main() {
  const fixtures = await serveFixtures();
  const extensionId = unpackedExtensionId(EXTENSION_DIR);
  const profile = `/tmp/ra-reload-race-${CDP_PORT}`;
  rmSync(profile, { recursive: true, force: true });
  await mkdir(`${profile}/Default`, { recursive: true });
  await writeFile(
    `${profile}/Default/Preferences`,
    JSON.stringify({ extensions: { pinned_extensions: [extensionId] } }),
  );

  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1512,982",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      `http://127.0.0.1:${FIXTURE_PORT}/article.html`,
    ],
    { stdio: "ignore" },
  );

  try {
    let version;
    for (let i = 0; i < 80 && !version; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error("chrome never came up");

    const browser = await new Session(version.webSocketDebuggerUrl).open();
    const loaded = await browser.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
    if (loaded.id !== extensionId) throw new Error(`id ${loaded.id} is not the pinned ${extensionId}`);
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    console.log(`${version.Browser}, ${EXTENSION_DIR}, action pinned\n`);

    const articleTarget = await waitForTarget((entry) => entry.url.includes("article.html"), { label: "article" });
    await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options/options.html`,
      background: true,
    });
    const driverTarget = await waitForTarget((entry) => entry.url.endsWith("options/options.html"), {
      label: "options page",
    });
    const driver = await new Session(driverTarget.webSocketDebuggerUrl).open();
    await driver.evaluate(`chrome.storage.local.set({ apiKey: "race-placeholder" }).then(() => true)`);
    const windowId = await driver.evaluate(
      `chrome.tabs.query({ active: true }).then((tabs) =>
         (tabs.find((tab) => (tab.url ?? "").includes("article.html")) ?? tabs[0]).windowId)`,
    );

    const workerTarget = await waitForTarget((entry) => entry.type === "service_worker" && entry.url.includes(extensionId), {
      label: "service worker",
    });
    const worker = await new Session(workerTarget.webSocketDebuggerUrl).open();

    // How long `check()` spends between sampling the guard and acting on it.
    // Replays the real sequence: ping the active tab, then reload it, each
    // capped at two seconds, before `chrome.runtime.reload()` would fire.
    if (args.get("stale") === "1") {
      console.log("=== how stale the popupIsOpen() answer is by the time runtime.reload() fires ===\n");
      // Put the content scripts in the page, which is the state a tab is in
      // once anything has been read in it.
      await driver.evaluate(
        `chrome.tabs.query({ active: true }).then(async (tabs) => {
           const tab = tabs.find((t) => (t.url ?? "").includes("article.html"));
           await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ${JSON.stringify(
             [
               "content/util.js",
               "content/extract.js",
               "content/docs.js",
               "content/align.js",
               "content/highlight.js",
               "content/pointer.js",
               "content/follow.js",
               "content/positions.js",
               "content/handoff.js",
               "content/pace.js",
               "content/audio-cache.js",
               "content/controls.js",
               "content/player.js",
               "content/reader.js",
             ],
           )} });
           return "injected";
         })`,
      );
      const stale = [];
      for (let run = 0; run < RUNS; run += 1) {
        const taken = await worker.evaluate(
          `(async () => {
             const within = (ms, work, fallback) =>
               Promise.race([work, new Promise((done) => setTimeout(() => done(fallback), ms))]);
             const guardAt = performance.now();
             await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
             const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
             const pong = await within(2000, chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => null), null);
             if (pong?.ok) await within(2000, chrome.tabs.reload(tab.id).catch(() => {}), undefined);
             return performance.now() - guardAt;
           })()`,
        );
        stale.push(taken);
        console.log(`run ${String(run + 1).padStart(2)} — guard sampled ${taken.toFixed(0)}ms before the reload fires`);
        await sleep(1500);
      }
      console.log("");
      console.log(row("guard → runtime.reload(), scripts in page", stats(stale)));
      console.log(
        `\nany popup opened inside that window is destroyed by the reload, ` +
          `and the active tab is reloaded with it.`,
      );
      return;
    }

    const samples = [];
    for (let run = -1; run < RUNS; run += 1) {
      await browser.send("Target.activateTarget", { targetId: articleTarget.id });
      await sleep(150);

      // The worker starts watching for a POPUP context the way popupIsOpen()
      // does, as fast as it can, and stamps the first time it sees one.
      const watching = worker.evaluate(
        `(async () => {
           const started = Date.now();
           let sawAt = null;
           const misses = [];
           while (Date.now() - started < 4000) {
             const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
             if (contexts.length > 0) { sawAt = Date.now(); break; }
             misses.push(Date.now());
           }
           return JSON.stringify({ started, sawAt, polls: misses.length, lastMiss: misses.at(-1) ?? null });
         })()`,
      );
      await sleep(60);

      const clickedAt = Date.now();
      const opened = await driver.evaluate(
        `chrome.action.openPopup({ windowId: ${windowId} }).then(() => "ok", (e) => "failed: " + e.message)`,
      );
      if (opened !== "ok") throw new Error(`openPopup ${opened}`);

      let target;
      for (let i = 0; i < 1200 && !target; i += 1) {
        target = (await targets()).find((entry) => entry.url === popupUrl);
        if (!target) await sleep(2);
      }
      if (!target) throw new Error("the popup never opened");
      const popup = await new Session(target.webSocketDebuggerUrl).open();
      const docOrigin = await popup.evaluate(`performance.timeOrigin`);
      const loadEnd = await popup.evaluate(
        `new Promise((r) => {
           const read = () => performance.getEntriesByType("navigation")[0]?.loadEventEnd;
           const poll = () => { const v = read(); if (v) return r(v); setTimeout(poll, 4); };
           poll();
         })`,
      );
      popup.close();

      const seen = JSON.parse(await watching);
      const sample = {
        // When the popup document existed, and when the worker could first see it.
        documentAt: docOrigin - clickedAt,
        visibleAt: docOrigin - clickedAt + loadEnd,
        sawAt: seen.sawAt === null ? null : seen.sawAt - clickedAt,
        polls: seen.polls,
      };
      sample.gapFromDocument = sample.sawAt === null ? null : sample.sawAt - sample.documentAt;
      sample.gapFromVisible = sample.sawAt === null ? null : sample.sawAt - sample.visibleAt;
      if (run >= 0) samples.push(sample);
      console.log(
        `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
          `document at ${sample.documentAt.toFixed(0)}ms, window shown at ${sample.visibleAt.toFixed(0)}ms, ` +
          `worker first saw a POPUP at ${sample.sawAt === null ? "never" : sample.sawAt.toFixed(0) + "ms"} ` +
          `(${seen.polls} getContexts calls returned empty first)`,
      );

      await browser.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
      await sleep(400);
    }

    console.log("");
    console.log(row("click → popup document exists", stats(samples.map((s) => s.documentAt))));
    console.log(row("click → load event (window shown)", stats(samples.map((s) => s.visibleAt))));
    console.log(row("click → worker can see the POPUP", stats(samples.map((s) => s.sawAt))));
    console.log(row("  blind window after the document exists", stats(samples.map((s) => s.gapFromDocument))));
    console.log(row("  blind window after the window is shown", stats(samples.map((s) => s.gapFromVisible))));
    const blindAfterVisible = samples.filter((s) => (s.gapFromVisible ?? 0) > 0).length;
    console.log(
      `\nruns where the worker still could not see the popup after Chrome had shown it: ` +
        `${blindAfterVisible}/${samples.length}`,
    );
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-reload-race failed: ${error.message}`);
  process.exit(1);
});
