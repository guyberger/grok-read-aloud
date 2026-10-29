/**
 * TEMPORARY DIAGNOSTIC — not part of the build or the checks.
 *
 * `tools/popup-paint.js` answers "how long until the panel is on screen".
 * This answers "where did every one of those milliseconds go", by dumping
 * navigation timing, every subresource the popup document fetched, the paint
 * entries, and the `performance.mark`s the instrumented `popup.js` leaves
 * behind.
 *
 * It also times three different ways of bringing a popup document into
 * existence, to split Chrome's own cost from the `chrome.action.openPopup`
 * call itself:
 *
 *   action   — chrome.action.openPopup(), i.e. the toolbar button
 *   tab      — Target.createTarget on popup.html, no popup window at all
 *   reopen   — openPopup() again with the extension renderer already warm
 *
 *   node tools/popup-phases.js --extension dist/chrome-test --runs 10
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
const CDP_PORT = Number(args.get("port") ?? 9460);
const FIXTURE_PORT = Number(args.get("fixture-port") ?? 8791);
const EXTENSION_DIR = args.get("extension") ?? new URL("../dist/chrome-test", import.meta.url).pathname;
const CONTROL = args.get("control") === "1";
const COLD = args.get("cold") === "1";
const PROFILE = args.get("profile") ?? `/tmp/ra-popup-phases-${CDP_PORT}`;
const PAGE_URL = `http://127.0.0.1:${FIXTURE_PORT}/article.html`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return new Promise((resolve) => server.listen(FIXTURE_PORT, "127.0.0.1", () => resolve(server)));
}

/** A popup with the same manifest surface as ours but an empty document. */
async function writeControlExtension() {
  const root = await mkdtemp(join(tmpdir(), "popup-phases-control-"));
  await mkdir(join(root, "popup"));
  await mkdir(join(root, "options"));
  await mkdir(join(root, "background"));
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 3,
        name: "Popup phases control",
        version: "1.0",
        permissions: ["storage", "scripting", "activeTab"],
        host_permissions: ["<all_urls>"],
        background: { service_worker: "background/background.js", type: "module" },
        action: { default_popup: "popup/popup.html" },
        options_ui: { page: "options/options.html", open_in_tab: true },
      },
      null,
      2,
    ),
  );
  await writeFile(join(root, "background/background.js"), `chrome.runtime.onMessage.addListener(() => true);\n`);
  const page = (body) =>
    `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Control</title></head>` +
    `<body>${body}</body></html>\n`;
  await writeFile(join(root, "popup/popup.html"), page(`<p id="status" data-state="idle">Control</p>`));
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
 * Everything the document can say about its own timeline, once it has painted
 * and had a moment for the deferred work to land.
 */
const PHASES = `
  new Promise((resolve) => {
    const collect = () => {
      const nav = performance.getEntriesByType("navigation")[0] ?? {};
      const paints = {};
      for (const entry of performance.getEntriesByType("paint")) paints[entry.name] = entry.startTime;
      resolve(JSON.stringify({
        timeOrigin: performance.timeOrigin,
        nav: {
          requestStart: nav.requestStart ?? null,
          responseStart: nav.responseStart ?? null,
          responseEnd: nav.responseEnd ?? null,
          domInteractive: nav.domInteractive ?? null,
          domContentLoadedEventStart: nav.domContentLoadedEventStart ?? null,
          domContentLoadedEventEnd: nav.domContentLoadedEventEnd ?? null,
          domComplete: nav.domComplete ?? null,
          loadEventEnd: nav.loadEventEnd ?? null,
          transferSize: nav.transferSize ?? null,
          decodedBodySize: nav.decodedBodySize ?? null,
        },
        firstPaint: paints["first-paint"] ?? null,
        firstContentfulPaint: paints["first-contentful-paint"] ?? null,
        resources: performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name.split("/").slice(-1)[0],
          initiator: entry.initiatorType,
          start: entry.startTime,
          responseEnd: entry.responseEnd,
          duration: entry.duration,
          decodedBodySize: entry.decodedBodySize,
        })),
        marks: performance.getEntriesByType("mark").map((entry) => ({ name: entry.name, at: entry.startTime })),
        statusSource: document.getElementById("status")?.dataset.source ?? "",
        statusLabel: document.getElementById("status")?.textContent?.trim() ?? "",
      }));
    };
    // Long enough for the rAF+setTimeout deferred block to have finished.
    const deadline = performance.now() + 4000;
    const poll = () => {
      const done = performance.getEntriesByName("popup:deferred-end").length > 0;
      if (done || performance.now() > deadline) return collect();
      setTimeout(poll, 25);
    };
    if (document.readyState === "complete") poll();
    else window.addEventListener("load", poll, { once: true });
  })
`;

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

