/**
 * TEMPORARY DIAGNOSTIC — not part of the build or the checks.
 *
 * `tools/popup-paint.js` and `tools/popup-window.js` answer "when does the
 * panel appear". This answers "when is it any use", over pages that behave
 * like the ones a popup is actually opened on, with the action pinned so the
 * toolbar pop-out animation is out of the way.
 *
 * Four moments are timed from the click, not from the document:
 *
 *   visible    the load event — Chrome shows the popup window at this point
 *   paint      first contentful paint
 *   sized      the last time the panel changed height; a popup that grows
 *              after Chrome has sized its window visibly jumps
 *   usable     the first time the panel shows the *reader's* state rather
 *              than its markup default or a remembered one, so the transport
 *              is live and the buttons mean something
 *
 * Over four pages — a small article, a long one, a Google-Docs-shaped DOM, and
 * a heavy SPA that keeps taking long tasks — in three states:
 *
 *   second     the popup has been opened on this tab already, so the content
 *              scripts are in the page and only have to answer
 *   fresh      the tab has just navigated, so the worker has to inject them
 *   cold       as `fresh`, and the worker has been stopped as well
 *
 *   node tools/popup-realworld.js --runs 6 --extension dist/chrome-test
 *   node tools/popup-realworld.js --runs 6 --seed-tabs 2000
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const RUNS = Number(args.get("runs") ?? 6);
const CDP_PORT = Number(args.get("port") ?? 9520);
const FIXTURE_PORT = Number(args.get("fixture-port") ?? 8830);
const EXTENSION_DIR = resolve(args.get("extension") ?? new URL("../dist/chrome-test", import.meta.url).pathname);
const HEADFUL = args.get("headful") === "1";
/** Remembered per-tab entries to leave in storage.session before measuring. */
const SEED_TABS = Number(args.get("seed-tabs") ?? 0);
const ONLY_PAGE = args.get("page") ?? null;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const unpackedExtensionId = (path) =>
  [...createHash("sha256").update(path).digest("hex").slice(0, 32)]
    .map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16)))
    .join("");

/* ------------------------------------------------------------------ pages */

