import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import vm from "node:vm";
import { bundle, inlineStylesheets } from "../tools/bundle.js";

const root = mkdtempSync(join(tmpdir(), "read-aloud-bundle-"));
after(() => rmSync(root, { recursive: true, force: true }));

function tree(files) {
  const dir = mkdtempSync(join(root, "t-"));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

/** Runs a bundle as a classic script with a shared log, and returns the log. */
async function run(source) {
  const context = vm.createContext({ log: [], Promise, setTimeout });
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return context.log;
}

test("static imports run first, dynamic ones only when called, each once", async () => {
  const dir = tree({
    "a/entry.js": [
      `import { one, two as second } from "../lib/static.js";`,
      `import * as ns from "../lib/static.js";`,
      `log.push("entry " + one + " " + second + " " + ns.one);`,
      `const later = () => import("../lib/lazy.js");`,
      `log.push("painted");`,
      `later().then((m) => { log.push("lazy " + m.value()); return later(); }).then((m) => log.push("again " + m.value()));`,
    ].join("\n"),
    "lib/static.js": `log.push("static runs");\nexport const one = 1;\nconst two = 2;\nexport { two };\n`,
    "lib/lazy.js": `import { one } from "./static.js";\nlog.push("lazy runs");\nexport function value() { return one + 41; }\n`,
  });
  const source = bundle(join(dir, "a/entry.js"), { root: dir });
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.deepEqual(await run(source), [
    "static runs",
    "entry 1 2 1",
    "painted",
    "lazy runs",
    "lazy 42",
    "again 42",
  ]);
});

test("exports are live, as module bindings are", async () => {
  const dir = tree({
    "entry.js": `import { count, bump } from "./counter.js";\nimport * as c from "./counter.js";\nbump();\nlog.push(c.count);\n`,
    "counter.js": `export let count = 0;\nexport function bump() { count += 1; }\n`,
  });
  assert.deepEqual(await run(bundle(join(dir, "entry.js"), { root: dir })), [1]);
});

test("what it cannot bundle faithfully is refused at build time", () => {
  const cases = {
    "default export": `export default 1;`,
    "computed import()": `const name = "./x.js"; import(name);`,
    "bare import": `import { x } from "lodash";`,
    "import.meta": `log.push(import.meta.url);`,
  };
  for (const [what, source] of Object.entries(cases)) {
    const dir = tree({ "entry.js": source });
    assert.throws(() => bundle(join(dir, "entry.js"), { root: dir }), Error, what);
  }
  const dir = tree({ "a.js": `import "./b.js";`, "b.js": `import "./a.js";` });
  assert.throws(() => bundle(join(dir, "a.js"), { root: dir }), /cycle/);
});

test("a linked stylesheet is inlined in place, and a remote one refused", () => {
  const dir = tree({ "p.css": "body { color: red; }\n" });
  const html = `<head>\n    <link rel="stylesheet" href="p.css" />\n</head>`;
  assert.equal(inlineStylesheets(html, dir), `<head>\n    <style>\nbody { color: red; }\n    </style>\n</head>`);
  assert.throws(() => inlineStylesheets(`<link rel="stylesheet" href="https://x.test/a.css">`, dir));
});