async function killWorker(browser, extensionId) {
  for (const entry of await targets()) {
    if (entry.type === "service_worker" && entry.url.includes(extensionId)) {
      await browser.send("Target.closeTarget", { targetId: entry.id }).catch(() => {});
    }
  }
  await sleep(300);
}

function stats(values) {
  const clean = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  return {
    min: clean[0],
    median: clean[Math.floor(clean.length / 2)],
    p90: clean[Math.min(clean.length - 1, Math.floor(clean.length * 0.9))],
    max: clean.at(-1),
  };
}

const row = (label, summary) =>
  summary
    ? `${label.padEnd(34)} median ${summary.median.toFixed(1).padStart(7)}ms   p90 ${summary.p90
        .toFixed(1)
        .padStart(7)}ms   min ${summary.min.toFixed(1).padStart(7)}ms   max ${summary.max.toFixed(1).padStart(7)}ms`
    : `${label.padEnd(34)} no samples`;

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
      `--user-data-dir=${PROFILE}`,
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
    console.log(`${version.Browser}, measuring ${CONTROL ? "a same-manifest control popup" : extensionDir}`);
    console.log(`${RUNS} runs, worker ${COLD ? "stopped before each open" : "left awake"}\n`);

    const browser = await new Session(version.webSocketDebuggerUrl).open();
    const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: extensionDir });
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;

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

    if (!CONTROL) {
      await driver.evaluate(`chrome.storage.local.set({ apiKey: "popup-phases-placeholder" }).then(() => true)`);
    }

    const windowId = await driver.evaluate(
      `chrome.tabs.query({ active: true }).then((tabs) =>
         (tabs.find((tab) => (tab.url ?? "").startsWith(${JSON.stringify(new URL(PAGE_URL).origin)})) ?? tabs[0]).windowId)`,
    );

    const viaAction = [];
    const viaTab = [];

    for (let run = -1; run < RUNS; run += 1) {
      await browser.send("Target.activateTarget", { targetId: articleTarget.id });
      if (COLD) await killWorker(browser, extensionId);

      // --- the toolbar button -------------------------------------------
      const clickedAt = Date.now();
      const opened = await driver.evaluate(
        `chrome.action.openPopup({ windowId: ${windowId} }).then(() => "ok", (error) => "failed: " + error.message)`,
      );
      if (opened !== "ok") throw new Error(`openPopup ${opened}`);
      let target;
      for (let i = 0; i < 400 && !target; i += 1) {
        target = (await targets()).find((entry) => entry.url === popupUrl);
        if (!target) await sleep(5);
      }
      if (!target) throw new Error("the popup never opened");
      const popup = await new Session(target.webSocketDebuggerUrl).open();
      const phases = JSON.parse(await popup.evaluate(PHASES));
      phases.beforeDocument = phases.timeOrigin - clickedAt;
      if (run >= 0) viaAction.push(phases);
      popup.close();
      await browser.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
      await sleep(250);

      // --- the same document as a plain tab, no popup window ------------
      const askedAt = Date.now();
      const created = await browser.send("Target.createTarget", { url: popupUrl, background: true });
      let tabTarget;
      for (let i = 0; i < 400 && !tabTarget; i += 1) {
        tabTarget = (await targets()).find((entry) => entry.id === created.targetId);
        if (!tabTarget?.webSocketDebuggerUrl) tabTarget = null;
        if (!tabTarget) await sleep(5);
      }
      const tabSession = await new Session(tabTarget.webSocketDebuggerUrl).open();
      await tabSession.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await tabSession.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
      const tabPhases = JSON.parse(await tabSession.evaluate(PHASES));
      tabPhases.beforeDocument = tabPhases.timeOrigin - askedAt;
      if (run >= 0) viaTab.push(tabPhases);
      tabSession.close();
      await browser.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
      await sleep(250);

      console.log(
        `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
          `action: before-doc ${phases.beforeDocument.toFixed(0)}ms, fcp ${(phases.firstContentfulPaint ?? -1).toFixed(0)}ms, ` +
          `load ${(phases.nav.loadEventEnd ?? -1).toFixed(1)}ms | ` +
          `tab: before-doc ${tabPhases.beforeDocument.toFixed(0)}ms, load ${(tabPhases.nav.loadEventEnd ?? -1).toFixed(1)}ms`,
      );
    }

    for (const [label, samples] of [
      ["opened by chrome.action.openPopup()", viaAction],
      ["same document as a plain tab", viaTab],
    ]) {
      console.log(`\n=== ${label} ===`);
      console.log(row("browser, before our document", stats(samples.map((s) => s.beforeDocument))));
      console.log(row("  → navigation requestStart", stats(samples.map((s) => s.nav.requestStart))));
      console.log(row("  → navigation responseEnd", stats(samples.map((s) => s.nav.responseEnd))));
      console.log(row("  → domInteractive", stats(samples.map((s) => s.nav.domInteractive))));
      console.log(row("  → domContentLoadedEventEnd", stats(samples.map((s) => s.nav.domContentLoadedEventEnd))));
      console.log(row("  → domComplete", stats(samples.map((s) => s.nav.domComplete))));
      console.log(row("  → loadEventEnd (popup shown)", stats(samples.map((s) => s.nav.loadEventEnd))));
      console.log(row("  → first paint", stats(samples.map((s) => s.firstPaint))));
      console.log(row("  → first contentful paint", stats(samples.map((s) => s.firstContentfulPaint))));
      console.log(
        row(
          "click → paint (total)",
          stats(samples.map((s) => s.beforeDocument + (s.firstContentfulPaint ?? NaN))),
        ),
      );

      const names = new Set();
      for (const sample of samples) for (const resource of sample.resources) names.add(resource.name);
      if (names.size) {
        console.log(`\n  subresources (${[...names].join(", ")}):`);
        for (const name of names) {
          const pick = (field) =>
            samples.map((s) => s.resources.find((r) => r.name === name)?.[field]).filter((v) => v !== undefined);
          console.log(
            row(`    ${name} start`, stats(pick("start"))) + ``,
          );
          console.log(row(`    ${name} responseEnd`, stats(pick("responseEnd"))));
        }
      }

      const markNames = [];
      for (const sample of samples) {
        for (const mark of sample.marks) if (!markNames.includes(mark.name)) markNames.push(mark.name);
      }
      if (markNames.length) {
        console.log(`\n  performance marks:`);
        for (const name of markNames) {
          console.log(
            row(
              `    ${name}`,
              stats(samples.map((s) => s.marks.find((m) => m.name === name)?.at)),
            ),
          );
        }
      }
      const sources = new Map();
      for (const sample of samples) {
        const key = sample.statusSource || "markup";
        sources.set(key, (sources.get(key) ?? 0) + 1);
      }
      console.log(`\n  state at rest: ${[...sources].map(([k, v]) => `${k} ${v}/${samples.length}`).join(", ")}`);
    }
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-phases failed: ${error.message}`);
  process.exit(1);
});
