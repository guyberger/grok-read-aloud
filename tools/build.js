/**
 * Copies the single source tree into one unpacked extension per browser,
 * swapping in that browser's manifest. No bundler, no transform.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src");
const DIST = resolve(ROOT, "dist");

const TARGETS = [
  { name: "chrome", manifest: "manifest.chrome.json" },
  { name: "firefox", manifest: "manifest.firefox.json" },
];

const MANIFEST_FILES = TARGETS.map((target) => target.manifest);

rmSync(DIST, { recursive: true, force: true });

for (const target of TARGETS) {
  const out = resolve(DIST, target.name);
  mkdirSync(out, { recursive: true });
  cpSync(SRC, out, {
    recursive: true,
    filter: (source) => !MANIFEST_FILES.some((file) => source.endsWith(file)),
  });

  const manifest = JSON.parse(readFileSync(resolve(SRC, target.manifest), "utf8"));
  writeFileSync(resolve(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`built dist/${target.name} (${manifest.name} ${manifest.version})`);
}
