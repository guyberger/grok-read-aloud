/**
 * Drives a headless Chrome to show that a rebuild reaches a loaded extension.
 *
 *   node tools/dev-reload.js
 *   node tools/dev-reload.js --keep 1   # leave Chrome and the builds behind
 *
 * It builds two extensions into a temp directory — the production Chrome build
 * and the dev one — loads both into the same browser, rebuilds each, and
 * asserts what happens to each. The production build is the control: it is the
 * same source tree, loaded the same way, rebuilt the same way, and it must do
 * nothing at all.
 *
 * No mock API and no credentials: nothing here reads a page aloud. What it
 * needs from a real browser is only the two facts a stub could not give it —
 * that an unpacked extension's fetch of its own file reaches the disk, and
 * that the extension then takes itself down and the tab with it.
 *
 * ## What it cannot show
 *
 * An extension loaded over the DevTools Protocol does not come back after
 * `chrome.runtime.reload()`: Chrome drops it and neither a second
 * `Extensions.loadUnpacked` nor any amount of waiting brings it back. So the
 * last thing this can see is the extension taking itself down. That it comes
 * back into the new build is true of a `chrome://extensions` unpacked install —
 * which is the one Guy has, and the one this is for — and it is what the
 * manual checklist in the README covers. The teardown is still a real
 * assertion: the control build, polled over the same interval, never does it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_ID_FILE, buildIdFromVersionName } from "../src/dev/build-id.js";
import { build } from "./build.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(ROOT, "tests/fixtures");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const KEEP = args.get("keep") === "1";
const PORT = Number(args.get("port") ?? 9344);
const PAGE_PORT = Number(args.get("page-port") ?? 8779);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

class Session {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.console = [];
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((done, fail) => {
      this.socket.onopen = done;
      this.socket.onerror = () => fail(new Error(`cannot connect to ${this.url}`));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled") {
        this.console.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
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
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      setTimeout(() => this.pending.delete(id) && fail(new Error(`${method} timed out`)), 20000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] ?? "evaluation failed");
    }
    return result.result.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) ?? [];
}

async function findTarget(predicate, { label, timeoutMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await targets()).find(predicate);
    if (found?.webSocketDebuggerUrl) return found;
    await sleep(200);
  }
  throw new Error(`target not found: ${label}`);
}

/** The build id a directory on disk says it holds, or null for a prod build. */
const buildIdOnDisk = (directory) => {
  const path = resolve(directory, BUILD_ID_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")).buildId;
};

async function main() {
  const binary = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!binary) {
    console.log("no Chrome binary found; set CHROME_PATH");
    process.exit(0);
  }

  const out = mkdtempSync(resolve(tmpdir(), "dev-reload-"));
  const profile = resolve(out, "profile");

  // The test build rather than the plain Chrome one: the dev half of this needs
  // content scripts in a page, and activeTab is granted by a user gesture the
  // protocol cannot produce. See dist/chrome-test in the README.
  const devDir = resolve(out, "chrome-test");
  const prodDir = resolve(out, "chrome");
  build({ dev: true, only: "chrome-test", out });
  build({ dev: false, only: "chrome", out });
  console.log(`built into ${out}\n`);

  // A page the extension may be asked to inject into.
  const pages = createServer((request, response) => {
    const name = (request.url ?? "/").replace(/^\/+/, "").split("?")[0] || "article.html";
    const path = resolve(FIXTURES, name);
    if (!path.startsWith(FIXTURES) || !existsSync(path)) {
      response.writeHead(404).end("no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(path));
  });
  await new Promise((done) => pages.listen(PAGE_PORT, "127.0.0.1", done));
  const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/article.html`;

  const chrome = spawn(
    binary,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      PAGE_URL,
    ],
    { stdio: "ignore" },
  );

  let version = null;
  for (let i = 0; i < 100 && !version; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome never accepted a debugging connection");
  const browser = await new Session(version.webSocketDebuggerUrl).open();

  /** Opens one of an extension's own pages and asks it what it is. */
  const interrogate = async (id) => {
    const { targetId } = await browser.send("Target.createTarget", {
      url: `chrome-extension://${id}/options/options.html`,
      background: true,
    });
    try {
      const target = await findTarget((entry) => entry.id === targetId, { label: "options page", timeoutMs: 8000 });
      const page = await new Session(target.webSocketDebuggerUrl).open();
      await page.send("Runtime.enable");
      const answer = await page.evaluate(`
        (async () => {
          if (!globalThis.chrome?.runtime?.getURL) return JSON.stringify({ alive: false });
          const manifest = chrome.runtime.getManifest();
          let onDisk = null;
          try {
            const response = await fetch(chrome.runtime.getURL("build-id.json"), { cache: "no-store" });
            if (response.ok) onDisk = JSON.parse(await response.text()).buildId;
          } catch { onDisk = null; }
          return JSON.stringify({
            alive: true,
            versionName: manifest.version_name ?? null,
            permissions: manifest.permissions,
            worker: manifest.background?.service_worker ?? null,
            onDisk,
          });
        })()
      `);
      page.close();
      return JSON.parse(answer);
    } catch {
      return { alive: false };
    } finally {
      await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  };

  // -------------------------------------------------------------------------
  // 1. The control: the production build, rebuilt under it, does nothing.
  const prod = await browser.send("Extensions.loadUnpacked", { path: prodDir });
  const prodBefore = await interrogate(prod.id);
  check(
    "the production build holds no build id to watch",
    prodBefore.alive && prodBefore.versionName === null && prodBefore.onDisk === null,
    prodBefore.alive ? `version_name ${JSON.stringify(prodBefore.versionName)}` : "the extension never answered",
  );
  check(
    "it asks for no dev permission and runs the real worker",
    !prodBefore.permissions?.includes("alarms") && prodBefore.worker === "background/background.js",
    `${prodBefore.permissions?.join(", ")} — ${prodBefore.worker}`,
  );
  check(
    "and holds no reload code",
    !existsSync(resolve(prodDir, "dev")) && !existsSync(resolve(prodDir, BUILD_ID_FILE)),
    `${prodDir}`,
  );

  build({ dev: false, only: "chrome", out });

  // -------------------------------------------------------------------------
  // 2. The dev build, loaded the way Guy loads it: once, and then left alone.
  const dev = await browser.send("Extensions.loadUnpacked", { path: devDir });
  const firstBuild = buildIdOnDisk(devDir);
  const devBefore = await interrogate(dev.id);
  check(
    "the dev build names the build it is running",
    buildIdFromVersionName(devBefore.versionName) === firstBuild,
    `${JSON.stringify(devBefore.versionName)} for build ${firstBuild}`,
  );
  check(
    "and reads the same build off its own files",
    devBefore.onDisk === firstBuild,
    `${devBefore.onDisk} vs ${firstBuild}`,
  );

  // Watch what the worker says. Everything the reload decides is logged there,
  // which is the difference between it reloading and it falling over.
  const workerTarget = await findTarget(
    (entry) => entry.type === "service_worker" && entry.url.includes(dev.id),
    { label: "the dev build's service worker" },
  );
  const worker = await new Session(workerTarget.webSocketDebuggerUrl).open();
  await worker.send("Runtime.enable");

  // Content scripts in a page, injected the way the popup injects them, so the
  // tab the reload has to deal with is a tab with the old build's scripts in it.
  const pageTarget = await findTarget((entry) => entry.url.startsWith(PAGE_URL), { label: PAGE_URL });
  await browser.send("Target.activateTarget", { targetId: pageTarget.id });
  const page = await new Session(pageTarget.webSocketDebuggerUrl).open();
  await page.send("Page.enable");
  await page.send("Runtime.enable");

  const uiTarget = await browser
    .send("Target.createTarget", { url: `chrome-extension://${dev.id}/options/options.html`, background: true })
    .then(({ targetId }) => findTarget((entry) => entry.id === targetId, { label: "options page" }));
  const ui = await new Session(uiTarget.webSocketDebuggerUrl).open();
  await ui.send("Runtime.enable");
  await browser.send("Target.activateTarget", { targetId: pageTarget.id });
  const injected = await ui.evaluate(
    `new Promise((done) => chrome.runtime.sendMessage({ type: "getTabState" }, (answer) => done(JSON.stringify(answer ?? null))))`,
  );
  check(
    "the content scripts are in the page",
    JSON.parse(injected ?? "null")?.ok === true,
    (JSON.parse(injected ?? "null")?.error ?? "").slice(0, 80),
  );

  // A mark on the document, so a reload of the tab is visible as one.
  await page.evaluate(`window.__devReloadMark = "before"; true`);

  // -------------------------------------------------------------------------
  // 3. Left alone, nothing happens — over several times the poll interval.
  await sleep(8000);
  const settled = await interrogate(dev.id);
  check(
    "an unchanged build is left alone",
    settled.alive && buildIdFromVersionName(settled.versionName) === firstBuild,
    settled.alive ? `still build ${firstBuild} after 8s` : "the extension took itself down anyway",
  );
  check(
    "with nothing said about reloading",
    !worker.console.some((line) => line.includes("reloading")),
    worker.console.join(" | ").slice(0, 120),
  );
  check(
    "and the page it is reading left where it was",
    (await page.evaluate(`window.__devReloadMark ?? null`)) === "before",
  );

  // -------------------------------------------------------------------------
  // 4. A rebuild, and the extension reloads itself into it.
  build({ dev: true, only: "chrome-test", out });
  const secondBuild = buildIdOnDisk(devDir);
  check("a rebuild writes a new build id", secondBuild !== firstBuild, `${firstBuild} → ${secondBuild}`);

  const deadline = Date.now() + 45000;
  let announced = "";
  let toreDown = false;
  let tabReloaded = false;
  while (Date.now() < deadline && !(announced && toreDown && tabReloaded)) {
    announced ||= worker.console.find((line) => line.includes("reloading the extension")) ?? "";
    if (!tabReloaded) {
      tabReloaded = (await page.evaluate(`window.__devReloadMark ?? null`).catch(() => null)) === null;
    }
    if (!toreDown) toreDown = !(await targets()).some((entry) => entry.url.includes(dev.id));
    await sleep(250);
  }

  check(
    "the running extension notices the build on disk and says so",
    announced.includes(secondBuild),
    announced || "nothing was said",
  );
  check(
    "it reloads the tab holding the old build's content scripts",
    tabReloaded,
    tabReloaded ? "the document is a new one" : "the mark set before the rebuild is still there",
  );
  check(
    "and then reloads itself — worker, panel and all",
    toreDown,
    toreDown ? "no context of the old build is left" : "the old contexts are still up",
  );

  // -------------------------------------------------------------------------
  // 5. The control again: the production build sat through all of that.
  const prodAfter = await interrogate(prod.id);
  check(
    "the production build is still running, untouched by any of it",
    prodAfter.alive && prodAfter.versionName === null,
    prodAfter.alive ? "still up, still unnamed" : "it went down too",
  );

  if (!KEEP) {
    chrome.kill();
    pages.close();
    rmSync(out, { recursive: true, force: true });
  } else {
    console.log(`\nleft behind: ${out} (Chrome on ${PORT}, pages on ${PAGE_PORT})`);
  }

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(`dev-reload check failed: ${error.message}`);
  process.exit(1);
});
