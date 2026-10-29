import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Browser, contentBundle, findChrome, fixtureUrl } from "./headless.js";
import { loadContentNamespace } from "./load-content.js";

// `URL` is a global the module reaches for through `globalThis`, the way a
// page gives it one.
const { docs } = loadContentNamespace(["util.js", "extract.js", "docs.js"], { URL });

const EDIT_URL = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit";

// ---------------------------------------------------------------------------
// Which pages are documents, and where their text is fetched from.
// ---------------------------------------------------------------------------

test("an open document gives up its id and its export endpoint", () => {
  const target = docs.documentAt(EDIT_URL);
  assert.equal(target.id, "1AbCdEfGhIjKlMnOpQrStUvWxYz");
  assert.equal(
    target.exportUrl,
    "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/export?format=txt",
  );
});

test("the second signed-in account's document is exported as that account", () => {
  const target = docs.documentAt("https://docs.google.com/document/u/2/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#heading=h.9");
  assert.equal(
    target.exportUrl,
    "https://docs.google.com/document/u/2/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/export?format=txt",
    "dropping the user index exports the wrong account's copy, or nothing at all",
  );
});

test("the editor is recognised whatever is after the id", () => {
  for (const path of ["/edit", "/edit?usp=sharing", "/preview", "/view", "", "/edit#bookmark=id.x"]) {
    assert.ok(
      docs.isDocument(`https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz${path}`),
      `${path || "(no suffix)"} was not recognised`,
    );
  }
});

test("pages that are not a canvas-drawn document are left to the normal walk", () => {
  // A published copy is ordinary HTML with the text in it, so the normal walk
  // reads it — highlight, clicks and all. Taking it over would be a downgrade.
  assert.equal(docs.isDocument("https://docs.google.com/document/d/e/2PACX-1vQpublished/pub"), false);
  assert.equal(docs.isDocument("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQ/edit"), false);
  assert.equal(docs.isDocument("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQ/edit"), false);
  assert.equal(docs.isDocument("https://docs.google.com/document/u/0/"), false);
  assert.equal(docs.isDocument("https://example.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit"), false);
  assert.equal(docs.isDocument("not a url at all"), false);
  assert.equal(docs.isDocument(undefined), false);
});

// ---------------------------------------------------------------------------
// The export, turned into something worth speaking.
// ---------------------------------------------------------------------------

test("the export's byte-order mark and carriage returns never reach the voice", () => {
  const cleaned = docs.clean("\uFEFFFirst line.\r\n\r\nSecond line.\r\n");
  assert.equal(cleaned, "First line.\n\nSecond line.");
});

test("blank runs collapse to one paragraph break", () => {
  assert.equal(docs.clean("One.\n\n\n\n\nTwo.\n \n\nThree."), "One.\n\nTwo.\n\nThree.");
});

test("inline images and invisible characters are dropped rather than spoken", () => {
  // An image, drawing or equation exports as U+FFFC, which a voice would
  // either skip or stumble over, and neither is worth the characters.
  assert.equal(docs.clean("A diagram \uFFFC sits here.\u200B"), "A diagram  sits here.");
});

test("paragraph breaks survive, because that is where a sentence ends", () => {
  const cleaned = docs.clean("A heading with no full stop\r\n\r\nAnd the paragraph under it.");
  assert.ok(cleaned.includes("\n\n"), "a heading run into the next paragraph reads as one sentence");
});

// ---------------------------------------------------------------------------
// Reading a real page.
// ---------------------------------------------------------------------------

const skip = findChrome() ? false : "no Chrome binary found (set CHROME_PATH to run these)";

let browser = null;
const pages = [];

before(async () => {
  if (skip) return;
  browser = await Browser.launch();
});

after(async () => {
  for (const page of pages) await page.close().catch(() => {});
  browser?.close();
});

const EXPORTED = [
  "Notes on the stone bridge at Clun",
  "The bridge has stood since the fourteenth century, and it has been rebuilt at least four times without ever being replaced.",
  "Each of the cutwaters is a different shape, because each was cut by a different mason working from a different drawing.",
  "The parapet is the newest part of it, and the only part anyone argues about.",
].join("\r\n\r\n");

async function open(fixture) {
  const page = await browser.open(fixtureUrl(fixture), contentBundle(["util.js", "extract.js", "docs.js"]));
  pages.push(page);
  return {
    page,
    /**
     * `docs.read` against a stand-in for the endpoint. `href` is passed in
     * because a fixture is served from the filesystem, where the real thing
     * is the address of the document being read.
     */
    read: (behaviour = "ok") =>
      page.evaluate(`
        (async () => {
          const answers = {
            ok: () => Promise.resolve({ ok: true, text: () => Promise.resolve(${JSON.stringify(EXPORTED)}) }),
            signIn: () => Promise.resolve({ ok: true, text: () => Promise.resolve("<!DOCTYPE html><h1>Sign in</h1>") }),
            denied: () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") }),
            offline: () => Promise.reject(new TypeError("Failed to fetch")),
          };
          window.__fetches = [];
          const fetchImpl = (url, options) => {
            window.__fetches.push({ url, credentials: options?.credentials });
            return answers[${JSON.stringify(behaviour)}]();
          };
          const doc = await globalThis.__readAloud.docs.read({
            href: ${JSON.stringify(EDIT_URL)},
            fetchImpl,
          });
          return doc
            ? {
                text: doc.text,
                scope: doc.scope,
                mapped: doc.mapped,
                slices: doc.slices.length,
                notice: doc.notice ?? "",
                range: Boolean(globalThis.__readAloud.extract.rangeFor(doc, 0, 8)),
              }
            : null;
        })()
      `),
    fetches: () => page.evaluate(`JSON.stringify(window.__fetches ?? [])`).then(JSON.parse),
    walk: () =>
      page.evaluate(`
        (() => {
          const doc = globalThis.__readAloud.extract.extract("page", {});
          return doc ? { text: doc.text, mapped: doc.mapped } : null;
        })()
      `),
    annotated: () => page.evaluate(`globalThis.__readAloud.docs.annotatedText()`),
  };
}

