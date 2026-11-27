/**
 * Seeded adversarial driver for the packaged extension.
 *
 *   npm run fuzz
 *   node tools/fuzz.js --seed 20261125 --scenario emoji-highlight
 *   node tools/fuzz.js --seed 20261125 --scenario a,b
 *
 * Builds the chrome-test extension, starts the mock API and a page server,
 * and drives headless Chrome. Scenarios tagged with a bug title are open bugs,
 * expected to reproduce on every repeat. Every other scenario checks an
 * invariant, including bugs that have since been fixed. The process exits 0
 * when those open bugs still reproduce and nothing else breaks, 2 when an
 * open bug does not reproduce, and 1 when an invariant fails.
 *
 * Reproductions of open bugs also live in tests/bugs.test.js as expected
 * failures, so `npm test` stays green while they are open.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { huntPages, huntScenarios } from "./fuzz-hunt.js";
import { nightPages, nightScenarios } from "./fuzz-night.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const SEED = Number(args.get("seed") ?? 20261124);
const ONLY = new Set(
  (args.get("scenario") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
const REPEATS = Number(args.get("repeats") ?? 2);
const ARTIFACTS = resolve(args.get("artifacts") ?? "/opt/cursor/artifacts");
const MOCK_PORT = Number(args.get("mock-port") ?? 18443);
const PAGE_PORT = Number(args.get("page-port") ?? 18777);
const CDP_PORT = Number(args.get("cdp-port") ?? 19333);
const KEY = "mock-local-key";

const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pageShell(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
    <style>
      body { margin: 0; font: 18px/1.6 Georgia, serif; }
      nav, footer { font: 14px system-ui, sans-serif; background: #eee; padding: 12px 16px; }
      article { max-width: 680px; margin: 24px auto; padding: 0 16px 80px; }
      td, th { border: 1px solid #ccc; padding: 6px 10px; }
    </style></head><body>
    <nav>Navigation: Home · Notes · Index</nav>
    ${body}
    <footer>Footer: sources and corrections.</footer>
    </body></html>`;
}

const pages = new Map();

pages.set("emoji.html", readFileSync(resolve(ROOT, "tests/fixtures/emoji.html"), "utf8"));
pages.set(
  "few-emoji.html",
  pageShell(
    "A few emoji",
    `<article><p>The launch was great 🚀🚀🚀 and then the crew walked back across the dam to write the tide down in the ledger.</p>
     <p>Nothing about the wheel changed overnight, and the pegs were still tight in the morning.</p></article>`,
  ),
);
pages.set(
  "article.html",
  pageShell(
    "How tide mills worked",
    `<article><h1>How tide mills worked</h1>
     <p>The mill at Blackwater has run on the tide for four hundred years, and every part of it that still moves is made of wood.</p>
     <p>Twice a day the pond fills through the sluice and empties again through the wheel, so the frame is wet while it is working.</p>
     <p>A wheel left dry for a whole season opens at its joints, and a wheel that is never dry goes soft at the heart.</p>
     <p>Nothing in the frame is glued. Every joint is pegged, and every peg can be driven out with a mallet and a patient hour.</p>
     <p>When a bucket splits, the wheelwright cuts a new one from elm that has lain under water since the spring.</p></article>`,
  ),
);
pages.set(
  "shadow.html",
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shadow mill</title></head><body>
    <script>
      const host = document.createElement("article");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = "<h1>Shadow mill</h1><p>The shadow article asks for a new elm bucket cut from timber that has lain under water since the spring, because a bucket that shrinks will rattle itself to pieces within a winter.</p>";
      document.body.append(host);
    </script></body></html>`,
);
pages.set(
  "spa.html",
  pageShell(
    "SPA mill",
    `<article id="story"><h1>First route</h1>
     <p>The first route describes the sluice, the pond, and the wheel that empties it twice a day.</p>
     <p>Readers who stay on this route hear about pegs, bearings, and the ledger in the office.</p></article>`,
  ),
);
pages.set(
  "empty.html",
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Empty</title></head><body><nav>Home</nav><main></main></body></html>`,
);
pages.set(
  "rtl.html",
  pageShell(
    "طاحونة",
    `<article dir="rtl" lang="ar"><h1>طاحونة المد</h1>
     <p>تعمل الطاحونة على المد مرتين في اليوم، ويحافظ الحارس على العجلة الخشبية قبل أن يجف الخشب وينفتح عند المفاصل.</p>
     <p>لا شيء في الإطار ملصوق. كل وصلة مثبتة بوتد يمكن إخراجه بمطرقة وصبر.</p></article>`,
  ),
);
pages.set(
  "table.html",
  pageShell(
    "Parts",
    `<article><h1>Parts to watch</h1><table><tr><th>Part</th><th>Task</th></tr>
     <tr><td>Gudgeon</td><td>Draw and set it true</td></tr>
     <tr><td>Sluice</td><td>Clear it before the spring tide</td></tr></table>
     <p>The table is the whole of the keeper's morning list.</p></article>`,
  ),
);
pages.set(
  "editable.html",
  pageShell(
    "Notes",
    `<article contenteditable="true"><h1>Keeper notes</h1>
     <p>The editable mill note says the xylophone-edit peg was loose at dawn and was driven home before the pond filled.</p></article>`,
  ),
);
pages.set(
  "code.html",
  pageShell(
    "Code",
    `<article><p>The setting that matters in prose is autoCommit, which belongs in the sentence.</p>
     <pre><code>function UNIQUECODETOKEN(){ return 1; }</code></pre>
     <p>After the snippet the keeper goes back to the sluice.</p></article>`,
  ),
);
pages.set(
  "iframe.html",
  pageShell("Frame", `<article><p>Only the outside caption is in this document.</p></article><iframe src="/frame-body.html" style="width:800px;height:400px;border:0"></iframe>`),
);
pages.set(
  "frame-body.html",
  pageShell("Inside", `<article><p>The framed article says the inner sluice token belongs to the embedded document and not the caption.</p></article>`),
);
const huge = Array.from({ length: 40 }, (_, index) => `<p>Paragraph ${index + 1}. The wheel turns, the pond empties, and the keeper writes one more line in the ledger about grease, pegs, and the state of the brake.</p>`).join("");
pages.set("huge.html", pageShell("Long mill", `<article><h1>A long ledger</h1>${huge}</article>`));
for (const [name, body] of huntPages) pages.set(name, body);
for (const [name, body] of nightPages) pages.set(name, body);

function mockRequest(path, { method = "GET", body } = {}) {
  return new Promise((resolve_, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: MOCK_PORT,
        path,
        method,
        rejectUnauthorized: false,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve_(text ? JSON.parse(text) : {});
          } catch {
            resolve_({ raw: text });
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

class Session {
  constructor(socketUrl) {
    this.socketUrl = socketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.contexts = [];
  }

  on(method, handler) {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  async open() {
    this.socket = new WebSocket(this.socketUrl);
    await new Promise((resolve_, reject) => {
      this.socket.onopen = resolve_;
      this.socket.onerror = () => reject(new Error(`cannot connect to ${this.socketUrl}`));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.executionContextCreated") this.contexts.push(message.params.context);
      const handlers = this.listeners.get(message.method) ?? [];
      for (const handler of handlers) handler(message.params, message);
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    };
    return this;
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve_, reject) => {
      this.pending.set(id, { resolve: resolve_, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
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

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

const children = [];
function track(child) {
  children.push(child);
  return child;
}
function killAll() {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
process.on("exit", killAll);

function cert() {
  const dir = resolve(tmpdir(), "ra-fuzz-cert");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const key = resolve(dir, "key.pem");
  const crt = resolve(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", crt,
    "-days", "2", "-nodes", "-subj", "/CN=api.x.ai",
    "-addext", "subjectAltName=DNS:api.x.ai,DNS:auth.x.ai,DNS:accounts.x.ai,DNS:docs.google.com",
  ]);
  const spki = execFileSync("bash", ["-lc", `openssl x509 -in "${crt}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64`], { encoding: "utf8" }).trim();
  return { key, crt, spki };
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error(`${label} never became ready${last ? `: ${last}` : ""}`);
}

const AUDIO_PATCH = `
  (() => {
    if (globalThis.__audios) return;
    const Real = window.Audio;
    globalThis.__audios = [];
    globalThis.__rates = [];
    const describe = (object, name) => {
      for (let current = object; current; current = Object.getPrototypeOf(current)) {
        const found = Object.getOwnPropertyDescriptor(current, name);
        if (found) return found;
      }
      return null;
    };
    window.Audio = function PatchedAudio(...args) {
      const element = new Real(...args);
      globalThis.__audios.push(element);
      const desc = describe(Object.getPrototypeOf(element), "playbackRate");
      if (desc?.get && desc?.set) {
        Object.defineProperty(element, "playbackRate", {
          configurable: true,
          enumerable: true,
          get: () => desc.get.call(element),
          set(value) {
            globalThis.__rates.push(Number(value));
            desc.set.call(element, value);
          },
        });
      }
      return element;
    };
  })()
`;

const PROBE = `
  (() => {
    const highlight = CSS.highlights?.get?.("read-aloud-word");
    let word = null;
    if (highlight) for (const range of highlight) { word = range.toString(); break; }
    const snap = globalThis.__readAloud?.reader?.snapshot?.() ?? {};
    const audio = globalThis.__audios?.at(-1) ?? null;
    return {
      word,
      status: snap.status ?? null,
      error: snap.error ?? "",
      notice: snap.notice ?? "",
      chunkIndex: snap.chunkIndex ?? null,
      chunkCount: snap.chunkCount ?? null,
      voiceId: snap.voiceId ?? null,
      rate: snap.rate ?? null,
      time: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      paused: audio ? audio.paused : null,
      rates: globalThis.__rates ? globalThis.__rates.slice() : [],
      playback: globalThis.__readAloud?.reader?.playback?.() ?? null,
    };
  })()
`;

let stopServing = () => {};

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  const { key, crt, spki } = cert();
  const buildDir = resolve(tmpdir(), "ra-fuzz-build");
  rmSync(buildDir, { recursive: true, force: true });
  execFileSync("node", ["tools/build.js", "--only", "chrome-test", "--out", buildDir], { cwd: ROOT, stdio: "inherit" });

  const pageServer = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname.slice(1) || "article.html");
    const body = pages.get(name);
    if (!body) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const type = name.endsWith(".pdf") ? "application/pdf" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise((resolve_) => pageServer.listen(PAGE_PORT, "127.0.0.1", resolve_));
  stopServing = () => pageServer.close();

  const mock = track(spawn("node", ["tools/mock-api.js", "--port", String(MOCK_PORT), "--cert", crt, "--key", key], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }));
  mock.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitFor("mock", async () => {
    const body = await mockRequest("/debug/requests");
    return Array.isArray(body.requests);
  });

  const profile = resolve(tmpdir(), "ra-fuzz-profile");
  rmSync(profile, { recursive: true, force: true });
  const chrome = track(spawn("google-chrome", [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--window-size=1100,800",
    "--enable-unsafe-extension-debugging",
    "--autoplay-policy=no-user-gesture-required",
    `--host-resolver-rules=MAP api.x.ai 127.0.0.1:${MOCK_PORT},MAP auth.x.ai 127.0.0.1:${MOCK_PORT},MAP accounts.x.ai 127.0.0.1:${MOCK_PORT},MAP docs.google.com 127.0.0.1:${MOCK_PORT}`,
    `--ignore-certificate-errors-spki-list=${spki}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${PAGE_PORT}/article.html`,
  ], { stdio: "ignore" }));

  const version = await waitFor("chrome", async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json());
  const browser = await new Session(version.webSocketDebuggerUrl).open();
  const extensionId = (await browser.send("Extensions.loadUnpacked", { path: resolve(buildDir, "chrome-test") })).id;
  console.log(`extension ${extensionId}`);

  const logs = [];
  const noteLog = (source, params) => {
    const text = params?.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ")
      || params?.entry?.text
      || params?.exceptionDetails?.text
      || "";
    if (text) logs.push({ source, text: String(text).slice(0, 500) });
  };

  async function attachConsole(session, source) {
    await session.send("Runtime.enable").catch(() => {});
    await session.send("Log.enable").catch(() => {});
    session.on("Runtime.exceptionThrown", (params) => noteLog(source, params));
    session.on("Runtime.consoleAPICalled", (params) => noteLog(source, params));
    session.on("Log.entryAdded", (params) => noteLog(source, params));
  }

  await browser.send("Target.setDiscoverTargets", { discover: true });
  const workerSessions = [];
  browser.on("Target.targetCreated", async (params) => {
    const info = params.targetInfo;
    if (info.type !== "service_worker" || !info.url.includes(extensionId)) return;
    const session = await new Session(info.webSocketDebuggerUrl ?? `ws://127.0.0.1:${CDP_PORT}/devtools/page/${info.targetId}`).open().catch(() => null);
    if (!session) return;
    workerSessions.push(session);
    await attachConsole(session, "worker");
  });

  async function findTarget(predicate, label) {
    return waitFor(label, async () => {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      return list.find(predicate) ?? null;
    });
  }

  const articleInfo = await findTarget((target) => target.url.startsWith(`http://127.0.0.1:${PAGE_PORT}`), "article tab");
  const article = await new Session(articleInfo.webSocketDebuggerUrl).open();
  await article.send("Page.enable");
  await article.send("Runtime.enable");
  await attachConsole(article, "page");
  const articleId = articleInfo.id;

  await browser.send("Target.createTarget", { url: `chrome-extension://${extensionId}/options/options.html`, background: true });
  const optionsInfo = await findTarget((target) => target.url.includes("/options/options.html"), "options");
  const ui = await new Session(optionsInfo.webSocketDebuggerUrl).open();
  await ui.send("Runtime.enable");
  await attachConsole(ui, "options");
  await waitFor("options APIs", () => ui.evaluate(`typeof chrome?.storage?.local === "object" && document.readyState === "complete"`));

  let world = null;
  async function isolatedWorld() {
    const deadline = Date.now() + 15000;
    const pageHref = () => article.evaluate(`location.href`);
    while (Date.now() < deadline) {
      const current = await pageHref().catch(() => "");
      const found = [];
      for (const context of article.contexts) {
        if (context.auxData?.type !== "isolated") continue;
        try {
          const live = await article.evaluate(
            `typeof globalThis.__readAloud?.reader?.snapshot === "function" && location.href`,
            context.id,
          );
          if (typeof live === "string") found.push({ id: context.id, href: live });
        } catch {
          // Detached world.
        }
      }
      const match = found.filter((entry) => entry.href === current).at(-1);
      if (match) return match.id;
      await sleep(200);
    }
    throw new Error("content script never appeared");
  }

  async function activate() {
    await browser.send("Target.activateTarget", { targetId: articleId });
  }

  async function command(payload) {
    await activate();
    return ui.evaluate(`new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(payload)}, resolve))`);
  }

  async function control(action, actionArgs = {}) {
    return command({ type: "control", action, args: actionArgs });
  }

  async function navigate(name) {
    article.contexts.length = 0;
    const url = String(name).startsWith("http") ? String(name) : `http://127.0.0.1:${PAGE_PORT}/${name}`;
    await article.send("Page.navigate", { url });
    await waitFor(name, () => article.evaluate(`document.readyState === "complete"`));
    await activate();
    await command({ type: "getTabState" });
    world = await isolatedWorld();
    await article.evaluate(AUDIO_PATCH, world);
  }

  async function probe() {
    return article.evaluate(PROBE, world);
  }

  async function requests() {
    return (await mockRequest("/debug/requests")).requests ?? [];
  }

  async function resetMock() {
    await mockRequest("/debug/reset", { method: "POST", body: {} });
  }

  async function setTiming(timing) {
    await mockRequest("/debug/timing", { method: "POST", body: timing });
  }

  async function setFault(mode, remaining) {
    await mockRequest("/debug/fault", { method: "POST", body: { mode, remaining } });
  }

  async function applySettings(extra = {}) {
    const values = {
      apiKey: KEY,
      voiceId: "eve",
      language: "en",
      rate: 1,
      chunkChars: 600,
      autoScroll: false,
      clickToJump: true,
      readCodeBlocks: false,
      ...extra,
    };
    await ui.evaluate(`chrome.storage.local.set(${JSON.stringify(values)})`);
    await sleep(100);
  }

  async function screenshot(name) {
    return capture(article, name);
  }

  async function capture(session, name) {
    await session.send("Page.enable").catch(() => {});
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    const path = resolve(ARTIFACTS, name);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  }

  function leaked() {
    return logs.filter((entry) => entry.text.includes(KEY)).map((entry) => entry.source);
  }

  async function until(predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await probe();
      if (predicate(last)) return last;
      await sleep(150);
    }
    return last;
  }

  const evidence = [];
  function save(name, value) {
    const path = resolve(ARTIFACTS, name);
    writeFileSync(path, JSON.stringify(value, null, 2));
    evidence.push(path);
    return path;
  }

  const results = [];

  async function runScenario(scenario, repeat) {
    const from = logs.length;
    await resetMock();
    await setTiming({ base: 0, perChar: 0, timestamps: 0 });
    await setFault("", 0);
    let outcome;
    try {
      outcome = await scenario.run(repeat);
    } catch (error) {
      outcome = { ok: false, detail: error.stack || error.message };
    }
    const freshLogs = logs.slice(from);
    const leak = freshLogs.filter((entry) => entry.text.includes(KEY));
    const exploded = freshLogs.filter((entry) => /TypeError|ReferenceError|is not defined|Cannot read properties/.test(entry.text) && !entry.text.includes("favicon"));
    if (leak.length && !scenario.bug) {
      outcome = { ok: false, detail: `credential surfaced in ${leak.map((entry) => entry.source).join(", ")}` };
    }
    if (exploded.length && outcome.ok !== false && !scenario.allowErrors) {
      outcome = { ok: false, detail: `uncaught: ${exploded.map((entry) => entry.text).slice(0, 3).join(" | ")}` };
    }
    const row = {
      scenario: scenario.name,
      repeat,
      bug: scenario.bug || "",
      ok: Boolean(outcome.ok),
      detail: outcome.detail || "",
      evidence: outcome.evidence || "",
    };
    results.push(row);
    const label = row.bug ? (row.ok ? "REPRO" : "MISSED") : row.ok ? "PASS" : "FAIL";
    console.log(`${label}  ${row.scenario}#${repeat}${row.bug ? " — " + row.bug : ""} — ${row.detail}`);
    return row;
  }

  const scenarios = [
    {
      name: "emoji-highlight",
      async run() {
        await applySettings({ chunkChars: 500 });
        await navigate("emoji.html");
        const started = await control("start", { scope: "page", from: "start" });
        if (!started?.state) return { ok: false, detail: `start failed ${JSON.stringify(started)}` };
        const samples = [];
        for (let i = 0; i < 8; i += 1) {
          await sleep(200);
          samples.push(await probe());
        }
        const early = samples.filter((sample) => sample.status === "playing" && sample.time > 0.1 && sample.time < 1.2);
        const words = [];
        for (const sample of early) {
          if (sample.word && words.at(-1) !== sample.word) words.push(sample.word);
        }
        const stuck = early.some((sample) => /saltbox/i.test(sample.word || ""));
        let lead = null;
        for (let i = 0; i < 90 && !lead; i += 1) {
          const sample = await probe();
          if (sample.chunkIndex >= 1 && sample.status === "playing" && sample.playback?.lead > 0) lead = sample;
          else await sleep(200);
        }
        const expected = await article.evaluate(`
          (() => {
            const doc = globalThis.__readAloud.extract.extract("page");
            const ranges = globalThis.__readAloud.align.chunkRanges(doc.text, 500, { firstChars: 240 });
            const context = ranges.length > 1 ? globalThis.__readAloud.align.leadingContext(doc.text, ranges[1].start) : "";
            const points = [...context].length;
            return { chunks: ranges.length, contextPoints: points, expectedLead: Number((points * 0.055).toFixed(4)) };
          })()
        `, world);
        const leadOk =
          Boolean(lead) &&
          expected.chunks > 1 &&
          expected.contextPoints >= 8 &&
          Math.abs(lead.playback.lead - expected.expectedLead) < 0.02;
        const ok = words.length >= 2 && !stuck && leadOk;
        const path = save("emoji-highlight.json", {
          words,
          stuck,
          lead: lead?.playback?.lead ?? null,
          expected,
        });
        return {
          ok,
          detail: ok
            ? `walked ${words.join(" | ")}; next chunk lead ${lead.playback.lead.toFixed(3)}s`
            : `words ${words.join(" | ") || "none"}; saltbox early ${stuck}; lead ${lead?.playback?.lead ?? "none"} expected ${expected.expectedLead}`,
          evidence: path,
        };
      },
    },
    {
      name: "voice-during-load",
      async run() {
        await setTiming({ base: 1600, perChar: 0, timestamps: 0 });
        await applySettings({ voiceId: "eve", chunkChars: 2000 });
        await navigate("article.html");
        const started = await control("start", { scope: "page", from: "start" });
        if (started?.state?.status !== "loading") {
          return { ok: false, detail: `wanted the loading window, got ${started?.state?.status}` };
        }
        await ui.evaluate(`chrome.storage.local.set({ voiceId: "ara" })`);
        await control("settingsChanged");
        const seen = await until((sample) => sample.status === "playing" && sample.time > 0, 8000);
        const asked = await requests();
        const path = save("bug-voice-stuck-loading.json", { seen, voices: asked.map((entry) => entry.voiceId) });
        const played = seen.status === "playing" && seen.time > 0 && asked[0]?.voiceId === "eve";
        return {
          ok: played,
          detail: played
            ? `played the in-flight ${asked[0].voiceId} chunk after the voice became ${seen.voiceId}`
            : `status ${seen.status} time ${seen.time} error ${seen.error} voices ${asked.map((entry) => entry.voiceId).join(",") || "none"}`,
          evidence: path,
        };
      },
    },
    {
      name: "pause-during-load",
      async run() {
        await setTiming({ base: 1600, perChar: 0, timestamps: 0 });
        await applySettings({ chunkChars: 2000 });
        await navigate("article.html");
        const started = await control("start", { scope: "page", from: "start" });
        if (started?.state?.status !== "loading") {
          return { ok: false, detail: `wanted the loading window, got ${started?.state?.status}` };
        }
        const paused = await control("pause");
        await sleep(2200);
        const seen = await probe();
        const path = save("bug-pause-during-load.json", { pauseReply: paused?.state?.status, seen });
        const held = seen.status === "paused" && seen.paused !== false && seen.time < 0.3;
        return {
          ok: held,
          detail: held
            ? `stayed paused at ${seen.time.toFixed(2)}s after the chunk arrived`
            : `status ${seen.status} time ${seen.time} paused ${seen.paused}`,
          evidence: path,
        };
      },
    },
    {
      name: "shadow-article",
      async run() {
        await applySettings();
        await navigate("shadow.html");
        await control("start", { scope: "page", from: "start" });
        const seen = await until((sample) => (sample.status === "playing" && sample.word) || sample.status === "error", 8000);
        const asked = await requests();
        const spoken = asked.map((entry) => entry.text).join("\n");
        const mapped = await article.evaluate(`
          (() => {
            const doc = globalThis.__readAloud.extract.extract("page");
            const at = doc?.text?.indexOf("elm") ?? -1;
            const range = at < 0 ? null : globalThis.__readAloud.extract.rangeFor(doc, at, at + 3);
            const paragraph = document.querySelector("article")?.shadowRoot?.querySelector("p");
            const rect = paragraph?.getClientRects?.()[0];
            const hit = rect
              ? globalThis.__readAloud.extract.charIndexFromPoint(doc, rect.left + 12, rect.top + rect.height / 2)
              : -1;
            return {
              highlighted: range ? range.toString() : "",
              inShadow: range ? range.startContainer.getRootNode() instanceof ShadowRoot : false,
              hit: hit >= 0,
            };
          })()
        `, world);
        const path = save("bug-shadow-root.json", {
          status: seen.status,
          error: seen.error,
          word: seen.word,
          spokenIncludesMarker: spoken.includes("elm bucket"),
          mapped,
        });
        const read =
          spoken.includes("elm bucket") &&
          seen.status === "playing" &&
          Boolean(seen.word) &&
          mapped.highlighted === "elm" &&
          mapped.inShadow &&
          mapped.hit;
        if (read) await screenshot("shadow-article-reading.png");
        return {
          ok: read,
          detail: read
            ? `shadow article spoken and highlighted ("${seen.word}")`
            : `status ${seen.status} ${seen.error || ""} word ${seen.word || "none"} spoken ${spoken.slice(0, 80)} map ${JSON.stringify(mapped)}`,
          evidence: path,
        };
      },
    },
    {
      name: "few-emoji-still-walks",
      async run() {
        await applySettings();
        await navigate("few-emoji.html");
        await control("start", { scope: "page", from: "start" });
        const seen = await until((sample) => sample.status === "playing" && sample.time > 0.4);
        const words = [];
        for (let i = 0; i < 8; i += 1) {
          const sample = await probe();
          if (sample.word && words.at(-1) !== sample.word) words.push(sample.word);
          await sleep(250);
        }
        const ok = seen.status === "playing" && words.length >= 3 && !words.includes("ledger.");
        return { ok, detail: ok ? words.join(" ") : `status ${seen.status} words ${words.join(" ")}` };
      },
    },
    {
      name: "invariants-plain-article",
      async run(repeat) {
        const random = mulberry32(SEED + repeat * 17);
        await applySettings({ rate: 1, chunkChars: 280 });
        await navigate("article.html");
        const before = (await requests()).length;
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.word);
        if (playing.status !== "playing") return { ok: false, detail: `did not start: ${playing.status} ${playing.error}` };

        await control("setRate", { rate: 2 });
        await sleep(400);
        const sped = await probe();
        const pitchOk = sped.playback?.pitchPreserving === true
          && sped.playback?.rate === 2
          && Math.abs((sped.playback?.stretchedRate ?? 0) - 2) < 0.05
          && sped.rates.every((rate) => rate === 1);
        if (!pitchOk) return { ok: false, detail: `pitch moved ${JSON.stringify(sped.playback)} rates ${sped.rates}` };

        await control("pause");
        const held = await probe();
        const atPause = held.time;
        await sleep(350);
        const still = await probe();
        if (still.status !== "paused" || Math.abs(still.time - atPause) > 0.08) {
          return { ok: false, detail: `pause did not hold (${still.status} ${atPause} -> ${still.time})` };
        }

        await control("resume");
        const again = await until((sample) => sample.status === "playing" && sample.time > atPause + 0.05);
        if (again.status !== "playing") return { ok: false, detail: `resume stayed ${again.status}` };

        const action = random() < 0.5 ? "skip back" : "skip forward";
        await control("skipSentence", { delta: action === "skip back" ? -1 : 1 });
        await sleep(400);
        const skipped = await probe();
        if (skipped.status === "error") return { ok: false, detail: `skip errored ${skipped.error}` };

        await control("stop");
        await sleep(200);
        const stopped = await probe();
        const timeAtStop = stopped.time;
        await sleep(400);
        const later = await probe();
        const silent = stopped.status === "idle" && (later.paused !== false) && Math.abs(later.time - timeAtStop) < 0.05;
        if (!silent) return { ok: false, detail: `audio after stop (${later.status} paused ${later.paused} ${timeAtStop}->${later.time})` };

        const burst = await Promise.all([
          control("start", { scope: "page", from: "start" }),
          control("start", { scope: "page", from: "start" }),
          control("start", { scope: "page", from: "start" }),
        ]);
        await sleep(700);
        const afterBurst = await probe();
        const made = (await requests()).length - before;
        if (afterBurst.status === "error") return { ok: false, detail: `rapid start errored ${afterBurst.error}` };
        if (made > 8) return { ok: false, detail: `rapid start issued ${made} requests` };
        if (leaked().length) return { ok: false, detail: "credential surfaced" };
        return {
          ok: true,
          detail: `${action}, pitch held, stop silenced, rapid start -> ${afterBurst.status}, ${made} requests, burst ${burst.length}`,
        };
      },
    },
    {
      name: "click-cue-only-while-active",
      async run() {
        await applySettings({ clickToJump: true, autoScroll: false });
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing" && sample.word);
        const point = await article.evaluate(`
          (() => {
            const paragraph = document.querySelector("article p");
            const rect = paragraph.getClientRects()[0];
            return { x: rect.left + 24, y: rect.top + rect.height / 2 };
          })()
        `);
        const cue = async () => {
          await article.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, buttons: 0 });
          await sleep(200);
          return article.evaluate(`
            (() => {
              const under = document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)});
              return {
                marked: document.querySelectorAll("[data-read-aloud-jump]").length,
                cursor: under ? getComputedStyle(under).cursor : null,
              };
            })()
          `);
        };
        const playing = await cue();
        await control("pause");
        const paused = await cue();
        await control("stop");
        const stopped = await cue();
        const ok = playing.cursor === "pointer" && playing.marked > 0
          && paused.cursor !== "pointer" && paused.marked === 0
          && stopped.cursor !== "pointer" && stopped.marked === 0;
        return {
          ok,
          detail: `playing ${playing.cursor}/${playing.marked}, paused ${paused.cursor}/${paused.marked}, stopped ${stopped.cursor}/${stopped.marked}`,
        };
      },
    },
    {
      name: "stop-then-click-does-not-start",
      async run() {
        await applySettings();
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing");
        await control("stop");
        const point = await article.evaluate(`
          (() => {
            const rect = document.querySelector("article p").getClientRects()[0];
            return { x: rect.left + 30, y: rect.top + 8 };
          })()
        `);
        const before = (await requests()).length;
        await article.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
        await article.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        await sleep(500);
        const seen = await probe();
        const made = (await requests()).length - before;
        const ok = seen.status === "idle" && made === 0;
        return { ok, detail: ok ? "click after stop stayed idle" : `status ${seen.status}, ${made} new requests` };
      },
    },
    {
      name: "pages-and-failures",
      allowErrors: false,
      async run() {
        const notes = [];
        await applySettings();

        await navigate("empty.html");
        await control("start", { scope: "page", from: "start" });
        const empty = await until((sample) => sample.status === "error" || sample.status === "playing", 4000);
        if (empty.status !== "error") return { ok: false, detail: `empty page status ${empty.status}` };
        notes.push("empty page errors");

        await navigate("rtl.html");
        await control("start", { scope: "page", from: "start" });
        const rtl = await until((sample) => sample.status === "playing" && sample.word, 5000);
        const rtlText = (await requests()).map((entry) => entry.text).join(" ");
        if (rtl.status !== "playing" || !rtlText.includes("الطاحونة") && !rtlText.includes("تعمل")) {
          return { ok: false, detail: `rtl status ${rtl.status} word ${rtl.word} text ${rtlText.slice(0, 60)}` };
        }
        notes.push("rtl plays");

        await resetMock();
        await navigate("table.html");
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing");
        const tableText = (await requests()).map((entry) => entry.text).join("\n");
        const once = (word) => tableText.split(word).length - 1 === 1;
        if (!tableText.includes("Gudgeon") || !tableText.includes("Sluice") || !once("Gudgeon")) {
          return { ok: false, detail: `table text ${tableText.slice(0, 160)}` };
        }
        notes.push("table once");

        await resetMock();
        await navigate("editable.html");
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing" || sample.status === "error");
        const editable = (await requests()).map((entry) => entry.text).join(" ");
        if (!editable.includes("xylophone-edit")) return { ok: false, detail: "contenteditable text was not read" };
        notes.push("editable read");

        await resetMock();
        await navigate("code.html");
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing");
        const codeText = (await requests()).map((entry) => entry.text).join(" ");
        if (codeText.includes("UNIQUECODETOKEN") || !codeText.includes("autoCommit")) {
          return { ok: false, detail: `code handling ${codeText.slice(0, 120)}` };
        }
        notes.push("code skipped");

        await resetMock();
        await navigate("huge.html");
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing");
        await sleep(800);
        const hugeCount = (await requests()).length;
        if (hugeCount > 6) return { ok: false, detail: `huge page issued ${hugeCount} requests immediately` };
        notes.push(`huge ${hugeCount} requests`);

        await resetMock();
        // Two chunks are fetched together, and each is retried, so a short
        // fault budget is exhausted by the retries and the last attempt
        // succeeds. Cover every attempt.
        await setFault("not-json", 8);
        await navigate("article.html?case=not-json");
        await control("start", { scope: "page", from: "start" });
        const broken = await until((sample) => sample.status === "error", 15000);
        if (broken.status !== "error") {
          return { ok: false, detail: `malformed JSON stayed ${broken.status} ${broken.error}` };
        }
        if (broken.error.includes(KEY)) return { ok: false, detail: "error text included the credential" };
        notes.push("malformed JSON surfaces as an error");

        await ui.evaluate(`chrome.storage.local.set({ apiKey: "" })`);
        await navigate("article.html");
        const missing = await control("start", { scope: "page", from: "start" });
        if (missing?.state?.status !== "error") return { ok: false, detail: `missing key status ${missing?.state?.status}` };
        if ((missing.state.error || "").includes(KEY)) return { ok: false, detail: "missing-key error included the credential" };
        notes.push("missing key errors");

        return { ok: true, detail: notes.join("; ") };
      },
    },
    {
      name: "spa-replace-while-playing",
      bug: "Replacing the article mid-read keeps speaking the text that was removed",
      async run() {
        await applySettings({ chunkChars: 2000 });
        await navigate("spa.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.word);
        await article.evaluate(`
          document.querySelector("#story").innerHTML = "<h1>Second route</h1><p>The replacement route is about the brake and the spring tide, and it never mentions the sluice by that old name.</p>";
        `);
        await sleep(1000);
        const after = await probe();
        const visible = await article.evaluate(`document.querySelector("#story").innerText`);
        const highlightAgrees = !after.word || visible.includes(after.word);
        const path = save("bug-spa-stale-read.json", { before: playing, after, visible, highlightAgrees });
        const stale = after.status === "playing" && after.word && !highlightAgrees;
        return {
          ok: stale,
          detail: stale
            ? `still playing "${after.word}" after the article was replaced`
            : `status ${after.status}, highlight ${JSON.stringify(after.word)}, agrees ${highlightAgrees}`,
          evidence: path,
        };
      },
    },
    {
      name: "popup-matches-reader",
      async run() {
        await applySettings();
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing");
        const created = await browser.send("Target.createTarget", {
          url: `chrome-extension://${extensionId}/popup/popup.html`,
          background: true,
        });
        const popupInfo = await findTarget((target) => target.url.includes("/popup/popup.html"), "popup");
        const popup = await new Session(popupInfo.webSocketDebuggerUrl).open();
        await popup.send("Runtime.enable");
        await attachConsole(popup, "popup");
        const first = await waitFor("popup status", () => popup.evaluate(`document.getElementById("status")?.textContent || ""`));
        await sleep(500);
        const shown = await popup.evaluate(`({
          status: document.getElementById("status")?.textContent || "",
          state: document.getElementById("status")?.dataset.state || "",
          disabled: document.getElementById("toggle")?.disabled ?? null
        })`);
        const seen = await probe();
        await browser.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
        popup.close();
        const still = await probe();
        const agrees = shown.state === seen.status;
        const stayed = still.status === "playing";
        return {
          ok: agrees && stayed && first.length > 0,
          detail: `first "${first}", popup ${shown.state}/${shown.status}, reader ${seen.status}, after close ${still.status}`,
        };
      },
    },
    ...huntScenarios({
      SEED,
      KEY,
      PAGE_PORT,
      applySettings,
      navigate,
      control,
      command,
      probe,
      until,
      sleep,
      setTiming,
      setFault,
      resetMock,
      requests,
      article,
      save,
      screenshot,
      capture,
      ui,
      activate,
      browser,
      findTarget,
      Session,
      attachConsole,
      extensionId: () => extensionId,
      mulberry32,
      evaluate: (expression) => article.evaluate(expression, world),
      recentLogs: () => logs.slice(),
      refreshWorld: async () => {
        await waitFor("reload", () => article.evaluate(`document.readyState === "complete"`));
        await activate();
        const state = await command({ type: "getTabState" });
        if (!state?.ok) throw new Error(`reload did not reinject: ${JSON.stringify(state)}`);
        // A navigation can deliver the new isolated world before this session
        // is listening for it again. Asking twice makes Chrome replay it.
        article.contexts.length = 0;
        await article.send("Runtime.disable").catch(() => {});
        await article.send("Runtime.enable");
        world = await isolatedWorld();
        await article.evaluate(AUDIO_PATCH, world);
      },
    }),
    ...nightScenarios({
      SEED,
      applySettings,
      navigate,
      control,
      probe,
      until,
      sleep,
      setTiming,
      setFault,
      resetMock,
      requests,
      article,
      save,
      screenshot,
      ui,
      activate,
      evaluate: (expression) => article.evaluate(expression, world),
      mulberry32,
      recentLogs: () => logs.slice(),
      refreshWorld: async () => {
        await waitFor("reload", () => article.evaluate(`document.readyState === "complete"`));
        await activate();
        const state = await command({ type: "getTabState" });
        if (!state?.ok) throw new Error(`reload did not reinject: ${JSON.stringify(state)}`);
        article.contexts.length = 0;
        await article.send("Runtime.disable").catch(() => {});
        await article.send("Runtime.enable");
        world = await isolatedWorld();
        await article.evaluate(AUDIO_PATCH, world);
      },
    }),
  ];

  try {
    for (const scenario of scenarios) {
      if (ONLY.size && !ONLY.has(scenario.name)) continue;
      const repeats = scenario.bug ? REPEATS : 1;
      for (let repeat = 1; repeat <= repeats; repeat += 1) await runScenario(scenario, repeat);
    }
  } finally {
    pageServer.close();
    for (const session of workerSessions) session.close();
    ui.close();
    article.close();
    browser.close();
    chrome.kill("SIGKILL");
    mock.kill("SIGKILL");
  }

  const reportPath = save("fuzz-report.json", { seed: SEED, results, evidence });
  const unexpected = results.filter((row) => !row.bug && !row.ok);
  const missing = results.filter((row) => row.bug && !row.ok);
  console.log(`\nreport ${reportPath}`);
  console.log(`${results.filter((row) => row.ok).length}/${results.length} rows passed`);
  if (unexpected.length) {
    console.log(`unexpected failures: ${unexpected.map((row) => row.scenario).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (missing.length) {
    console.log(`expected bugs did not reproduce: ${missing.map((row) => row.scenario).join(", ")}`);
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  stopServing();
  killAll();
  process.exit(1);
});
