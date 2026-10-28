/**
 * Measures how long the popup takes to put pixels on screen.
 *
 * Two modes, because the question has two halves.
 *
 * The default loads the built extension into a headless Chrome, opens
 * `popup/popup.html` as a tab over and over, and reports first-contentful-paint
 * plus the moment live reader state lands. That measures what this code costs.
 *
 * `--through-chrome 1` measures the whole click instead: an extension page
 * calls `chrome.action.openPopup()`, which is the toolbar button, and the clock
 * runs from that call to the paint. The gap between the call and the popup
 * document's own time origin is the browser building a popup window and a
 * renderer to put it in — our code has not run yet and cannot shorten it.
 * `--control 1` proves which half is which by measuring a popup that is one
 * line of HTML with no CSS and no script at all.
 *
 *   node tools/popup-paint.js [--runs 10] [--extension dist/chrome-test]
 *   node tools/popup-paint.js --through-chrome 1 --runs 8
 *   node tools/popup-paint.js --through-chrome 1 --control 1 --runs 8
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// Open the popup the way the toolbar button does, and time the click rather
// than the document.
const THROUGH_CHROME = args.get("through-chrome") === "1";
// Measure an empty popup instead of ours, for the browser-side baseline.
const CONTROL = args.get("control") === "1";
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

/**
 * The least extension that can have a popup: one paragraph, no stylesheet, no
 * script, no worker. Whatever it measures is the browser's own cost, since
 * there is nothing else left in it.
 */
async function writeControlExtension() {
  const root = await mkdtemp(join(tmpdir(), "popup-control-"));
  await mkdir(join(root, "popup"));
  await mkdir(join(root, "options"));
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 3,
        name: "Popup paint control",
        version: "1.0",
        action: { default_popup: "popup/popup.html" },
        options_ui: { page: "options/options.html", open_in_tab: true },
      },
      null,
      2,
    ),
  );
  const page = (body) =>
    `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Control</title></head>` +
    `<body>${body}</body></html>\n`;
  await writeFile(join(root, "popup/popup.html"), page(`<p id="status">Control</p>`));
  await writeFile(join(root, "options/options.html"), page("<p>Control</p>"));
  return root;
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

/**
 * Installed before the popup's own scripts, to timestamp the first time the
 * popup renders state it was told rather than state it shipped with. The
 * popup marks both itself: `render` is the only thing that sets `data-state`
 * on the status element, and `data-source` on it says whether what is on
 * screen came from the remembered state or from the reader.
 */
