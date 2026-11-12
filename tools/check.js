/**
 * Static sanity pass: every script parses, both manifests are valid JSON and
 * point at files that exist, no API key ever slipped into the tree, and the
 * dev-only auto-reload is nowhere near a production build.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  DEV_PERMISSIONS,
  DEV_SOURCE_DIR,
  DEV_WORKER_FILE,
  POPUP,
  TARGETS,
  build,
  isDevOnlySource,
  manifestFor,
} from "./build.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src");

const failures = [];

function walk(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    const full = resolve(directory, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else entries.push(full);
  }
  return entries;
}

const files = [...walk(SRC), ...walk(resolve(ROOT, "tools"))];

// 1. Every script parses.
const MODULE_PATHS = ["/common/", "/background/", "/popup/", "/options/", "/tools/", "/dev/"];
for (const file of files) {
  if (extname(file) !== ".js") continue;
  const source = readFileSync(file, "utf8");
  const relative = file.slice(ROOT.length);
  const isModule = MODULE_PATHS.some((part) => relative.includes(part));
  try {
    if (isModule) new vm.SourceTextModule(source, { identifier: file });
    else new vm.Script(source, { filename: file });
  } catch (error) {
    failures.push(`parse ${relative}: ${error.message}`);
  }
}

// So does every shell script.
for (const file of files) {
  if (extname(file) !== ".sh") continue;
  const parsed = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  if (parsed.error) break; // No bash here; nothing to say either way.
  if (parsed.status !== 0) failures.push(`parse ${file.slice(ROOT.length)}: ${parsed.stderr.trim()}`);
}

// 2. Manifests are valid and reference real files.
for (const name of ["manifest.chrome.json", "manifest.firefox.json"]) {
  const path = resolve(SRC, name);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    continue;
  }

  const referenced = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    manifest.background?.service_worker,
    ...(manifest.background?.scripts ?? []),
  ].filter(Boolean);

  for (const relative of referenced) {
    try {
      statSync(resolve(SRC, relative));
    } catch {
      failures.push(`${name} references missing file ${relative}`);
    }
  }

  if (manifest.manifest_version !== 3) failures.push(`${name} is not manifest v3`);
  // Two hosts and no more: the API, and the OAuth server a sign-in talks to.
  // `accounts.x.ai` is only ever opened in a tab, which needs no permission.
  for (const origin of ["https://api.x.ai/*", "https://auth.x.ai/*"]) {
    if (!manifest.host_permissions?.includes(origin)) {
      failures.push(`${name} is missing the ${new URL(origin).host} host permission`);
    }
  }
  const extra = (manifest.host_permissions ?? []).filter(
    (origin) => !["https://api.x.ai/*", "https://auth.x.ai/*"].includes(origin),
  );
  if (extra.length) failures.push(`${name} declares unexpected host permissions: ${extra.join(", ")}`);
}

// 3. The content script list in the background matches what is on disk.
const background = readFileSync(resolve(SRC, "background/background.js"), "utf8");
const listed = [...background.matchAll(/"(content\/[\w.-]+\.js)"/g)].map((match) => match[1]);
for (const relative of listed) {
  try {
    statSync(resolve(SRC, relative));
  } catch {
    failures.push(`background injects missing file ${relative}`);
  }
}
for (const file of walk(resolve(SRC, "content"))) {
  if (extname(file) !== ".js") continue;
  const relative = `content/${file.split("/").pop()}`;
  if (!listed.includes(relative)) failures.push(`${relative} is never injected`);
}

// 4. The extension defines no keyboard shortcuts. A manifest `commands` key is
// what Chrome and Firefox turn into shortcut settings, and `commands.onCommand`
// is the listener that would handle them.
for (const name of ["manifest.chrome.json", "manifest.firefox.json"]) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(SRC, name), "utf8"));
  } catch {
    continue;
  }
  if (Object.hasOwn(manifest, "commands")) failures.push(`${name} declares a commands key`);
}
for (const file of walk(SRC)) {
  if (extname(file) !== ".js") continue;
  const source = readFileSync(file, "utf8");
  if (/\bcommands\s*\.\s*onCommand\b|\b(?:chrome|browser|ext)\.commands\b/.test(source)) {
    failures.push(`${file.slice(ROOT.length)} references the commands API`);
  }
}

// 5. No credentials committed. A signed-in session is a pair of JWTs, so the
// signed-three-part shape counts as one too.
const SECRET_PATTERNS = [
  /xai-[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
];
for (const file of files) {
  if (![".js", ".json", ".md", ".html", ".css", ".sh"].includes(extname(file))) continue;
  const source = readFileSync(file, "utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(source)) failures.push(`possible credential in ${file.slice(ROOT.length)}`);
  }
}

// 6. The modules that hold credentials must not log. A token in a console line
// is a token in the devtools of whoever opens the worker, and the only reliable
// way to keep it out of there is to have nothing in these files that writes.
for (const relative of ["common/xai-auth.js", "common/credentials.js"]) {
  const source = readFileSync(resolve(SRC, relative), "utf8");
  const calls = [...source.matchAll(/\bconsole\.\w+\s*\(/g)].map((match) => match[0]);
  if (calls.length) failures.push(`${relative} logs (${calls.join(", ")}); credentials pass through it`);
}

// 7. The dev auto-reload is dev-only, and provably so.
//
// `src/dev/` holds code that reloads the extension and an `alarms` permission
// to wake a stopped worker for it. None of that may reach a normal install, so
// rather than inspect whatever happens to be in `dist/` — which is a dev build
// for anyone running `npm run dev` — this asks the build itself for both
// manifests and compares them.
const CHROME_TARGETS = TARGETS.filter((target) => target.manifest === "manifest.chrome.json");
for (const target of CHROME_TARGETS) {
  const production = manifestFor(target, { dev: false });
  const development = manifestFor(target, { dev: true, buildId: "test-build-id" });

  if (production.version_name !== undefined) {
    failures.push(`the production ${target.name} manifest names a build: ${production.version_name}`);
  }
  for (const permission of DEV_PERMISSIONS) {
    if (production.permissions?.includes(permission)) {
      failures.push(`the production ${target.name} manifest asks for the dev-only ${permission} permission`);
    }
    if (!development.permissions?.includes(permission)) {
      failures.push(`the dev ${target.name} manifest is missing the ${permission} permission`);
    }
  }
  if (production.background?.service_worker === DEV_WORKER_FILE) {
    failures.push(`the production ${target.name} manifest runs the dev worker`);
  }
  if (development.background?.service_worker !== DEV_WORKER_FILE) {
    failures.push(`the dev ${target.name} manifest does not run the dev worker`);
  }
  if (!development.version_name?.includes("test-build-id")) {
    failures.push(`the dev ${target.name} manifest does not name the build it was built from`);
  }

  // Exactly those three differences and no others, so a fourth cannot be added
  // to the dev path without this line being updated to say so.
  const expected = {
    ...production,
    background: { ...production.background, service_worker: DEV_WORKER_FILE },
    permissions: [...(production.permissions ?? []), ...DEV_PERMISSIONS],
    version_name: development.version_name,
  };
  if (JSON.stringify(development) !== JSON.stringify(expected)) {
    failures.push(
      `the dev ${target.name} manifest differs from the production one by more than ` +
        `the worker, ${DEV_PERMISSIONS.join("/")} and version_name`,
    );
  }
}

// Nothing a production build copies may reload the extension or touch alarms.
const DEV_ONLY_CALLS = [/\balarms\s*\./, /\bruntime\.reload\s*\(/];
for (const file of walk(SRC)) {
  if (extname(file) !== ".js") continue;
  const relative = file.slice(SRC.length + 1);
  const devOnly = isDevOnlySource(relative);
  const source = readFileSync(file, "utf8");
  for (const pattern of DEV_ONLY_CALLS) {
    if (pattern.test(source) && !devOnly) {
      failures.push(`src/${relative} does what only src/${DEV_SOURCE_DIR}/ may do (${pattern.source})`);
    }
  }
  // And nothing a production build copies may even reach for it.
  if (!devOnly && /from\s+["'][^"']*\/dev\//.test(source)) {
    failures.push(`src/${relative} imports from src/${DEV_SOURCE_DIR}/, which production builds do not hold`);
  }
}

// The filter the build copies through has to agree about which those are.
for (const file of walk(resolve(SRC, DEV_SOURCE_DIR))) {
  const relative = file.slice(SRC.length + 1);
  if (!isDevOnlySource(relative)) failures.push(`the build would copy ${relative} into a production build`);
}
for (const relative of ["background/background.js", "common/browser.js", "popup/popup.js"]) {
  if (isDevOnlySource(relative)) failures.push(`the build would leave ${relative} out of a production build`);
}

// 8. The built popup is its HTML plus one script, with nothing to chain.
//
// Every extension fetch the popup waits on is a round trip before the window
// is shown, and some machines make each one cost over a second. So the built
// page may not link a stylesheet, may load exactly one script, and that script
// may not import anything — statically or with import() — that would be
// another fetch. This builds every target into a scratch directory and looks.
{
  const scratch = mkdtempSync(join(tmpdir(), "read-aloud-check-"));
  try {
    for (const target of TARGETS) {
      build({ only: target.name, out: scratch });
      const directory = resolve(scratch, target.name);
      const html = readFileSync(resolve(directory, POPUP.html), "utf8");
      const where = `${target.name}/${POPUP.html}`;
      for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        if (/stylesheet|\.css\b/i.test(tag)) failures.push(`${where} links a stylesheet: ${tag}`);
      }
      const fetched = [...html.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)].map(
        (match) => match[1],
      );
      if (fetched.length !== 1 || fetched[0] !== POPUP.script.split("/").pop()) {
        failures.push(`${where} should fetch only ${POPUP.script.split("/").pop()}, but fetches: ${fetched.join(", ") || "nothing"}`);
      }
      if (/<style\b/i.test(html) === false) failures.push(`${where} has no inlined stylesheet`);

      const script = readFileSync(resolve(directory, POPUP.script), "utf8");
      try {
        const parsed = new vm.SourceTextModule(script, { identifier: `${target.name}/${POPUP.script}` });
        if (parsed.dependencySpecifiers.length) {
          failures.push(`${target.name}/${POPUP.script} imports ${parsed.dependencySpecifiers.join(", ")}`);
        }
      } catch (error) {
        failures.push(`parse ${target.name}/${POPUP.script}: ${error.message}`);
      }
      if (/\bimport\s*\(/.test(script)) failures.push(`${target.name}/${POPUP.script} calls import()`);
      try {
        statSync(resolve(directory, POPUP.stylesheet));
        failures.push(`${target.name} still ships ${POPUP.stylesheet}, which nothing loads`);
      } catch {
        // Gone, as it should be.
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`checked ${files.length} files — all good`);
