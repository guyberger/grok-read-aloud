/**
 * Static sanity pass: every JS file parses, both manifests are valid JSON and
 * point at files that exist, and no API key ever slipped into the tree.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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
const MODULE_PATHS = ["/common/", "/background/", "/popup/", "/options/", "/tools/"];
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
  if (!manifest.host_permissions?.includes("https://api.x.ai/*")) {
    failures.push(`${name} is missing the api.x.ai host permission`);
  }
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

// 4. Every keyboard command a manifest declares is one the background handles.
const commandBlock = background.slice(background.indexOf("const COMMAND_MESSAGES"));
const commandNames = [...commandBlock.slice(0, commandBlock.indexOf("};")).matchAll(/"([\w-]+)":/g)].map(
  (match) => match[1],
);
for (const name of ["manifest.chrome.json", "manifest.firefox.json"]) {
  let commands;
  try {
    commands = Object.entries(JSON.parse(readFileSync(resolve(SRC, name), "utf8")).commands ?? {});
  } catch {
    continue;
  }
  for (const [command] of commands) {
    if (!commandNames.includes(command)) failures.push(`${name} declares unhandled command ${command}`);
  }
  // Chrome refuses to install an extension that suggests more than four keys.
  const suggested = commands.filter(([, command]) => command.suggested_key).length;
  if (suggested > 4) failures.push(`${name} suggests ${suggested} shortcuts; Chrome allows 4`);
}

// 5. No credentials committed.
const SECRET_PATTERNS = [/xai-[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{20,}/];
for (const file of files) {
  if (![".js", ".json", ".md", ".html", ".css"].includes(extname(file))) continue;
  const source = readFileSync(file, "utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(source)) failures.push(`possible credential in ${file.slice(ROOT.length)}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`checked ${files.length} files — all good`);
