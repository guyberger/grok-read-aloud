/**
 * Minimal headless-Chrome driver for the extraction tests.
 *
 * Extraction is almost entirely a question of what the engine says is
 * rendered — `getComputedStyle`, `display: contents`, TreeWalker filters — so
 * testing it against a hand-written DOM stub would only test the stub. These
 * tests drive a real browser instead, and skip themselves where there is none.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = resolve(HERE, "../src/content");

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findChrome() {
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

/** The content scripts, concatenated the way the browser injects them. */
export function contentBundle(files = ["util.js", "extract.js"]) {
  return files.map((file) => readFileSync(resolve(CONTENT_DIR, file), "utf8")).join("\n;\n");
}

class Connection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve_, reject) => {
      this.socket.onopen = resolve_;
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
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve_, reject) => {
      this.pending.set(id, { resolve: resolve_, reject });
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 30000);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

export class Browser {
  constructor(process_, port, connection) {
    this.process = process_;
    this.port = port;
    this.connection = connection;
  }

  /** `args` adds switches a particular test needs, such as an autoplay policy. */
  static async launch({ port = 9470 + Math.floor(Math.random() * 90), args = [] } = {}) {
    const binary = findChrome();
    if (!binary) throw new Error("no Chrome binary found");
    const process_ = spawn(
      binary,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        ...args,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=/tmp/read-aloud-test-${port}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    let version = null;
    for (let i = 0; i < 120 && !version; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      } catch {
        await sleep(250);
      }
    }
    if (!version) {
      process_.kill();
      throw new Error("Chrome never accepted a debugging connection");
    }
    return new Browser(process_, port, await new Connection(version.webSocketDebuggerUrl).open());
  }

  /** Opens `url` with `preamble` already evaluated, and returns an evaluator. */
  async open(url, preamble) {
    const { targetId } = await this.connection.send("Target.createTarget", { url: "about:blank" });
    let target = null;
    for (let i = 0; i < 40 && !target; i += 1) {
      const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
      target = list.find((entry) => entry.id === targetId);
      if (!target) await sleep(100);
    }
    const page = await new Connection(target.webSocketDebuggerUrl).open();
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    if (preamble) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: preamble });

    const loaded = new Promise((resolve_) => {
      const timer = setTimeout(resolve_, 15000);
      const original = page.socket.onmessage;
      page.socket.onmessage = (event) => {
        original(event);
        if (JSON.parse(event.data).method === "Page.loadEventFired") {
          clearTimeout(timer);
          resolve_();
        }
      };
    });
    await page.send("Page.navigate", { url });
    await loaded;

    return {
      async evaluate(expression) {
        const result = await page.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
        }
        return result.result.value;
      },
      close: async () => {
        page.close();
        await this.connection.send("Target.closeTarget", { targetId }).catch(() => {});
      },
    };
  }

  close() {
    this.connection.close();
    this.process.kill();
  }
}

export const fixtureUrl = (name) => `file://${resolve(HERE, "fixtures", name)}`;
