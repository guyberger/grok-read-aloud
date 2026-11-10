/**
 * The popup, as two files: its HTML with the stylesheet inlined, and one
 * script holding every module it reaches.
 *
 * Why this exists: every `chrome-extension://` load a page waits on is a round
 * trip, and in some environments (a security agent proxying extension
 * requests, for one) each round trip costs over a second. Loaded straight from
 * `src/`, the popup is a chain four deep — the HTML, then its stylesheet and
 * script, then the modules the script imports, then theirs — and the popup
 * window is not shown until the chain settles. Built through here it is the
 * HTML plus one script, with nothing left to discover.
 *
 * Deliberately small. It understands the module syntax this repo writes and
 * refuses anything else at build time rather than guessing:
 *
 *   import { a, b as c } from "./x.js";      import * as ns from "./x.js";
 *   import "./x.js";                          import("./x.js")   (string literal)
 *   export const|let|var|function|async function|class name …
 *   export { a, b as c };
 *
 * Each module becomes a function that runs the first time something asks for
 * it, exactly as module evaluation would. A dynamic `import()` becomes a
 * promise of that, so code the source deliberately loads late still runs late;
 * it just no longer costs a fetch. `src/` stays plain modules.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const STATIC_IMPORT = /^import\s+(?:([\s\S]*?)\s+from\s+)?(["'])([^"']+)\2\s*;?[ \t]*$/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:(["'])([^"']+)\1\s*)?\)?/g;
const EXPORT_DECLARATION = /^export\s+((?:async\s+)?function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;
const UNSUPPORTED = [
  [/^export\s+default\b/m, "export default"],
  [/^export\s*\*/m, "export *"],
  [/^export\s*\{[^}]*\}\s*from\b/m, "export … from"],
  [/^export\s+(?:const|let|var)\s*[[{]/m, "a destructuring export"],
  [/\bimport\.meta\b/, "import.meta"],
];

const toId = (root, file) => relative(root, file).split(sep).join("/");

function parseBindings(clause, file) {
  const namespace = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (namespace) return { namespace: namespace[1] };
  const named = clause.match(/^\{([\s\S]*)\}$/);
  if (!named) throw new Error(`${file}: unsupported import clause "${clause}" (default imports are not bundled)`);
  const pairs = named[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [imported, local = imported] = part.split(/\s+as\s+/).map((name) => name.trim());
      return imported === local ? imported : `${imported}: ${local}`;
    });
  return { named: pairs };
}

/**
 * Bundles `entry` and everything it imports, statically or dynamically, into
 * one script with no imports left in it. `root` is what module ids are
 * relative to; nothing outside it may be imported.
 */
export function bundle(entry, { root = dirname(entry) } = {}) {
  const modules = new Map(); // id -> generated factory source
  const visiting = new Set();

  function load(file) {
    const id = toId(root, file);
    if (id.startsWith("..")) throw new Error(`${file} is outside ${root}`);
    if (modules.has(id)) return id;
    if (visiting.has(id)) throw new Error(`import cycle through ${id}; the bundler does not do cycles`);
    visiting.add(id);

    let source = readFileSync(file, "utf8");
    for (const [pattern, what] of UNSUPPORTED) {
      if (pattern.test(source)) throw new Error(`${id}: ${what} is not supported by tools/bundle.js`);
    }

    const resolveSpecifier = (specifier) => {
      if (!specifier.startsWith(".")) throw new Error(`${id}: bare import "${specifier}" cannot be bundled`);
      return load(resolve(dirname(file), specifier));
    };

    source = source.replace(STATIC_IMPORT, (_line, clause, _quote, specifier) => {
      const target = JSON.stringify(resolveSpecifier(specifier));
      if (!clause) return `__require(${target});`;
      const bindings = parseBindings(clause.trim(), id);
      if (bindings.namespace) return `const ${bindings.namespace} = __require(${target});`;
      return `const { ${bindings.named.join(", ")} } = __require(${target});`;
    });

    source = source.replace(DYNAMIC_IMPORT, (match, _quote, specifier) => {
      if (!specifier || !match.endsWith(")")) {
        throw new Error(`${id}: import() needs a string literal to be bundled (${match})`);
      }
      return `Promise.resolve().then(() => __require(${JSON.stringify(resolveSpecifier(specifier))}))`;
    });

    const exported = []; // [exported name, local name]
    source = source.replace(EXPORT_DECLARATION, (_match, kind, name) => {
      exported.push([name, name]);
      return `${kind} ${name}`;
    });
    source = source.replace(EXPORT_LIST, (_match, list) => {
      for (const part of list.split(",").map((item) => item.trim()).filter(Boolean)) {
        const [local, name = local] = part.split(/\s+as\s+/).map((item) => item.trim());
        exported.push([name, local]);
      }
      return "";
    });

    // Getters, so an export reads the binding's current value the way a live
    // module binding does.
    const namespace = exported.map(([name, local]) => `get ${name}() { return ${local}; }`).join(", ");
    modules.set(
      id,
      `  ${JSON.stringify(id)}: (__require) => {\n${source.replace(/\s+$/, "")}\n` +
        `return Object.freeze({ __proto__: null, ${namespace} });\n  },`,
    );
    visiting.delete(id);
    return id;
  }

  const entryId = load(entry);
  return [
    `// Generated by tools/build.js from ${entryId} and`,
    `// the modules it imports. Edit those, not this.`,
    `const __modules = {`,
    ...modules.values(),
    `};`,
    `const __evaluated = new Map();`,
    `function __require(id) {`,
    `  if (!__evaluated.has(id)) __evaluated.set(id, __modules[id](__require));`,
    `  return __evaluated.get(id);`,
    `}`,
    `__require(${JSON.stringify(entryId)});`,
    ``,
  ].join("\n");
}

/** Replaces each local `<link rel="stylesheet">` in `html` with a `<style>` holding the file. */
export function inlineStylesheets(html, directory) {
  return html.replace(/^([ \t]*)<link\b[^>]*>[ \t]*$/gim, (tag, indent) => {
    if (!/\brel=["']?stylesheet\b/i.test(tag)) return tag;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href || /^[a-z][\w+.-]*:/i.test(href)) throw new Error(`cannot inline stylesheet ${tag.trim()}`);
    const css = readFileSync(resolve(directory, href), "utf8");
    if (/<\/style/i.test(css)) throw new Error(`${href} contains "</style", which cannot be inlined`);
    return `${indent}<style>\n${css.replace(/\s+$/, "")}\n${indent}</style>`;
  });
}
