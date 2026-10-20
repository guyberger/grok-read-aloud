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
    "CODE",
    "PRE",
  ]);

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

  function collectTextNodes(root, range, chromeTags, cache = new Map()) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        // `visible` walks past the root as well, so a root that sits inside a
        // hidden container yields nothing rather than hidden text.
        if (!parent || !visible(parent, cache)) return NodeFilter.FILTER_REJECT;
        for (let el = parent; el && el !== root.parentElement; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
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

  function buildFrom(root, range, chromeTags, cache) {
    const slices = collectTextNodes(root, range, chromeTags, cache);
    if (!slices.length) return null;
    const built = buildText(slices);
    if (!built.text.trim()) return null;
    return { ...built, slices };
  }

  /**
   * @param {"page"|"selection"} scope
   * @returns {{text, charNodes, charOffsets, slices, scope}|null}
   */
  function extract(scope) {
    const range = scope === "selection" ? activeSelectionRange() : null;
    if (scope === "selection" && !range) return null;

    if (range) {
      let root = range.commonAncestorContainer;
      if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
      const built = root && buildFrom(root, range, null);
      return built ? { ...built, scope: "selection" } : null;
    }

    const body = document.body;
    if (!body) return null;

    const cache = new Map();
    const root = findMainContent(cache);
    let built = root && root !== body ? buildFrom(root, null, CONTENT_CHROME_TAGS, cache) : null;

    // Picking the article body is a guess, and a guess that comes back nearly
    // empty is worth abandoning. Every visible word in the body minus the page
    // furniture reads worse than a clean article, and far better than silence.
    if (!built || built.text.trim().length < MIN_PAGE_CHARS) {
      const fallback = buildFrom(body, null, PAGE_CHROME_TAGS, cache);
      if (fallback && fallback.text.trim().length > (built?.text.trim().length ?? 0)) built = fallback;
    }

    return built ? { ...built, scope: "page" } : null;
  }

  /** DOM Range covering global character indices [start, end). */
  function rangeFor(doc, start, end) {
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

  ns.extract = { extract, rangeFor, findMainContent };
})(globalThis.__readAloud);
