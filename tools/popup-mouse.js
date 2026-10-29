/**
 * TEMPORARY DIAGNOSTIC — not part of the build or the checks.
 *
 * The highest-fidelity version of the owner's complaint available here: a real
 * mouse click on the pinned toolbar icon, in a real browser window on Xvfb,
 * with nothing of the extension open.
 *
 * Every other harness calls `chrome.action.openPopup()`, which has two
 * problems: it is not the toolbar button, and it has to be called from an
 * extension page, which keeps the extension's renderer process warm. This one
 * clicks the icon with xdotool, so the click path and a cold renderer process
 * are both the real thing.
 *
 * The icon's position is found by trying candidate x offsets along the toolbar
 * until one of them opens a popup, so it does not depend on a guess about
 * Chrome's toolbar layout.
 *
 *   node tools/popup-mouse.js --runs 10 --extension dist/chrome
 *   node tools/popup-mouse.js --runs 10 --extension dist/chrome --cold 1
 */
import { execFileSync, spawn } from "node:child_process";
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
const CDP_PORT = Number(args.get("port") ?? 9580);
const FIXTURE_PORT = Number(args.get("fixture-port") ?? 8880);
const EXTENSION_DIR = resolve(args.get("extension") ?? new URL("../dist/chrome", import.meta.url).pathname);
const COLD = args.get("cold") === "1";
const DISPLAY = args.get("display") ?? ":1";
const LABEL = args.get("label") ?? EXTENSION_DIR.split("/").at(-1);
const WIDTH = 1400;
const HEIGHT = 900;

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

