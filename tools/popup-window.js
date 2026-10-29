/**
 * TEMPORARY DIAGNOSTIC — not part of the build or the checks.
 *
 * Splits the quarter second that `tools/popup-paint.js` attributes to "the
 * browser, before our document" into the two things it could be:
 *
 *   openPopup() → the popup target exists      (Chrome building a popup window)
 *   the target exists → the document's origin  (Chrome building a document)
 *
 * Done by listening for `Target.targetCreated` on the browser session and
 * stamping the wall clock when it arrives, rather than polling /json/list.
 *
 *   node tools/popup-window.js --extension dist/chrome-test --runs 10
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const RUNS = Number(args.get("runs") ?? 10);
const CDP_PORT = Number(args.get("port") ?? 9485);
const FIXTURE_PORT = Number(args.get("fixture-port") ?? 8799);
const EXTENSION_DIR = resolve(args.get("extension") ?? new URL("../dist/chrome-test", import.meta.url).pathname);
const PAGE_URL = `http://127.0.0.1:${FIXTURE_PORT}/article.html`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
    this.listeners = [];
  }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.socket.onopen = res;
      this.socket.onerror = () => rej(new Error(`cannot connect to ${this.url}`));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method) {
        for (const listener of this.listeners) listener(message, Date.now());
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
  on(listener) {
    this.listeners.push(listener);
  }
  send(method, params = {}) {
    const id = this.id++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => this.pending.delete(id) && rej(new Error(`${method} timed out`)), 30000);
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

async function waitForTarget(predicate, { label, tries = 40, every = 250 }) {
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
    ? `${label.padEnd(40)} median ${s.median.toFixed(1).padStart(7)}ms   p90 ${s.p90.toFixed(1).padStart(7)}ms   ` +
      `min ${s.min.toFixed(1).padStart(7)}ms   max ${s.max.toFixed(1).padStart(7)}ms`
    : `${label.padEnd(40)} no samples`;

async function main() {
  const fixtures = await serveFixtures();
  const headful = args.get("headful") === "1";
  const profile = args.get("profile") ?? `/tmp/ra-popup-window-${CDP_PORT}`;
  const chrome = spawn(
    "google-chrome",
    [
      ...(headful ? [] : ["--headless=new"]),
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1512,982",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      PAGE_URL,
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
    const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    console.log(`${version.Browser}, ${EXTENSION_DIR}\n`);

    const articleTarget = await waitForTarget((entry) => entry.url.startsWith(PAGE_URL), { label: PAGE_URL });
    await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options/options.html`,
      background: true,
    });
    const driverTarget = await waitForTarget((entry) => entry.url.endsWith("options/options.html"), {
      label: "options page",
    });
    const driver = await new Session(driverTarget.webSocketDebuggerUrl).open();
    await browser.send("Target.activateTarget", { targetId: articleTarget.id });
    await driver.evaluate(`chrome.storage.local.set({ apiKey: "popup-window-placeholder" }).then(() => true)`);

    const windowId = await driver.evaluate(
      `chrome.tabs.query({ active: true }).then((tabs) =>
         (tabs.find((tab) => (tab.url ?? "").startsWith(${JSON.stringify(new URL(PAGE_URL).origin)})) ?? tabs[0]).windowId)`,
    );

    // Events, so the moment a popup target comes into existence is observed
    // rather than polled for.
    await browser.send("Target.setDiscoverTargets", { discover: true });
    let created = null;
    browser.on((message, at) => {
      if (message.method !== "Target.targetCreated") return;
      if (message.params?.targetInfo?.url === popupUrl) created ??= at;
    });

    const samples = [];
    for (let run = -1; run < RUNS; run += 1) {
      await browser.send("Target.activateTarget", { targetId: articleTarget.id });
      created = null;

      const clickedAt = Date.now();
      const opened = await driver.evaluate(
        `chrome.action.openPopup({ windowId: ${windowId} }).then(() => "ok", (error) => "failed: " + error.message)`,
      );
      const resolvedAt = Date.now();
      if (opened !== "ok") throw new Error(`openPopup ${opened}`);

      let target;
      for (let i = 0; i < 600 && !target; i += 1) {
        target = (await targets()).find((entry) => entry.url === popupUrl);
        if (!target) await sleep(5);
      }
      const popup = await new Session(target.webSocketDebuggerUrl).open();
      const origin = await popup.evaluate(`performance.timeOrigin`);
      const fcp = await popup.evaluate(
        `new Promise((r) => {
           const read = () => performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint")?.startTime;
           if (read() !== undefined) return r(read());
           new PerformanceObserver(() => { if (read() !== undefined) r(read()); }).observe({ type: "paint", buffered: true });
           setTimeout(() => r(null), 5000);
         })`,
      );

      const sample = {
        toTargetCreated: created === null ? null : created - clickedAt,
        toOpenPopupResolved: resolvedAt - clickedAt,
        toTimeOrigin: origin - clickedAt,
        targetToOrigin: created === null ? null : origin - created,
        fcp,
      };
      if (run >= 0) samples.push(sample);
      console.log(
        `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
          `targetCreated ${sample.toTargetCreated === null ? "n/a" : sample.toTargetCreated.toFixed(0) + "ms"}, ` +
          `openPopup resolved ${sample.toOpenPopupResolved.toFixed(0)}ms, ` +
          `timeOrigin ${sample.toTimeOrigin.toFixed(0)}ms, ` +
          `target→origin ${sample.targetToOrigin === null ? "n/a" : sample.targetToOrigin.toFixed(0) + "ms"}, ` +
          `fcp ${fcp === null ? "n/a" : fcp.toFixed(0) + "ms"}`,
      );

      popup.close();
      await browser.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
      await sleep(350);
    }

    console.log("");
    console.log(row("click → popup target created", stats(samples.map((s) => s.toTargetCreated))));
    console.log(row("click → openPopup() resolved", stats(samples.map((s) => s.toOpenPopupResolved))));
    console.log(row("click → document timeOrigin", stats(samples.map((s) => s.toTimeOrigin))));
    console.log(row("  of which: target → timeOrigin", stats(samples.map((s) => s.targetToOrigin))));
    console.log(row("document timeOrigin → paint", stats(samples.map((s) => s.fcp))));
    console.log(row("click → paint", stats(samples.map((s) => s.toTimeOrigin + s.fcp))));
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-window failed: ${error.message}`);
  process.exit(1);
});
