(function (ns) {
  "use strict";

  const HOST = "docs.google.com";

  /**
   * A Google Doc open in the editor, and where its plain text can be fetched
   * from.
   *
   * `/document/u/1/d/<id>/edit` is the same document seen by the second signed
   * in account, and the export has to be asked for as that account too, so the
   * user index is carried over rather than dropped. A published copy —
   * `/document/d/e/<id>/pub` — is ordinary HTML with the text in it, so it is
   * deliberately not matched: the normal walk reads it, highlight and all.
   */
  const EDITOR_PATH = /^\/document\/(u\/\d+\/)?d\/(?!e\/)([A-Za-z0-9_-]{8,})/;

  /**
   * The editor itself. It is there in both renderers: with the old one it
   * holds the lines of the document as text, and with the canvas one it holds
   * the canvas — which is why what comes out of it is measured rather than
   * trusted.
   */
  const DOM_EDITOR = ".kix-appview-editor";

  /** The canvas tiles, and the accessibility layer drawn over them. */
  const CANVAS_TILE = ".kix-canvas-tile-content";

  /** Below this, what the editor holds is furniture rather than a document. */
  const MIN_DOM_CHARS = 120;

  /** Below this, the annotation layer is a stray label rather than the text. */
  const MIN_ANNOTATED_CHARS = 40;

  /**
   * A cap on what one read will hold in memory. Around 150 pages of prose,
   * which is some hours of audio — far past the point where the rest of the
   * document is a second read rather than this one.
   */
  const MAX_CHARS = 400_000;

  const FETCH_TIMEOUT_MS = 10_000;

  const EXPORTED_NOTICE =
    "Reading this Google Doc's text. Docs draws its words on a canvas, so there is nothing in the page to highlight.";

  const ANNOTATED_NOTICE =
    "Reading the part of this Google Doc that is on screen — its full text could not be fetched. Nothing in the page can be highlighted.";

  /**
   * @param {string} href
   * @returns {{id: string, exportUrl: string}|null}
   */
  function documentAt(href = globalThis.location?.href) {
    let url;
    try {
      url = new URL(String(href));
    } catch {
      return null;
    }
    if (url.hostname !== HOST) return null;
    const match = EDITOR_PATH.exec(url.pathname);
    if (!match) return null;
    const [, user = "", id] = match;
    return { id, exportUrl: `${url.origin}/document/${user}d/${id}/export?format=txt` };
  }

  const isDocument = (href) => documentAt(href) !== null;

  /**
   * The export, as something worth speaking: one newline between the lines of
   * a paragraph and two between paragraphs, which is what the chunker and the
   * sentence walk already read as a break.
   */
  function clean(raw) {
    return String(raw)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      // An inline image, drawing or equation exports as an object replacement
      // character, which has nothing to say out loud.
      .replace(/[\uFFFC\u200B\u00AD]/g, "")
      .replace(/[^\S\n]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, MAX_CHARS);
  }

  /**
   * The document's plain text, straight from the endpoint File → Download →
   * Plain text uses.
   *
   * Same-origin, from the page the user is looking at, so it carries their
   * session cookie and needs no host permission of its own: this is the
   * content script asking docs.google.com for the document it is already
   * showing. A document the session cannot see answers with a sign-in page
   * rather than an error, so what comes back is looked at before it is spoken.
   */
  async function fetchExport(target, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    if (!target) return "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target.exportUrl, {
        credentials: "include",
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response?.ok) return "";
      const raw = await response.text();
      if (/^\s*</.test(raw)) return "";
      return clean(raw);
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What the accessibility layer over the canvas says, where there is one.
   *
   * Docs can draw an invisible `<rect aria-label="…">` over each run of text
   * so that assistive technology has something to read. It only does so for a
   * handful of allowlisted extension ids, which this is not — but a user with
   * one of those installed, or with Docs' own screen reader support on, has
   * the layer anyway, and it is the one path that works with no network at
   * all. It only covers the tiles Docs has drawn, so it is the last resort
   * rather than the first: the export is the whole document, this is the part
   * of it on screen.
   */
  function annotatedText(root = document) {
    const paragraphs = [];
    let group = null;
    for (const tile of root.querySelectorAll(CANVAS_TILE)) {
      // Asked of the ancestors up to the tile and no further. The editor
      // around it is labelled too — "Document content" — and a search that
      // walked past the tile would find that above every single run.
      const within = (node, test) => {
        for (let el = node; el && el !== tile; el = el.parentElement) {
          if (test(el)) return el;
        }
        return null;
      };

      for (const node of tile.querySelectorAll("[aria-label]")) {
        // Docs labels the run, and sometimes the paragraph around it as well.
        // Taking both would say every word twice.
        if (node.parentElement && within(node.parentElement, (el) => el.hasAttribute("aria-label"))) continue;
        const label = node.getAttribute("aria-label")?.trim();
        if (!label) continue;
        const owner = within(node, (el) => el.getAttribute("role") === "paragraph") ?? tile;
        if (owner !== group) {
          paragraphs.push([]);
          group = owner;
        }
        paragraphs.at(-1).push(label);
      }
    }
    // Runs are labelled line by line, so they are joined with a space rather
    // than butted together, and any spacing already in a label is normalised.
    return clean(paragraphs.map((runs) => runs.join(" ").replace(/\s+/g, " ").trim()).join("\n"));
  }

  /**
   * Text that is really in the page, read the way any other page is read.
   *
   * This is the good case and it is worth asking for first: the characters
   * have DOM nodes behind them, so the word being spoken can be highlighted
   * and a sentence can be clicked.
   */
  function domDocument(options) {
    const editor = document.querySelector(DOM_EDITOR);
    // A canvas in the editor means Docs is painting the document rather than
    // laying it out, and then whatever text is in there is not the document:
    // a placeholder, a comment, the line an assistive reader is being handed.
    // Reading that instead of the document would be the quietest possible
    // failure, so the canvas settles it before the character count does.
    if (!editor || editor.querySelector("canvas")) return null;
    const built = ns.extract.extract("page", { ...options, root: editor });
    return built && built.text.length >= MIN_DOM_CHARS ? built : null;
  }

  /**
   * A document whose characters are in no node of the page.
   *
   * Everything downstream works on `doc.text` and asks for a DOM Range only
   * when it has somewhere to paint. An empty slice list is what says there is
   * nowhere: `extract.rangeFor` hands back nothing, the highlight stays off,
   * and the reader keeps itself out of the page's click and scroll paths.
   */
  function unmappedDocument(text, notice) {
    return {
      text,
      charNodes: new Int32Array(0),
      charOffsets: new Int32Array(0),
      slices: [],
      root: document.body,
      scope: "page",
      mapped: false,
      notice,
    };
  }

  /**
   * The document's own text: the page itself first, where that is where the
   * text is, then the export, then whatever has been drawn an accessibility
   * layer over.
   *
   * Null when this is not a Google Doc, and null when it is one that could not
   * be read at all — offline, or signed out of the account that can open it.
   * The caller says so rather than falling back to the walk, because on a
   * canvas-drawn document the walk is the menu bar.
   */
  async function read({ href, readCodeBlocks = false, fetchImpl, timeoutMs } = {}) {
    const target = documentAt(href);
    if (!target) return null;

    const inPage = domDocument({ readCodeBlocks });
    if (inPage) return inPage;

    const exported = await fetchExport(target, { fetchImpl, timeoutMs });
    if (exported) return unmappedDocument(exported, EXPORTED_NOTICE);

    const annotated = annotatedText();
    if (annotated.length >= MIN_ANNOTATED_CHARS) return unmappedDocument(annotated, ANNOTATED_NOTICE);

    return null;
  }

  ns.docs = {
    documentAt,
    isDocument,
    clean,
    fetchExport,
    annotatedText,
    domDocument,
    unmappedDocument,
    read,
    EXPORTED_NOTICE,
    ANNOTATED_NOTICE,
  };
})(globalThis.__readAloud);
