/**
 * Measures how long the popup takes to put pixels on screen.
 *
 * Loads the built extension into a headless Chrome, opens `popup/popup.html`
 * repeatedly, and reports first-contentful-paint plus the moment live reader
 * state lands. Run it before and after a change to see whether the popup still
 * paints before it knows anything.
 *
 *   node tools/popup-paint.js [--runs 10] [--extension dist/chrome-test]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const RUNS = Number(args.get("runs") ?? 10);
const CDP_PORT = Number(args.get("port") ?? 9447);
const EXTENSION_DIR = args.get("extension") ?? new URL("../dist/chrome-test", import.meta.url).pathname;
const FIXTURE_PORT = Number(args.get("fixture-port") ?? 8781);
// MV3 shuts the background worker down when idle, so most real popup opens pay
// to boot it again. `--cold 1` reproduces that; the default measures a warm
// worker, which is the floor rather than the common case.
const COLD = args.get("cold") === "1";
// Opening the popup while the tab is still loading is ordinary behaviour, and
// it is when the state round-trip is slowest: script injection cannot finish
// until the document does. `--slow-page 800` holds the article back that long.
const SLOW_PAGE_MS = Number(args.get("slow-page") ?? 0);
// A page whose main thread is busy cannot be injected into or answer a message
// until it frees up. `--busy-page 1000` reproduces a heavy page, which is where
// a popup that waits for reader state before painting is felt most.
const BUSY_PAGE_MS = Number(args.get("busy-page") ?? 0);
const PAGE_URL = args.get("page") ?? `http://127.0.0.1:${FIXTURE_PORT}/article.html`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serves tests/fixtures so the measured popup has a real page to act on. */
function serveFixtures() {
  const root = new URL("../tests/fixtures/", import.meta.url);
  const server = createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
      let body = await readFile(new URL(name, root), "utf8");
      if (BUSY_PAGE_MS) {
        body = body.replace(
          "</body>",
          `<script>{const end=Date.now()+${BUSY_PAGE_MS};while(Date.now()<end);}</script></body>`,
        );
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (SLOW_PAGE_MS) await sleep(SLOW_PAGE_MS);
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve(server)));
}