/** A long article: a big, deep, static DOM with nothing running in it. */
function longArticle() {
  const paragraphs = [];
  for (let i = 0; i < 4000; i += 1) {
    paragraphs.push(
      `<p>Paragraph ${i}. ${"The reader has to walk this document and find the sentences in it. ".repeat(4)}</p>`,
    );
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>A long article</title></head>
<body><article><h1>A long article</h1>${paragraphs.join("\n")}</article></body></html>`;
}

/**
 * A heavy single-page app: a large DOM, a lot of its own script to compile, and
 * a main thread that keeps taking long tasks the way a video or mail client
 * does. Nothing can be injected into a page while it is inside one of those.
 */
function heavySpa() {
  const nodes = [];
  for (let i = 0; i < 6000; i += 1) {
    nodes.push(
      `<div class="row" data-i="${i}"><span class="a">Item ${i}</span><span class="b">detail</span>` +
        `<div class="c"><em>nested</em><strong>content</strong></div></div>`,
    );
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Heavy SPA</title></head>
<body><main id="app">${nodes.join("\n")}</main>
<script>
  // Keeps taking long tasks for a while after load, like a page still booting.
  let ticks = 0;
  const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
  const beat = () => {
    if (ticks++ > 40) return;
    spin(120);
    setTimeout(beat, 60);
  };
  beat();
</script>
</body></html>`;
}

const GENERATED = {
  "long.html": longArticle,
  "spa.html": heavySpa,
};

function serveFixtures() {
  const root = new URL("../tests/fixtures/", import.meta.url);
  const server = createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
      const body = GENERATED[name] ? GENERATED[name]() : await readFile(new URL(name, root), "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((done) => server.listen(FIXTURE_PORT, "127.0.0.1", () => done(server)));
}

/* --------------------------------------------------------------- protocol */

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

/**
 * Installed at document start, before the popup's own script. Records every
 * height the panel has had, and the first time it shows a state it was handed
 * rather than the one in its markup — `live` meaning the reader's own.
 */
const WATCHER = `
  (() => {
    window.__sizes = [];
    window.__renderedAt = null;
    window.__liveAt = null;
    const status = () => document.getElementById("status");
    const note = () => {
      const el = status();
      if (window.__renderedAt === null && el?.dataset.state) window.__renderedAt = performance.now();
      if (window.__liveAt === null && el?.dataset.source === "live") window.__liveAt = performance.now();
    };
    const start = () => {
      if (!document.documentElement) return false;
      new MutationObserver(note).observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "data-source", "hidden"],
      });
      note();
      if (document.body) {
        new ResizeObserver((entries) => {
          for (const entry of entries) {
            const height = Math.round(entry.contentRect.height);
            const last = window.__sizes.at(-1);
            if (!last || last.height !== height) window.__sizes.push({ height, at: performance.now() });
          }
        }).observe(document.body);
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          new ResizeObserver((entries) => {
            for (const entry of entries) {
              const height = Math.round(entry.contentRect.height);
              const last = window.__sizes.at(-1);
              if (!last || last.height !== height) window.__sizes.push({ height, at: performance.now() });
            }
          }).observe(document.body);
        }, { once: true });
      }
      return true;
    };
    if (!start()) {
      const retry = setInterval(() => { if (start()) clearInterval(retry); }, 1);
    }
  })()
`;

/**
 * Waits for the reader's own state, then reports every moment that matters.
 *
 * Run after attaching rather than at document start, because a popup opened by
 * the toolbar cannot be attached to before it exists. `attachedAt` is therefore
 * the floor on what this can see: anything already true by then is reported as
 * "already", and the numbers worth having here — a reader behind a busy page —
 * are hundreds of milliseconds above that floor.
 */
const PROBE = (budget) => `
  new Promise((resolve) => {
    const attachedAt = performance.now();
    const source = () => document.getElementById("status")?.dataset.source ?? "";
    const height = () => Math.round(document.body?.getBoundingClientRect().height ?? 0);
    const startedLive = source() === "live";
    let liveAt = startedLive ? attachedAt : null;
    let lastHeight = height();
    let lastResizeAt = attachedAt;
    const heights = [lastHeight];
    const deadline = attachedAt + ${budget};
    const done = () => {
      const nav = performance.getEntriesByType("navigation")[0] ?? {};
      const paints = {};
      for (const entry of performance.getEntriesByType("paint")) paints[entry.name] = entry.startTime;
      resolve(JSON.stringify({
        timeOrigin: performance.timeOrigin,
        attachedAt,
        startedLive,
        visible: nav.loadEventEnd ?? null,
        domContentLoaded: nav.domContentLoadedEventEnd ?? null,
        fcp: paints["first-contentful-paint"] ?? null,
        live: liveAt,
        lastResizeAt,
        heights,
        voiceOptions: document.getElementById("voice")?.options.length ?? 0,
        statusLabel: document.getElementById("status")?.textContent?.trim() ?? "",
        statusSource: source(),
        toggleLabel: document.getElementById("toggle-label")?.textContent?.trim() ?? "",
        stopDisabled: document.getElementById("stop")?.disabled ?? null,
      }));
    };
    const poll = () => {
      const now = performance.now();
      const current = height();
      if (current !== lastHeight) {
        lastHeight = current;
        lastResizeAt = now;
        heights.push(current);
      }
      if (liveAt === null && source() === "live") liveAt = now;
      // Keep watching a little past the live answer, so a panel that grows
      // once the reader has spoken is still caught.
      const settled = liveAt !== null && now > liveAt + 300;
      if (settled || now > deadline) return done();
      setTimeout(poll, 8);
    };
    poll();
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

async function killWorker(browser, extensionId) {
  for (const entry of await targets()) {
    if (entry.type === "service_worker" && entry.url.includes(extensionId)) {
      await browser.send("Target.closeTarget", { targetId: entry.id }).catch(() => {});
    }
  }
  await sleep(400);
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

const cell = (s) => (s ? `${s.median.toFixed(0)}/${s.p90.toFixed(0)}` : "—");

async function main() {
  const fixtures = await serveFixtures();
  const extensionId = unpackedExtensionId(EXTENSION_DIR);
  const profile = `/tmp/ra-realworld-${CDP_PORT}`;
  rmSync(profile, { recursive: true, force: true });
  await mkdir(`${profile}/Default`, { recursive: true });
  // Pinned, so the toolbar pop-out animation is not in any of these numbers.
  await writeFile(
    `${profile}/Default/Preferences`,
    JSON.stringify({ extensions: { pinned_extensions: [extensionId] } }),
  );

  const chrome = spawn(
    "google-chrome",
    [
      ...(HEADFUL ? [] : ["--headless=new"]),
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1512,982",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "about:blank",
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
    console.log(`${version.Browser}, ${EXTENSION_DIR}`);
    console.log(`action pinned, ${RUNS} runs per cell, ${SEED_TABS} seeded panel-cache entries\n`);

    // A tab to act on, and an extension page to drive openPopup from.
    const article = await browser.send("Target.createTarget", {
      url: `http://127.0.0.1:${FIXTURE_PORT}/article.html`,
    });
    const articleTarget = await waitForTarget((entry) => entry.id === article.targetId && entry.webSocketDebuggerUrl, {
      label: "article tab",
    });
    const articleSession = await new Session(articleTarget.webSocketDebuggerUrl).open();
    await articleSession.send("Page.enable");

    await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options/options.html`,
      background: true,
    });
    const driverTarget = await waitForTarget((entry) => entry.url.endsWith("options/options.html"), {
      label: "options page",
    });
    const driver = await new Session(driverTarget.webSocketDebuggerUrl).open();
    await driver.evaluate(`chrome.storage.local.set({ apiKey: "realworld-placeholder" }).then(() => true)`);
    if (SEED_TABS) {
      await driver.evaluate(
        `(async () => {
           const entries = {};
           for (let i = 0; i < ${SEED_TABS}; i += 1) {
             entries["panel:tab:" + (100000 + i)] = {
               state: { status: "paused", scope: "page", chunkIndex: 3, chunkCount: 40, progress: 0.2,
                        remainingSeconds: 600, title: "A remembered tab " + i, rate: 1, voiceId: "eve" },
               at: Date.now(),
             };
           }
           await chrome.storage.session.set(entries);
           return Object.keys(await chrome.storage.session.get(null)).length;
         })()`,
      );
    }

    const windowId = await driver.evaluate(
      `chrome.tabs.query({ active: true }).then((tabs) =>
         (tabs.find((tab) => (tab.url ?? "").startsWith("http://127.0.0.1:${FIXTURE_PORT}")) ?? tabs[0]).windowId)`,
    );

    async function openPopup(budget) {
      const clickedAt = Date.now();
      const opened = await driver.evaluate(
        `chrome.action.openPopup({ windowId: ${windowId} }).then(() => "ok", (e) => "failed: " + e.message)`,
      );
      if (opened !== "ok") throw new Error(`openPopup ${opened}`);
      let target;
      for (let i = 0; i < 1200 && !target; i += 1) {
        target = (await targets()).find((entry) => entry.url === popupUrl);
        if (!target) await sleep(5);
      }
      if (!target) throw new Error("the popup never opened");
      const popup = await new Session(target.webSocketDebuggerUrl).open();
      // A popup window the headless browser never shows is never composited,
      // so without these there are no paint entries to read.
      await popup.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await popup.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
      const phases = JSON.parse(await popup.evaluate(PROBE(budget)));
      popup.close();
      await browser.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
      const from = (value) => (typeof value === "number" ? phases.timeOrigin - clickedAt + value : null);
      return {
        ...phases,
        toVisible: from(phases.visible),
        toPaint: from(phases.fcp),
        toUsable: from(phases.live),
        toAttached: from(phases.attachedAt),
        toSized: from(phases.lastResizeAt),
      };
    }

    /** The popup wants the page active, or the worker resolves the wrong tab. */
    async function focusArticle() {
      await browser.send("Target.activateTarget", { targetId: articleTarget.id });
      await sleep(120);
    }

    const pages = [
      { key: "article", label: "small article", url: `http://127.0.0.1:${FIXTURE_PORT}/article.html`, budget: 8000 },
      { key: "long", label: "long article", url: `http://127.0.0.1:${FIXTURE_PORT}/long.html`, budget: 15000 },
      {
        key: "docs",
        label: "Google-Docs DOM",
        url: `http://127.0.0.1:${FIXTURE_PORT}/google-docs-dom.html`,
        budget: 8000,
      },
      { key: "spa", label: "heavy SPA", url: `http://127.0.0.1:${FIXTURE_PORT}/spa.html`, budget: 20000 },
    ].filter((page) => !ONLY_PAGE || page.key === ONLY_PAGE);

    const results = new Map();

    for (const page of pages) {
      for (const state of ["second", "fresh", "cold"]) {
        const samples = [];
        for (let run = -1; run < RUNS; run += 1) {
          // A fresh document, so nothing of the extension is in the page.
          await articleSession.send("Page.navigate", { url: page.url });
          await sleep(page.key === "spa" ? 1200 : 700);
          await focusArticle();

          if (state === "second") {
            // One open to get the content scripts in, which is not measured.
            await openPopup(page.budget);
            await sleep(250);
            await focusArticle();
          }
          if (state === "cold") await killWorker(browser, extensionId);

          const phases = await openPopup(page.budget);
          if (run >= 0) samples.push(phases);
          await sleep(200);
        }
        results.set(`${page.key}:${state}`, samples);
        const label = `${page.label} / ${state}`;
        console.log(
          `${label.padEnd(30)} visible ${cell(stats(samples.map((s) => s.toVisible))).padStart(10)}  ` +
            `paint ${cell(stats(samples.map((s) => s.toPaint))).padStart(10)}  ` +
            `sized ${cell(stats(samples.map((s) => s.toSized))).padStart(10)}  ` +
            `usable ${cell(stats(samples.map((s) => s.toUsable))).padStart(12)}  ` +
            `heights ${[...new Set(samples.map((s) => s.heights.join("→")))].join(" | ")}`,
        );
      }
    }

    console.log(`\n${"".padEnd(100, "=")}`);
    console.log("median/p90 ms from the click, action pinned\n");
    console.log(
      `${"page / state".padEnd(30)}${"visible".padStart(12)}${"paint".padStart(12)}${"sized".padStart(12)}${"usable".padStart(14)}`,
    );
    for (const [key, samples] of results) {
      console.log(
        `${key.padEnd(30)}${cell(stats(samples.map((s) => s.toVisible))).padStart(12)}` +
          `${cell(stats(samples.map((s) => s.toPaint))).padStart(12)}` +
          `${cell(stats(samples.map((s) => s.toSized))).padStart(12)}` +
          `${cell(stats(samples.map((s) => s.toUsable))).padStart(14)}`,
      );
    }

    console.log(`\nwhat the panel settled on:`);
    for (const [key, samples] of results) {
      const last = samples.at(-1);
      console.log(
        `  ${key.padEnd(28)} "${last?.statusLabel} / ${last?.toggleLabel}" from ${last?.statusSource || "markup"}, ` +
          `${last?.voiceOptions} voices, stop ${last?.toggleDisabled ? "disabled" : "enabled"}`,
      );
    }
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-realworld failed: ${error.message}`);
  process.exit(1);
});
