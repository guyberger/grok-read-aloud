(function (ns) {
  "use strict";

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "IFRAME",
    "SVG",
    "CANVAS",
    "VIDEO",
    "AUDIO",
    "OBJECT",
    "EMBED",
    "SELECT",
    "TEXTAREA",
    "INPUT",
    "BUTTON",
  ]);

  // Code is not skipped by tag name, because the same two tags cover two very
  // different things: see `isCodeBlock`.
  const CODE_TAGS = new Set(["PRE", "CODE"]);

  // Page furniture, dropped when reading a whole page without a trustworthy
  // content container. An explicit selection inside a sidebar is still
  // something the user asked to hear, so selections drop nothing.
  const PAGE_CHROME_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "DIALOG"]);

  // Inside a container we already believe is the article, a <header> is the
  // article's own masthead and holds its title, so it is worth reading. A
  // sidebar or a footer in there is still a sidebar or a footer.
  const CONTENT_CHROME_TAGS = new Set(["NAV", "FOOTER", "ASIDE", "FORM", "DIALOG"]);

  // Below this, a whole-page read is treated as a failed guess rather than a
  // short page, and the body is read instead.
  const MIN_PAGE_CHARS = 200;

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
    "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "TD", "TH", "TR", "UL",
  ]);

  const MAIN_SELECTORS = [
    "article",
    "[role='main']",
    "main",
    "[itemprop='articleBody']",
    ".post-content",
    ".article-content",
    ".entry-content",
    "#content",
  ];

  /**
   * Whether the element renders, ignoring its ancestors.
   *
   * `Element.checkVisibility` is deliberately not used. It reports any element
   * without a layout box as invisible, which includes `display: contents`
   * wrappers — whose children render perfectly well, and which component
   * frameworks emit freely. Treating one as hidden silently drops everything
   * underneath it.
   */
  function selfRendered(element) {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    // `content-visibility: auto` only skips painting what is offscreen; that
    // text is still part of the page. Only `hidden` takes it out.
    return style.contentVisibility !== "hidden";
  }

  /**
   * Whether this element is a code *block* rather than code written into a
   * sentence.
   *
   * The distinction matters because the two read completely differently. A
   * snippet is punctuation and indentation and rarely makes sense aloud, but
   * `autoCommit` in the middle of a sentence is the subject of that sentence —
   * dropping it leaves "set to false", which says something else entirely.
   *
   * Which one a `<code>` is cannot be told from the markup: the same tag holds
   * both, and the page decides by laying one out as a block and the other in
   * the run of text. So the layout is what gets asked, the same way visibility
   * is. `<pre>` needs no asking.
   */
  function isCodeBlock(element) {
    if (element.tagName === "PRE") return true;
    const display = getComputedStyle(element).display;
    return !display.startsWith("inline") && display !== "contents";
  }

  /** Whether the element renders, ancestors included. Memoised per walk. */
  function visible(element, cache) {
    const pending = [];
    let current = element;
    let result = true;
    while (current) {
      const cached = cache.get(current);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      pending.push(current);
      if (!selfRendered(current)) {
        result = false;
        break;
      }
      current = current.parentElement;
    }
    for (const node of pending) cache.set(node, result);
    return result;
  }

  function textWeight(element, cache) {
    let total = 0;
    let linked = 0;
    for (const node of element.querySelectorAll("p, li, h1, h2, h3, h4, blockquote")) {
      if (visible(node, cache)) total += node.textContent.length;
    }
    for (const node of element.querySelectorAll("a")) {
      if (visible(node, cache)) linked += node.textContent.length;
    }
    return total - linked * 1.5;
  }

  /**
   * Best guess at the article body, falling back to <body>.
   *
   * Only rendered candidates are scored. A single-page app routinely leaves
   * the previous route's markup in the document with `display: none`, and that
   * copy often holds more text than the page actually on screen — an index of
   * every post beats one post. Scoring it would hand back a container whose
   * every text node is then correctly rejected as hidden, which reads as "no
   * text on this page".
   */
  function findMainContent(cache = new Map()) {
    let best = null;
    let bestScore = 0;
    for (const selector of MAIN_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element, cache)) continue;
        const score = textWeight(element, cache);
        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }
    }
    if (best && bestScore > 400) return best;

    for (const element of document.body?.querySelectorAll("div, section, td") ?? []) {
      if (element.querySelectorAll("p").length < 3) continue;
      if (!visible(element, cache)) continue;
      const score = textWeight(element, cache);
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return bestScore > 400 ? best : document.body;
  }

  function blockAncestor(node) {
    let current = node.parentElement;
    while (current && !BLOCK_TAGS.has(current.tagName)) current = current.parentElement;
    return current || document.body;
  }

  function clipToSelection(node, range) {
    const length = node.data.length;
    if (!range) return [0, length];
    if (!range.intersectsNode(node)) return null;
    let start = 0;
    let end = length;
    if (node === range.startContainer) start = Math.min(range.startOffset, length);
    if (node === range.endContainer) end = Math.min(range.endOffset, length);
    return end > start ? [start, end] : null;
  }

  function collectTextNodes(root, range, chromeTags, cache = new Map(), { readCodeBlocks = false } = {}) {
    // Asking the layout costs a style resolve, and a page of API docs has a
    // great many `<code>` elements, so each one is asked once per walk.
    const codeBlocks = new Map();
    const inCodeBlock = (element) => {
      let known = codeBlocks.get(element);
      if (known === undefined) codeBlocks.set(element, (known = isCodeBlock(element)));
      return known;
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        // `visible` walks past the root as well, so a root that sits inside a
        // hidden container yields nothing rather than hidden text.
        if (!parent || !visible(parent, cache)) return NodeFilter.FILTER_REJECT;
        for (let el = parent; el && el !== root.parentElement; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (!readCodeBlocks && CODE_TAGS.has(el.tagName) && inCodeBlock(el)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (chromeTags?.has(el.tagName) && el !== root) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const slices = [];
    let node = walker.nextNode();
    while (node) {
      const clipped = clipToSelection(node, range);
      if (clipped) slices.push({ node, start: clipped[0], end: clipped[1] });
      node = walker.nextNode();
    }
    return slices;
  }

  /**
   * Flatten the page into one whitespace-normalised string plus a per-character
   * map back to (text node, offset), so any character range can become a DOM
   * Range later without re-walking the tree.
   */
  function buildText(slices) {
    const chars = [];
    const charNodes = [];
    const charOffsets = [];
    let pendingSpace = false;
    let previousBlock = null;

    const pushSynthetic = (char) => {
      chars.push(char);
      charNodes.push(-1);
      charOffsets.push(-1);
    };

    for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
      const slice = slices[sliceIndex];
      const block = blockAncestor(slice.node);
      if (previousBlock && block !== previousBlock && chars.length) {
        while (chars.length && ns.util.isWhitespace(chars[chars.length - 1])) {
          chars.pop();
          charNodes.pop();
          charOffsets.pop();
        }
        pushSynthetic("\n");
        pendingSpace = false;
      }
      previousBlock = block;

      const data = slice.node.data;
      for (let offset = slice.start; offset < slice.end; offset += 1) {
        const char = data[offset];
        if (ns.util.isWhitespace(char)) {
          pendingSpace = chars.length > 0;
          continue;
        }
        if (pendingSpace) {
          chars.push(" ");
          charNodes.push(sliceIndex);
          charOffsets.push(offset);
          pendingSpace = false;
        }
        chars.push(char);
        charNodes.push(sliceIndex);
        charOffsets.push(offset);
      }
    }

    while (chars.length && ns.util.isWhitespace(chars[chars.length - 1])) {
      chars.pop();
      charNodes.pop();
      charOffsets.pop();
    }

    return {
      text: chars.join(""),
      charNodes: Int32Array.from(charNodes),
      charOffsets: Int32Array.from(charOffsets),
    };
  }

  function activeSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return range.toString().trim() ? range : null;
  }

  function buildFrom(root, range, chromeTags, cache, options) {
    const slices = collectTextNodes(root, range, chromeTags, cache, options);
    if (!slices.length) return null;
    const built = buildText(slices);
    if (!built.text.trim()) return null;
    return { ...built, slices };
  }

  /**
   * @param {"page"|"selection"} scope
   * @param {{readCodeBlocks?: boolean, root?: Element}} options
   *   `root` names the container to read, for a caller that already knows
   *   where the text is — the Google Docs editor, say. Nothing is guessed and
   *   nothing falls back to the body: a named container that holds no text is
   *   an answer, and its caller has somewhere else to look.
   * @returns {{text, charNodes, charOffsets, slices, root, scope, mapped}|null}
   */
  function extract(scope, { readCodeBlocks = false, root: given = null } = {}) {
    const options = { readCodeBlocks };
    const range = scope === "selection" ? activeSelectionRange() : null;
    if (scope === "selection" && !range) return null;

    if (given && !range) {
      const built = buildFrom(given, null, CONTENT_CHROME_TAGS, new Map(), options);
      return built ? { ...built, root: given, scope: "page", mapped: true } : null;
    }

    if (range) {
      let root = range.commonAncestorContainer;
      if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
      // A selection of nothing but a snippet is still text the user picked out
      // and asked to hear, and silence is not an answer to that — so a
      // selection the setting would empty is read with the setting set aside.
      const built =
        root &&
        (buildFrom(root, range, null, new Map(), options) ??
          buildFrom(root, range, null, new Map(), { readCodeBlocks: true }));
      return built ? { ...built, root, scope: "selection", mapped: true } : null;
    }

    const body = document.body;
    if (!body) return null;

    const cache = new Map();
    const main = findMainContent(cache);
    let root = main && main !== body ? main : null;
    let built = root ? buildFrom(root, null, CONTENT_CHROME_TAGS, cache, options) : null;

    // Picking the article body is a guess, and a guess that comes back nearly
    // empty is worth abandoning. Every visible word in the body minus the page
    // furniture reads worse than a clean article, and far better than silence.
    if (!built || built.text.trim().length < MIN_PAGE_CHARS) {
      const fallback = buildFrom(body, null, PAGE_CHROME_TAGS, cache, options);
      if (fallback && fallback.text.trim().length > (built?.text.trim().length ?? 0)) {
        built = fallback;
        root = body;
      }
    }

    // The element the text came out of, which is the region a click can land
    // in. It is what the reader marks while a read is running, so the pointer
    // can say the words under it are clickable.
    //
    // `mapped` says every character has a text node behind it, which is true
    // of anything that came out of this walk and false of text fetched from
    // elsewhere — see `docs.js`.
    return built ? { ...built, root: root ?? body, scope: "page", mapped: true } : null;
  }

  /**
   * The per-character map read backwards: which characters of `doc.text` came
   * out of each slice. Built on first use, since only click-to-jump needs it.
   *
   * `charNodes` cannot simply be searched, because the synthetic paragraph
   * breaks carry -1 and the trailing-whitespace trim can shorten a slice's
   * run after the fact. One pass over the finished arrays settles both.
   */
  function reverseIndex(doc) {
    if (doc.reverse) return doc.reverse;
    const spans = new Map();
    for (let i = 0; i < doc.charNodes.length; i += 1) {
      const slice = doc.charNodes[i];
      if (slice < 0) continue;
      const span = spans.get(slice);
      if (span) span[1] = i;
      else spans.set(slice, [i, i]);
    }
    // The walk visits each text node once, so a node belongs to one slice.
    const byNode = new Map();
    for (let i = 0; i < doc.slices.length; i += 1) {
      if (!byNode.has(doc.slices[i].node)) byNode.set(doc.slices[i].node, i);
    }
    doc.reverse = { spans, byNode };
    return doc.reverse;
  }

  /**
   * Index into `doc.text` for a (text node, offset) pair, or -1 when that
   * node is not part of what is being read.
   */
  function charIndexAt(doc, node, offset) {
    if (!doc?.slices?.length || !node) return -1;
    const { spans, byNode } = reverseIndex(doc);
    const sliceIndex = byNode.get(node);
    const span = sliceIndex === undefined ? null : spans.get(sliceIndex);
    if (!span) return -1;

    const slice = doc.slices[sliceIndex];
    const wanted = Math.min(Math.max(offset, slice.start), slice.end - 1);

    // Offsets rise across a slice's characters, with the separating space
    // sharing the offset of the character it precedes — so the last entry at
    // or before `wanted` is the character itself rather than that space.
    let low = span[0];
    let high = span[1];
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (doc.charOffsets[mid] <= wanted) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    // Before the first character this slice kept — leading whitespace, say —
    // the nearest thing the reader can speak is that first character.
    return found >= 0 ? found : span[0];
  }

  /** The text node and offset under a viewport point, across both APIs. */
  function caretAt(x, y) {
    if (typeof document.caretPositionFromPoint === "function") {
      const position = document.caretPositionFromPoint(x, y);
      if (position?.offsetNode) return { node: position.offsetNode, offset: position.offset };
    }
    // WebKit, and Chrome before 128, only have the older spelling.
    if (typeof document.caretRangeFromPoint === "function") {
      const range = document.caretRangeFromPoint(x, y);
      if (range) return { node: range.startContainer, offset: range.startOffset };
    }
    return null;
  }

  /** Index into `doc.text` under a viewport point, or -1 if it is not read. */
  function charIndexFromPoint(doc, x, y) {
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return -1;
    return charIndexAt(doc, caret.node, caret.offset);
  }

  /**
   * DOM Range covering global character indices [start, end), or null when
   * those characters are in no node of the page — text fetched from somewhere
   * else, which is how a canvas-drawn Google Doc is read.
   */
  function rangeFor(doc, start, end) {
    if (!doc?.slices?.length) return null;
    const { charNodes, charOffsets, slices } = doc;
    let from = start;
    while (from < end && charNodes[from] < 0) from += 1;
    let to = end - 1;
    while (to >= from && charNodes[to] < 0) to -= 1;
    if (from > to) return null;

    const range = document.createRange();
    try {
      range.setStart(slices[charNodes[from]].node, charOffsets[from]);
      range.setEnd(slices[charNodes[to]].node, charOffsets[to] + 1);
    } catch {
      return null;
    }
    return range;
  }

  ns.extract = { extract, rangeFor, findMainContent, isCodeBlock, charIndexAt, charIndexFromPoint };
})(globalThis.__readAloud);
