/**
 * Watches `src/` and rebuilds `dist/chrome` as a dev build on every change.
 *
 *   npm run dev
 *   npm run dev -- --only chrome-test     # the build tools/e2e.js loads
 *
 * The build it writes carries an id and the watcher that reads it, so the copy
 * of the extension loaded in Chrome reloads itself into each rebuild; see
 * `src/dev/reload.js`. Nothing is installed and nothing is bundled — a rebuild
 * is a directory copy, which is why a change can simply rebuild everything
 * rather than work out what depends on what.
 */
import { watch } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src");

/**
 * Long enough that one save does not rebuild twice — an editor writing a file
 * is several events, and `cpSync` over a half-written tree is a broken build —
 * and short enough to stay out of the way.
 */
const DEBOUNCE_MS = 150;

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const only = args.get("only") ?? "chrome";

function rebuild(reason) {
  const started = Date.now();
  try {
    const { buildId } = build({ dev: true, only });
    const at = new Date().toLocaleTimeString();
    console.log(`${at}  built dist/${only} — build ${buildId} (${Date.now() - started}ms)${reason}`);
  } catch (error) {
    // A broken build must not end the watch: the next save is usually the fix.
    console.error(`${new Date().toLocaleTimeString()}  build failed: ${error.message}`);
  }
}

rebuild("");
console.log(`watching ${relative(ROOT, SRC)}/ — load dist/${only} unpacked once and leave it; Ctrl-C to stop`);

let pending = null;
let changed = new Set();

watch(SRC, { recursive: true }, (_event, name) => {
  if (name) changed.add(name);
  clearTimeout(pending);
  pending = setTimeout(() => {
    const files = [...changed];
    changed = new Set();
    const named = files.slice(0, 3).join(", ");
    const more = files.length > 3 ? ` +${files.length - 3} more` : "";
    rebuild(files.length ? `  ← ${named}${more}` : "");
  }, DEBOUNCE_MS);
});

process.on("SIGINT", () => {
  console.log("\nstopped watching");
  process.exit(0);
});