test("the plain walk of a canvas-drawn document finds the menus and nothing else", { skip }, async () => {
  const { walk } = await open("google-docs.html");
  const doc = await walk();

  // The bug this is all about: every word of the document is in a canvas, so
  // the walk comes back with the furniture around it.
  assert.ok(doc, "the page extracted to nothing at all");
  assert.ok(!doc.text.includes("cutwaters"), "the fixture is no longer canvas-drawn");
  assert.ok(!doc.text.includes("fourteenth century"));
  assert.ok(doc.text.includes("Comment history"), "the fixture has no chrome left to mistake for the document");
});

test("the document's own text is fetched from the export endpoint", { skip }, async () => {
  const { read, fetches } = await open("google-docs.html");
  const doc = await read("ok");

  assert.ok(doc, "nothing came back for a document that exports cleanly");
  assert.ok(doc.text.startsWith("Notes on the stone bridge at Clun"), doc.text.slice(0, 40));
  assert.ok(doc.text.includes("Each of the cutwaters is a different shape"));
  assert.ok(doc.text.includes("The parapet is the newest part of it"), "the body stopped short of the last paragraph");
  assert.equal(doc.scope, "page");

  const [call] = await fetches();
  assert.equal(
    call.url,
    "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/export?format=txt",
    "the export was asked for somewhere else",
  );
  assert.equal(call.credentials, "include", "without the session cookie a private document answers with a sign-in page");
});

test("text that is in no node of the page says so, and paints nothing", { skip }, async () => {
  const { read } = await open("google-docs.html");
  const doc = await read("ok");

  assert.equal(doc.mapped, false);
  assert.equal(doc.slices, 0);
  assert.equal(doc.range, false, "a range over text with no nodes behind it would throw or point at nothing");
  assert.match(doc.notice, /canvas/i, "the reader has nothing to tell the popup about the missing highlight");
});

test("a document the session cannot see falls back to what is on screen", { skip }, async () => {
  const { read } = await open("google-docs.html");

  // The endpoint answers a sign-in page rather than an error, so the fallback
  // depends on noticing that what came back is HTML.
  const doc = await read("signIn");
  assert.ok(doc, "a sign-in page was taken for the document, or nothing was read at all");
  assert.ok(doc.text.includes("Each of the cutwaters is a different shape"), doc.text);
  assert.ok(
    !doc.text.includes("The parapet"),
    "the accessibility layer only covers the drawn tiles, so this claims more than it can know",
  );
  assert.match(doc.notice, /on screen/i);
});

test("a refused or unreachable endpoint falls back the same way", { skip }, async () => {
  for (const behaviour of ["denied", "offline"]) {
    const { read } = await open("google-docs.html");
    const doc = await read(behaviour);
    assert.ok(doc, `nothing was read when the export ${behaviour}`);
    assert.ok(doc.text.includes("fourteenth century"), `${behaviour}: ${doc.text}`);
  }
});

test("the accessibility layer reads as paragraphs, not as a heap of labels", { skip }, async () => {
  const { annotated } = await open("google-docs.html");
  const text = await annotated();

  // Docs labels line by line, so the lines of a paragraph are joined into one
  // and the paragraphs are kept apart — which is where a sentence ends.
  assert.ok(
    text.startsWith(
      "The bridge has stood since the fourteenth century, and it has been rebuilt at least four times without ever being replaced.",
    ),
    text,
  );
  assert.equal(text.split("\n").length, 2, text);
});

test("a canvas in the editor settles it, whatever text is near it", { skip }, async () => {
  const { page } = await open("google-docs.html");

  // Docs keeps an off-screen line or two in the DOM for assistive technology,
  // and a comment or a placeholder can be in there too. Reading those as if
  // they were the document is the quietest way this could go wrong, so the
  // canvas is what decides, not how much text happens to be lying about.
  const found = await page.evaluate(`
    (() => {
      const editor = document.querySelector(".kix-appview-editor");
      const stray = document.createElement("div");
      stray.textContent =
        "Suggested edit from a reviewer that is quite long enough to look like a document all by itself, " +
        "and would be read aloud in its place if the only question asked were how many characters are here.";
      editor.appendChild(stray);
      const doc = globalThis.__readAloud.docs.domDocument({});
      return doc ? doc.text : null;
    })()
  `);
  assert.equal(found, null, found);
});

test("a document the old renderer drew is read out of the page itself", { skip }, async () => {
  const { read, fetches } = await open("google-docs-dom.html");
  const doc = await read("ok");

  assert.ok(doc.text.includes("Each of the cutwaters is a different shape"));
  assert.ok(doc.text.includes("The parapet is the newest part of it"));
  assert.equal(doc.mapped, true, "text that really is in the page should be read like any other page's");
  assert.ok(doc.slices > 0);
  assert.equal(doc.range, true, "a mapped document has somewhere to put the highlight");
  assert.deepEqual(await fetches(), [], "the page already had the text; asking the network for it again is waste");
});

test("the chrome around the old renderer is not read with it", { skip }, async () => {
  const { read } = await open("google-docs-dom.html");
  const doc = await read("ok");

  assert.ok(!doc.text.includes("Comment history"), "the sidebar was read as part of the document");
  assert.ok(!doc.text.includes("Last edit was"), "the toolbar was read as part of the document");
});
