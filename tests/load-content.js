/**
 * Content scripts are classic scripts sharing one namespace object, so tests
 * evaluate them the same way the browser does rather than importing them.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/content");

export function loadContentNamespace(files = ["util.js", "align.js"]) {
  const context = vm.createContext({ globalThis: null, console });
  context.globalThis = context;
  for (const file of files) {
    vm.runInContext(readFileSync(resolve(SRC, file), "utf8"), context, { filename: file });
  }
  return context.__readAloud;
}

/**
 * Builds the `graph_chars` / `graph_times` pair the API returns, pretending
 * every character takes the same amount of time.
 */
export function fakeTimestamps(text, secondsPerChar = 0.05) {
  const graphChars = [...text];
  const graphTimes = graphChars.map((_, index) => [
    Number((index * secondsPerChar).toFixed(6)),
    Number(((index + 1) * secondsPerChar).toFixed(6)),
  ]);
  return { graphChars, graphTimes, duration: graphChars.length * secondsPerChar };
}
