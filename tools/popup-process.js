/**
 * TEMPORARY DIAGNOSTIC — not part of the build or the checks.
 *
 * Two costs `tools/popup-paint.js` cannot see, because it always keeps an
 * extension page open to drive `chrome.action.openPopup()` from, which keeps
 * the extension's renderer process alive:
 *
 *   1. A cold extension process. In ordinary use nothing of the extension is
 *      open when the toolbar icon is clicked, and an MV3 worker Chrome has
 *      stopped leaves no process behind — so the click has to start one.
 *   2. The first open after `chrome.runtime.reload()`, which is what a dev
 *      build does on every rebuild. The extension is loaded again from disk.
 *
 * Both are measured on the popup document opened as a tab, which `popup-phases`
 * showed costs ~2 ms of browser time when the process is warm. Anything above
 * that is process or extension start-up.
 *
 * `chrome.runtime.reload()` itself cannot be measured here: an extension loaded
 * over the DevTools Protocol does not come back from it, and `--load-extension`
 * is refused outright by branded Chrome ("not allowed in Google Chrome,
 * ignoring"). A fresh `Extensions.loadUnpacked` of a copy of the build stands
 * in for it — the first popup open against an extension Chrome has only just
 * read off disk.
 *
 *   node tools/popup-process.js --extension dist/chrome-test --runs 10
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cpSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The id Chrome gives an unpacked extension: the first 16 bytes of the SHA-256
 * of its absolute path, with each nibble mapped onto a–p. Derived rather than
 * discovered because a dormant MV3 worker shows no target to read it off.
 */
const unpackedExtensionId = (path) =>
  [...createHash("sha256").update(path).digest("hex").slice(0, 32)]
    .map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)))
    .join("");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const RUNS = Number(args.get("runs") ?? 10);
const CDP_PORT = Number(args.get("port") ?? 9470);
const FIXTURE_PORT = Number(args.get("fixture-port") ?? 8795);
const EXTENSION_DIR = resolve(args.get("extension") ?? new URL("../dist/chrome-test", import.meta.url).pathname);
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

const PHASES = `
  new Promise((resolve) => {
    const collect = () => {
      const nav = performance.getEntriesByType("navigation")[0] ?? {};
      const paints = {};
      for (const entry of performance.getEntriesByType("paint")) paints[entry.name] = entry.startTime;
      resolve(JSON.stringify({
        timeOrigin: performance.timeOrigin,
        responseEnd: nav.responseEnd ?? null,
        domInteractive: nav.domInteractive ?? null,
        loadEventEnd: nav.loadEventEnd ?? null,
        fcp: paints["first-contentful-paint"] ?? null,
        moduleStart: performance.getEntriesByName("popup:module-start")[0]?.startTime ?? null,
        readerAnswered: performance.getEntriesByName("popup:reader-answered")[0]?.startTime ?? null,
        statusSource: document.getElementById("status")?.dataset.source ?? "",
      }));
    };
    const deadline = performance.now() + 6000;
    const poll = () => {
      const painted = performance.getEntriesByType("paint").length > 0;
      if ((painted && performance.getEntriesByName("popup:reader-answered").length) || performance.now() > deadline) {
        return collect();
      }
      setTimeout(poll, 20);
    };
    if (document.readyState === "complete") poll();
    else window.addEventListener("load", poll, { once: true });
  })
`;

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
    ? `${label.padEnd(32)} median ${s.median.toFixed(1).padStart(7)}ms   p90 ${s.p90.toFixed(1).padStart(7)}ms   ` +
      `min ${s.min.toFixed(1).padStart(7)}ms   max ${s.max.toFixed(1).padStart(7)}ms`
    : `${label.padEnd(32)} no samples`;

/** Shut down everything of the extension that holds its renderer process open. */
async function coolExtension(browser, extensionId) {
  for (const entry of await targets()) {
    if (!entry.url.includes(extensionId)) continue;
    if (entry.type === "service_worker" || entry.url.endsWith("options.html") || entry.url.endsWith("popup.html")) {
      await browser.send("Target.closeTarget", { targetId: entry.id }).catch(() => {});
    }
  }
  await sleep(600);
}