const WATCHER = `
  (() => {
    window.__renderedAt = null;
    window.__settledAt = null;
    const note = () => {
      const status = document.getElementById("status");
      if (window.__renderedAt === null && status?.dataset.state) {
        window.__renderedAt = performance.now();
      }
      // A build from before the panel remembered anything sets no source at
      // all, and everything it ever showed came from the reader — so measuring
      // one of those against this still compares like with like.
      const live = status?.dataset.source === "live" || (status?.dataset.state && !status.dataset.source);
      if (window.__settledAt === null && live) {
        window.__settledAt = performance.now();
      }
    };
    const observer = new MutationObserver(note);
    const start = () => {
      if (!document.documentElement) return false;
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "data-source"],
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
 *
 * `height` is taken at the same moment, because a popup that grows after the
 * browser has sized its window is a popup that appears and then moves.
 */
const PAINT_PROBE = `
  new Promise((resolve) => {
    const finish = () => {
      const paints = {};
      for (const entry of performance.getEntriesByType("paint")) paints[entry.name] = entry.startTime;
      if (!paints["first-contentful-paint"]) return false;
      resolve({
        timeOrigin: performance.timeOrigin,
        firstPaint: paints["first-paint"] ?? null,
        firstContentfulPaint: paints["first-contentful-paint"],
        domContentLoaded: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? null,
        toggleLabel: document.getElementById("toggle-label")?.textContent?.trim() ?? "",
        statusLabel: document.getElementById("status")?.textContent?.trim() ?? "",
        statusSource: document.getElementById("status")?.dataset.source ?? "",
        height: Math.round(document.body.getBoundingClientRect().height),
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

/**
 * Two moments from navigation start: the first time the panel shows a state it
 * was handed rather than the one in its markup, and the first time that state
 * is the reader's own. The gap between them is what the remembered state is
 * worth.
 */
const SETTLED_PROBE = `
  new Promise((resolve) => {
    const deadline = performance.now() + 10000;
    const poll = () => {
      if (window.__settledAt !== null || performance.now() > deadline) {
        return resolve(JSON.stringify({ rendered: window.__renderedAt, live: window.__settledAt }));
      }
      setTimeout(poll, 20);
    };
    poll();
  })
`;

/** The panel once everything it asked for has landed. */
const REST_PROBE = `
  JSON.stringify({
    height: Math.round(document.body.getBoundingClientRect().height),
    statusLabel: document.getElementById("status")?.textContent?.trim() ?? "",
    statusSource: document.getElementById("status")?.dataset.source ?? "",
    toggleLabel: document.getElementById("toggle-label")?.textContent?.trim() ?? "",
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

const ms = (value) => (typeof value === "number" ? `${value.toFixed(1)}ms` : "none");

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

/** Shut the background worker down, so the next popup pays to start it again. */
async function killWorker(browser, extensionId) {
  for (const entry of await targets()) {
    if (entry.type === "service_worker" && entry.url.includes(extensionId)) {
      await browser.send("Target.closeTarget", { targetId: entry.id }).catch(() => {});
    }
  }
  await sleep(300);
}

/**
 * The popup as a tab: every timing the document can see, and nothing of what
 * the browser spent before the document existed.
 */
async function measureAsTab({ browser, extensionId, article, popupUrl }) {
  const samples = [];
  // The first popup of a session pays for worker start-up; measure a warm
  // popup, which is the one the user opens over and over.
  for (let run = -1; run < RUNS; run += 1) {
    // A fresh document each run, so the popup faces the common case: a page
    // whose content scripts are not injected yet.
    if (SLOW_PAGE_MS || BUSY_PAGE_MS) article.session.send("Page.navigate", { url: PAGE_URL }).catch(() => {});
    else {
      await article.session.send("Page.navigate", { url: PAGE_URL });
      await sleep(600);
    }

    if (COLD) await killWorker(browser, extensionId);

    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", background: true });
    await browser.send("Target.activateTarget", { targetId: article.target.id });
    const target = (await targets()).find((entry) => entry.id === targetId);
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
    const load = await popup.evaluate(LOAD_PROBE);
    const settled = JSON.parse(await popup.evaluate(SETTLED_PROBE));
    const rest = JSON.parse(await popup.evaluate(REST_PROBE));
    if (run >= 0) samples.push({ paint, load, settled, rest });
    console.log(
      `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
        `fcp ${ms(paint.firstContentfulPaint)}, dcl ${ms(paint.domContentLoaded)}, ` +
        `load ${ms(load)}, state ${ms(settled.rendered)}, reader ${ms(settled.live)}, ` +
        `height ${paint.height}→${rest.height}, ` +
        `painted "${paint.statusLabel} / ${paint.toggleLabel}" from ${paint.statusSource || "markup"}, ` +
        `settled on "${rest.statusLabel} / ${rest.toggleLabel}"`,
    );

    popup.close();
    await browser.send("Target.closeTarget", { targetId });
  }
  return samples;
}

/**
 * The popup the way the toolbar opens it.
 *
 * `chrome.action.openPopup()` is the button, so the clock can start before the
 * browser has a window to paint into — which is the part of the wait this code
 * cannot touch. An explicit `windowId` keeps the popup on the window holding
 * the article, so the panel resolves the article as its tab rather than the
 * extension page driving the measurement.
 */
async function measureThroughChrome({ browser, extensionId, article, popupUrl, driver }) {
  const windowId = await driver.evaluate(
    `chrome.tabs.query({ active: true }).then((tabs) =>
       (tabs.find((tab) => (tab.url ?? "").startsWith(${JSON.stringify(new URL(PAGE_URL).origin)})) ?? tabs[0]).windowId)`,
  );

  const samples = [];
  for (let run = -1; run < RUNS; run += 1) {
    await browser.send("Target.activateTarget", { targetId: article.target.id });
    if (COLD) await killWorker(browser, extensionId);

    const clicked = Date.now();
    const opened = await driver.evaluate(
      `chrome.action.openPopup({ windowId: ${windowId} }).then(() => "ok", (error) => "failed: " + error.message)`,
    );
    if (opened !== "ok") throw new Error(`openPopup ${opened}`);

    // Polled rather than awaited on an event: the popup target has to exist
    // before it can be attached to, and the timings come from inside it.
    let target;
    for (let i = 0; i < 300 && !target; i += 1) {
      target = (await targets()).find((entry) => entry.url === popupUrl);
      if (!target) await sleep(10);
    }
    if (!target) throw new Error("the popup never opened");

    const popup = await new Session(target.webSocketDebuggerUrl).open();
    const paint = await popup.evaluate(PAINT_PROBE);
    const load = await popup.evaluate(LOAD_PROBE);
    const rest = JSON.parse(await popup.evaluate(REST_PROBE));
    // What the browser spent before this document existed: a popup window, and
    // a renderer to put it in.
    const browserCost = paint.timeOrigin - clicked;
    const toPaint = browserCost + paint.firstContentfulPaint;
    if (run >= 0) samples.push({ paint, load, browserCost, toPaint, rest });
    console.log(
      `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
        `browser before our document ${ms(browserCost)}, fcp ${ms(paint.firstContentfulPaint)}, ` +
        `load ${ms(load)}, click→paint ${ms(toPaint)}, ` +
        `height ${paint.height}→${rest.height}, ` +
        `painted "${paint.statusLabel} / ${paint.toggleLabel}" from ${paint.statusSource || "markup"}, ` +
        `settled on "${rest.statusLabel} / ${rest.toggleLabel}"`,
    );

    popup.close();
    await browser.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
    await sleep(400);
  }
  return samples;
}

function report(samples) {
  const column = (pick) => stats(samples.map(pick));
  if (THROUGH_CHROME) {
    console.log(`\nbrowser, before our document: ${format(column((s) => s.browserCost))}`);
    console.log(`first contentful paint:       ${format(column((s) => s.paint.firstContentfulPaint))}`);
    console.log(`load event (popup shown):     ${format(column((s) => s.load))}`);
    console.log(`click → paint:                ${format(column((s) => s.toPaint))}`);
  } else {
    console.log(`\nfirst contentful paint:   ${format(column((s) => s.paint.firstContentfulPaint))}`);
    console.log(`load event (popup shown): ${format(column((s) => s.load))}`);
    console.log(`a state on screen:        ${format(column((s) => s.settled.rendered))}`);
    console.log(`the reader's own state:   ${format(column((s) => s.settled.live))}`);
  }

  const shifted = samples.filter((sample) => sample.paint.height !== sample.rest.height);
  console.log(
    `panel height at paint vs at rest: ${
      shifted.length ? `moved in ${shifted.length}/${samples.length} runs` : "unchanged in every run"
    } (${samples.map((sample) => `${sample.paint.height}→${sample.rest.height}`).join(", ")})`,
  );
  const sources = new Map();
  for (const sample of samples) {
    const key = sample.paint.statusSource || "markup";
    sources.set(key, (sources.get(key) ?? 0) + 1);
  }
  console.log(
    `state on the first paint: ${[...sources].map(([key, count]) => `${key} ${count}/${samples.length}`).join(", ")}`,
  );
}

async function main() {
  const fixtures = await serveFixtures();
  const extensionDir = CONTROL ? await writeControlExtension() : EXTENSION_DIR;
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
    console.log(`${version.Browser}, measuring ${CONTROL ? "an empty control popup" : extensionDir}\n`);

    const browser = await new Session(version.webSocketDebuggerUrl).open();
    const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: extensionDir });
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;

    // The popup acts on the active tab, so the article must stay active —
    // otherwise the background worker resolves the popup's own tab and fails
    // fast, which measures nothing.
    const articleTarget = await waitForTarget((entry) => entry.url.startsWith(PAGE_URL), { label: PAGE_URL });
    const article = { target: articleTarget, session: await new Session(articleTarget.webSocketDebuggerUrl).open() };
    await article.session.send("Page.enable");

    // An extension page, which is the only context that may seed settings or
    // call `chrome.action.openPopup`.
    await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options/options.html`,
      background: true,
    });
    const driverTarget = await waitForTarget((entry) => entry.url.endsWith("options/options.html"), {
      label: "options page",
    });
    const driver = await new Session(driverTarget.webSocketDebuggerUrl).open();
    await browser.send("Target.activateTarget", { targetId: articleTarget.id });

    // A credential, so the panel is measured in the state it is in for
    // somebody who has set the extension up. Without one it paints a standing
    // "no credentials" warning, which is both a different height and a
    // different panel from the one anybody uses.
    if (!CONTROL) {
      await driver.evaluate(
        `chrome.storage.local.set({ apiKey: "popup-paint-placeholder-not-a-key" }).then(() => true)`,
      );
    }

    const context = { browser, extensionId, article, popupUrl, driver };
    report(THROUGH_CHROME ? await measureThroughChrome(context) : await measureAsTab(context));
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-paint failed: ${error.message}`);
  process.exit(1);
});