class Session {
  constructor(url) {
    this.url = url;
    this.id = 1;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error(`cannot connect to ${this.url}`));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 30000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
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

/**
 * Installed before the popup's own scripts, to timestamp the first time the
 * popup renders state it was told rather than state it shipped with. The
 * popup marks that itself: `render` is the only thing that sets `data-state`
 * on the status element.
 */
const WATCHER = `
  (() => {
    window.__settledAt = null;
    const note = () => {
      if (window.__settledAt === null && document.getElementById("status")?.dataset.state) {
        window.__settledAt = performance.now();
      }
    };
    const observer = new MutationObserver(note);
    const start = () => {
      if (!document.documentElement) return false;
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"],
      });
      note();
      return true;
    };
    // At document-start there is no documentElement to observe yet.
    if (!start()) {
      const retry = setInterval(() => { if (start()) clearInterval(retry); }, 1);
    }
  })()
`;

/**
 * Resolves once the document has painted, reporting paint timings relative to
 * navigation start. `first-contentful-paint` is the number the user feels: the
 * moment the popup stops being an empty box.
 */
const PAINT_PROBE = `
  new Promise((resolve) => {
    const finish = () => {
      const paints = {};
      for (const entry of performance.getEntriesByType("paint")) paints[entry.name] = entry.startTime;
      if (!paints["first-contentful-paint"]) return false;
      resolve({
        firstPaint: paints["first-paint"] ?? null,
        firstContentfulPaint: paints["first-contentful-paint"],
        domContentLoaded: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? null,
        toggleLabel: document.getElementById("toggle-label")?.textContent?.trim() ?? "",
        statusLabel: document.getElementById("status")?.textContent?.trim() ?? "",
      });
      return true;
    };
    if (finish()) return;
    new PerformanceObserver(finish).observe({ type: "paint", buffered: true });
    setTimeout(() => resolve({ firstContentfulPaint: null, timedOut: true }), 10000);
  })
`;

/**
 * Chrome keeps the popup window hidden until the document has finished
 * loading, so `loadEventEnd` is the closest proxy for "the popup appeared".
 * Anything the popup awaits before that point is time the user spends looking
 * at nothing.
 */
const LOAD_PROBE = `
  new Promise((resolve) => {
    const read = () => resolve(performance.getEntriesByType("navigation")[0]?.loadEventEnd ?? null);
    if (document.readyState === "complete") read();
    else window.addEventListener("load", () => setTimeout(read, 0), { once: true });
    setTimeout(() => resolve(null), 10000);
  })
`;

/** Time from navigation start until the popup shows live reader state. */
const SETTLED_PROBE = `
  new Promise((resolve) => {
    const deadline = performance.now() + 10000;
    const poll = () => {
      if (window.__settledAt !== null) return resolve(window.__settledAt);
      if (performance.now() > deadline) return resolve(null);
      setTimeout(poll, 20);
    };
    poll();
  })
`;

function stats(values) {
  const clean = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (!clean.length) return null;
  const sum = clean.reduce((total, value) => total + value, 0);
  return {
    min: clean[0],
    median: clean[Math.floor(clean.length / 2)],
    mean: sum / clean.length,
    max: clean.at(-1),
  };
}

const format = (summary) =>
  summary
    ? `min ${summary.min.toFixed(1)}ms · median ${summary.median.toFixed(1)}ms · ` +
      `mean ${summary.mean.toFixed(1)}ms · max ${summary.max.toFixed(1)}ms`
    : "no samples";

async function main() {
  const fixtures = await serveFixtures();
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1512,982",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=/tmp/ra-popup-paint-${CDP_PORT}`,
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

    // The popup acts on the active tab, so the article must stay active —
    // otherwise the background worker resolves the popup's own tab and fails
    // fast, which measures nothing.
    let articleTarget;
    for (let i = 0; i < 40 && !articleTarget; i += 1) {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      articleTarget = list.find((entry) => entry.url.startsWith(PAGE_URL));
      if (!articleTarget) await sleep(250);
    }
    if (!articleTarget) throw new Error(`article tab never appeared: ${PAGE_URL}`);
    const article = await new Session(articleTarget.webSocketDebuggerUrl).open();
    await article.send("Page.enable");

    const paints = [];
    const loads = [];
    const settled = [];
    // The first popup of a session pays for worker start-up; measure a warm
    // popup, which is the one the user opens over and over.
    for (let run = -1; run < RUNS; run += 1) {
      // A fresh document each run, so the popup faces the common case: a page
      // whose content scripts are not injected yet.
      if (SLOW_PAGE_MS || BUSY_PAGE_MS) article.send("Page.navigate", { url: PAGE_URL }).catch(() => {});
      else {
        await article.send("Page.navigate", { url: PAGE_URL });
        await sleep(600);
      }

      if (COLD) {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        for (const entry of targets) {
          if (entry.type === "service_worker" && entry.url.includes(extensionId)) {
            await browser.send("Target.closeTarget", { targetId: entry.id }).catch(() => {});
          }
        }
        await sleep(300);
      }

      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", background: true });
      await browser.send("Target.activateTarget", { targetId: articleTarget.id });
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const target = list.find((entry) => entry.id === targetId);
      const popup = await new Session(target.webSocketDebuggerUrl).open();
      await popup.send("Page.enable");
      await popup.send("Runtime.enable");
      // The article tab holds focus so the worker resolves it as the active
      // tab, which leaves this tab hidden and therefore never painted. Both
      // of these make it render anyway, so paint timings exist to compare.
      await popup.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await popup.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
      await popup.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCHER });
      await popup.send("Page.navigate", { url: popupUrl });

      const paint = await popup.evaluate(PAINT_PROBE);
      const loaded = await popup.evaluate(LOAD_PROBE);
      const ready = await popup.evaluate(SETTLED_PROBE);
      const ms = (value) => (typeof value === "number" ? `${value.toFixed(1)}ms` : "none");
      if (run >= 0) {
        paints.push(paint.firstContentfulPaint);
        loads.push(loaded);
        settled.push(ready);
      }
      console.log(
        `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
          `fcp ${ms(paint.firstContentfulPaint)}, dcl ${ms(paint.domContentLoaded)}, ` +
          `load ${ms(loaded)}, live state ${ms(ready)}, ` +
          `painted with "${paint.statusLabel} / ${paint.toggleLabel}"`,
      );

      popup.close();
      await browser.send("Target.closeTarget", { targetId });
    }

    console.log(`\nfirst contentful paint: ${format(stats(paints))}`);
    console.log(`load event (popup shown): ${format(stats(loads))}`);
    console.log(`live state applied:       ${format(stats(settled))}`);
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-paint failed: ${error.message}`);
  process.exit(1);
});