const TIMINGS = `
  new Promise((resolve) => {
    const read = () => {
      const nav = performance.getEntriesByType("navigation")[0] ?? {};
      const paints = {};
      for (const entry of performance.getEntriesByType("paint")) paints[entry.name] = entry.startTime;
      return {
        timeOrigin: performance.timeOrigin,
        responseEnd: nav.responseEnd ?? null,
        domContentLoaded: nav.domContentLoadedEventEnd ?? null,
        loadEventEnd: nav.loadEventEnd ?? null,
        fcp: paints["first-contentful-paint"] ?? null,
        moduleStart: performance.getEntriesByName("popup:module-start")[0]?.startTime ?? null,
        height: Math.round(document.body?.getBoundingClientRect().height ?? 0),
      };
    };
    const poll = () => {
      const seen = read();
      if (seen.loadEventEnd) return resolve(JSON.stringify(seen));
      setTimeout(poll, 4);
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
    ? `${label.padEnd(38)} median ${s.median.toFixed(1).padStart(7)}ms   p90 ${s.p90.toFixed(1).padStart(7)}ms   ` +
      `min ${s.min.toFixed(1).padStart(7)}ms   max ${s.max.toFixed(1).padStart(7)}ms`
    : `${label.padEnd(38)} no samples`;

const xdo = (...argv) => execFileSync("xdotool", argv, { env: { ...process.env, DISPLAY }, encoding: "utf8" }).trim();

async function main() {
  const fixtures = await serveFixtures();
  const extensionId = unpackedExtensionId(EXTENSION_DIR);
  const profile = `/tmp/ra-mouse-${CDP_PORT}`;
  rmSync(profile, { recursive: true, force: true });
  await mkdir(`${profile}/Default`, { recursive: true });
  await writeFile(
    `${profile}/Default/Preferences`,
    JSON.stringify({ extensions: { pinned_extensions: [extensionId] } }),
  );

  const chrome = spawn(
    "google-chrome",
    [
      "--no-sandbox",
      "--disable-gpu",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--window-position=0,0",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      `http://127.0.0.1:${FIXTURE_PORT}/article.html`,
    ],
    { stdio: "ignore", env: { ...process.env, DISPLAY } },
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
    console.log(`${version.Browser} (headful on ${DISPLAY}), ${LABEL}`);

    const articleTarget = await waitForTarget((entry) => entry.url.includes("article.html"), { label: "article" });

    // Seed a credential, then close the page again so the extension's renderer
    // process is not being held open by it.
    const seed = await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options/options.html`,
      background: true,
    });
    const seedEntry = await waitForTarget((entry) => entry.id === seed.targetId && entry.url.endsWith("options.html"), {
      label: "options page",
    });
    const seedSession = await new Session(seedEntry.webSocketDebuggerUrl).open();
    await seedSession.evaluate(`chrome.storage.local.set({ apiKey: "mouse-placeholder" }).then(() => true)`);
    seedSession.close();
    await browser.send("Target.closeTarget", { targetId: seed.targetId }).catch(() => {});
    await sleep(500);

    const windowId = xdo("search", "--onlyvisible", "--class", "chrome").split("\n").at(-1);
    xdo("windowactivate", "--sync", windowId);
    xdo("windowmove", windowId, "0", "0");
    await sleep(600);

    async function popupTarget() {
      return (await targets()).find((entry) => entry.url === popupUrl);
    }

    async function dismiss() {
      xdo("key", "--clearmodifiers", "Escape");
      await sleep(250);
      const open = await popupTarget();
      if (open) await browser.send("Target.closeTarget", { targetId: open.id }).catch(() => {});
      await sleep(200);
    }

    // Where the window actually is, which is not where it was asked to be:
    // the window manager adds a title bar and trims the size.
    const geometry = xdo("getwindowgeometry", windowId);
    const position = geometry.match(/Position:\s*(-?\d+),(-?\d+)/);
    const size = geometry.match(/Geometry:\s*(\d+)x(\d+)/);
    const originX = Number(position?.[1] ?? 0);
    const originY = Number(position?.[2] ?? 0);
    const frameWidth = Number(size?.[1] ?? WIDTH);
    console.log(`window at ${originX},${originY} sized ${frameWidth}x${size?.[2]}`);

    // Find the pinned icon: walk the toolbar until a click opens a popup. The
    // toolbar sits under the tab strip, so a few rows are tried.
    let iconX = null;
    let iconY = null;
    for (const y of [originY + 78, originY + 70, originY + 86, originY + 62, originY + 94]) {
      for (let x = originX + frameWidth - 24; x > originX + frameWidth - 300; x -= 8) {
        xdo("mousemove", "--sync", String(x), String(y));
        xdo("click", "1");
        await sleep(420);
        if (await popupTarget()) {
          iconX = x;
          iconY = y;
          await dismiss();
          break;
        }
        await dismiss();
      }
      if (iconX !== null) break;
    }
    if (iconX === null) throw new Error("could not find the pinned action in the toolbar");
    console.log(`pinned action found at ${iconX},${iconY}; worker ${COLD ? "stopped before each click" : "left awake"}\n`);

    const samples = [];
    for (let run = -1; run < RUNS; run += 1) {
      await browser.send("Target.activateTarget", { targetId: articleTarget.id });
      xdo("windowactivate", "--sync", windowId);
      await sleep(250);

      if (COLD) {
        for (const entry of await targets()) {
          if (entry.type === "service_worker" && entry.url.includes(extensionId)) {
            await browser.send("Target.closeTarget", { targetId: entry.id }).catch(() => {});
          }
        }
        await sleep(500);
      }
      const workerAwake = (await targets()).some(
        (entry) => entry.type === "service_worker" && entry.url.includes(extensionId),
      );

      xdo("mousemove", "--sync", String(iconX), String(iconY));
      const clickedAt = Date.now();
      xdo("click", "1");

      let target;
      for (let i = 0; i < 3000 && !target; i += 1) {
        target = await popupTarget();
        if (!target) await sleep(2);
      }
      if (!target) throw new Error("the popup never opened");

      const popup = await new Session(target.webSocketDebuggerUrl).open();
      const timings = JSON.parse(await popup.evaluate(TIMINGS));
      popup.close();

      const from = (value) => (typeof value === "number" ? timings.timeOrigin - clickedAt + value : null);
      const sample = {
        workerAwake,
        toDocument: timings.timeOrigin - clickedAt,
        toResponseEnd: from(timings.responseEnd),
        toModuleStart: from(timings.moduleStart),
        toDcl: from(timings.domContentLoaded),
        toVisible: from(timings.loadEventEnd),
        toPaint: from(timings.fcp),
        height: timings.height,
      };
      if (run >= 0) samples.push(sample);
      console.log(
        `${run < 0 ? "warmup" : `run ${String(run + 1).padStart(2)}`} — ` +
          `worker ${workerAwake ? "awake " : "stopped"}, ` +
          `click→document ${sample.toDocument.toFixed(0)}ms, ` +
          `→module ${sample.toModuleStart === null ? "n/a" : sample.toModuleStart.toFixed(0)}ms, ` +
          `→load ${sample.toVisible.toFixed(0)}ms, ` +
          `→paint ${sample.toPaint === null ? "n/a" : sample.toPaint.toFixed(0)}ms, h=${sample.height}`,
      );

      await dismiss();
    }

    console.log(`\n=== ${LABEL}, real mouse click, worker ${COLD ? "cold" : "warm"}, no extension page open ===`);
    console.log(row("click → popup document exists", stats(samples.map((s) => s.toDocument))));
    console.log(row("click → popup.html responseEnd", stats(samples.map((s) => s.toResponseEnd))));
    console.log(row("click → popup.js starts running", stats(samples.map((s) => s.toModuleStart))));
    console.log(row("click → DOMContentLoaded", stats(samples.map((s) => s.toDcl))));
    console.log(row("click → load event (WINDOW SHOWN)", stats(samples.map((s) => s.toVisible))));
    console.log(row("click → first contentful paint", stats(samples.map((s) => s.toPaint))));
    console.log(`panel height: ${[...new Set(samples.map((s) => s.height))].join(", ")}`);
  } finally {
    chrome.kill();
    fixtures.close();
  }
}

main().catch((error) => {
  console.error(`popup-mouse failed: ${error.message}`);
  process.exit(1);
});