async function openPopupAsTab(browser, popupUrl) {
  const askedAt = Date.now();
  const created = await browser.send("Target.createTarget", { url: popupUrl, background: true });
  let target;
  for (let i = 0; i < 600 && !target; i += 1) {
    target = (await targets()).find((entry) => entry.id === created.targetId && entry.webSocketDebuggerUrl);
    if (!target) await sleep(5);
  }
  const session = await new Session(target.webSocketDebuggerUrl).open();
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  const phases = JSON.parse(await session.evaluate(PHASES));
  phases.beforeDocument = phases.timeOrigin - askedAt;
  phases.clickToPaint = phases.beforeDocument + (phases.fcp ?? NaN);
  session.close();
  await browser.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
  return phases;
}

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
      `--user-data-dir=/tmp/ra-popup-process-${CDP_PORT}`,
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
    console.log(`${version.Browser}, extension ${extensionId} from ${EXTENSION_DIR}\n`);

    await waitForTarget((entry) => entry.url.startsWith(PAGE_URL), { label: PAGE_URL });

    // A credential, so the panel is the one a set-up user sees. Seeded from the
    // options page, which is an extension context and needs no worker.
    const seedTarget = await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options/options.html`,
      background: true,
    });
    const seedEntry = await waitForTarget(
      (entry) => entry.id === seedTarget.targetId && entry.url.endsWith("options/options.html"),
      { label: `options page of ${EXTENSION_DIR}`, tries: 40, every: 250 },
    );
    const seed = await new Session(seedEntry.webSocketDebuggerUrl).open();
    await seed.evaluate(`chrome.storage.local.set({ apiKey: "popup-process-placeholder" }).then(() => true)`);
    seed.close();
    await browser.send("Target.closeTarget", { targetId: seedTarget.targetId }).catch(() => {});

    const warm = [];
    const coldProcess = [];
    const afterReload = [];

    for (let run = -1; run < RUNS; run += 1) {
      // --- warm: an extension page already open -------------------------
      const keepWarm = await browser.send("Target.createTarget", {
        url: `chrome-extension://${extensionId}/options/options.html`,
        background: true,
      });
      await sleep(400);
      const warmPhases = await openPopupAsTab(browser, popupUrl);
      await browser.send("Target.closeTarget", { targetId: keepWarm.targetId }).catch(() => {});

      // --- cold: nothing of the extension is open -----------------------
      await coolExtension(browser, extensionId);
      const coldPhases = await openPopupAsTab(browser, popupUrl);

      // --- first open against a freshly loaded extension ----------------
      const freshDir = await mkdtemp(join(tmpdir(), "ra-fresh-"));
      cpSync(EXTENSION_DIR, freshDir, { recursive: true });
      const fresh = await browser.send("Extensions.loadUnpacked", { path: freshDir });
      const freshPopup = `chrome-extension://${fresh.id}/popup/popup.html`;
      const reloadPhases = await openPopupAsTab(browser, freshPopup);

      if (run >= 0) {
        warm.push(warmPhases);
        coldProcess.push(coldPhases);
        afterReload.push(reloadPhases);
      }
      console.log(
        `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
          `warm ${warmPhases.clickToPaint.toFixed(0)}ms (before-doc ${warmPhases.beforeDocument.toFixed(0)}) | ` +
          `cold process ${coldPhases.clickToPaint.toFixed(0)}ms (before-doc ${coldPhases.beforeDocument.toFixed(0)}) | ` +
          `after reload ${reloadPhases.clickToPaint.toFixed(0)}ms (before-doc ${reloadPhases.beforeDocument.toFixed(0)})`,
      );
    }

    for (const [label, samples] of [
      ["an extension page already open (warm process)", warm],
      ["nothing of the extension open (cold process)", coldProcess],
      ["first open against a freshly loaded extension", afterReload],
    ]) {
      console.log(`\n=== ${label} ===`);
      console.log(row("browser, before our document", stats(samples.map((s) => s.beforeDocument))));
      console.log(row("  → responseEnd", stats(samples.map((s) => s.responseEnd))));
      console.log(row("  → popup.js module-start", stats(samples.map((s) => s.moduleStart))));
      console.log(row("  → loadEventEnd", stats(samples.map((s) => s.loadEventEnd))));
      console.log(row("  → first contentful paint", stats(samples.map((s) => s.fcp))));
      console.log(row("  → reader answered", stats(samples.map((s) => s.readerAnswered))));
      console.log(row("open → paint (total)", stats(samples.map((s) => s.clickToPaint))));
      const sources = new Map();
      for (const sample of samples) {
        const key = sample.statusSource || "markup";
        sources.set(key, (sources.get(key) ?? 0) + 1);
      }
      console.log(`  state at rest: ${[...sources].map(([k, v]) => `${k} ${v}/${samples.length}`).join(", ")}`);
    }
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-process failed: ${error.message}`);
  process.exit(1);
});
