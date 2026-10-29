/**
 * Copies the single source tree into one unpacked extension per browser,
 * swapping in that browser's manifest. No bundler, no transform.
 *
 *   node tools/build.js                          # the three production builds
 *   node tools/build.js --dev --only chrome      # dist/chrome, with auto-reload
 *   node tools/build.js --dev --only chrome-test --out /tmp/somewhere
 *
 * `--dev` is the only thing that ever puts `src/dev/` into a build, and the
 * only thing that adds a permission to a manifest. A production build is byte
 * for byte what it was before any of that existed; `tools/check.js` asserts it
 * by asking this file for both manifests and comparing them.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// The two names a dev build has for itself are defined where they are read.
import { BUILD_ID_FILE, DEV_VERSION_MARK } from "../src/dev/build-id.js";

export { BUILD_ID_FILE, DEV_VERSION_MARK };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src");
const DIST = resolve(ROOT, "dist");

export const TARGETS = [
  { name: "chrome", manifest: "manifest.chrome.json" },
  { name: "firefox", manifest: "manifest.firefox.json" },
  // Identical to the Chrome build except that it holds `<all_urls>` outright.
  // The automated driver cannot produce the user gesture that grants
  // activeTab, so tools/e2e.js loads this one instead.
  { name: "chrome-test", manifest: "manifest.chrome.json", grantAllUrls: true },
];

const MANIFEST_FILES = TARGETS.map((target) => target.manifest);

/** The source directory that only a dev build is allowed to copy. */
export const DEV_SOURCE_DIR = "dev";

/** The generated entry point a dev build's background runs instead. */
export const DEV_WORKER_FILE = "dev/service-worker.js";

/** What a dev build adds to a manifest, and all it adds. */
export const DEV_PERMISSIONS = ["alarms"];

/** True for a source path no production build may copy. */
export function isDevOnlySource(path) {
  const parts = relative(SRC, resolve(SRC, path)).split(sep);
  return parts[0] === DEV_SOURCE_DIR;
}

/**
 * A name for this build that is different from the last one's, and sorts.
 *
 * The timestamp is for reading — it is what `chrome://extensions` shows next to
 * the version — and the suffix is what makes two rebuilds in the same second
 * different builds, which is the only thing the comparison needs.
 */
export function newBuildId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}.${randomUUID().slice(0, 6)}`;
}

function headCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a checkout, or no git. The commit is a convenience, not a dependency.
    return null;
  }
}

/**
 * The manifest a target ships, production or dev.
 *
 * A dev build differs in exactly three ways, and `tools/check.js` asserts that
 * the list is exactly these three: the background entry point becomes the
 * generated shim that pulls in the watcher alongside the real worker, `alarms`
 * is added so a sleeping worker is woken to look for a rebuild, and
 * `version_name` carries the id of the build that is running — which is the
 * only thing an extension can read that does *not* change until it reloads.
 */
export function manifestFor(target, { dev = false, buildId = null } = {}) {
  const manifest = JSON.parse(readFileSync(resolve(SRC, target.manifest), "utf8"));

  if (target.grantAllUrls) {
    manifest.name = `${manifest.name} (test build)`;
    manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
    delete manifest.optional_host_permissions;
  }

  if (!dev) return manifest;

  if (!manifest.background?.service_worker) {
    throw new Error(
      `--dev is a Chrome affordance: ${target.name} has no background.service_worker to wrap`,
    );
  }
  manifest.background = { ...manifest.background, service_worker: DEV_WORKER_FILE };
  manifest.permissions = [...manifest.permissions, ...DEV_PERMISSIONS];
  manifest.version_name = `${manifest.version}${DEV_VERSION_MARK}${buildId}`;
  return manifest;
}

/** Writes one unpacked extension, and returns where it went. */
export function buildTarget(target, { dev = false, buildId = null, out = DIST } = {}) {
  // Shaped before anything is written: a target that cannot be built this way
  // should say so rather than leave half a build behind.
  const manifest = manifestFor(target, { dev, buildId });

  const directory = resolve(out, target.name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  cpSync(SRC, directory, {
    recursive: true,
    filter: (source) => {
      if (MANIFEST_FILES.some((file) => source.endsWith(file))) return false;
      if (!dev && isDevOnlySource(source)) return false;
      return true;
    },
  });

  writeFileSync(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (dev) {
    // The real worker first, so its message listener is registered before
    // anything else runs; then the watcher, which only ever schedules work.
    writeFileSync(
      resolve(directory, DEV_WORKER_FILE),
      `// Generated by tools/build.js --dev. The real worker, plus the watcher\n` +
        `// that reloads this extension when a rebuild lands on disk.\n` +
        `import "../background/background.js";\n` +
        `import "./reload.js";\n`,
    );
    writeFileSync(
      resolve(directory, BUILD_ID_FILE),
      `${JSON.stringify({ buildId, builtAt: new Date().toISOString(), commit: headCommit() }, null, 2)}\n`,
    );
  }

  return { directory, manifest };
}

export function build({ dev = false, only = null, out = DIST } = {}) {
  const targets = only ? TARGETS.filter((target) => target.name === only) : TARGETS;
  if (!targets.length) {
    throw new Error(`unknown target ${only}; try ${TARGETS.map((target) => target.name).join(", ")}`);
  }
  // A whole-dist build starts from nothing; a single target leaves the others
  // alone, so `npm run dev` cannot quietly delete the build e2e.js loads.
  if (!only) rmSync(out, { recursive: true, force: true });

  const buildId = dev ? newBuildId() : null;
  const built = targets.map((target) => ({ target, ...buildTarget(target, { dev, buildId, out }) }));
  return { buildId, built };
}

function parseArgs(argv) {
  const options = { dev: false, only: null, out: DIST };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dev") options.dev = true;
    else if (flag === "--only") options.only = argv[++i];
    else if (flag === "--out") options.out = resolve(argv[++i]);
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { buildId, built } = build(options);
    for (const { target, manifest } of built) {
      const where = relative(ROOT, resolve(options.out, target.name));
      console.log(`built ${where} (${manifest.name} ${manifest.version_name ?? manifest.version})`);
    }
    if (buildId) console.log(`build id ${buildId}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
