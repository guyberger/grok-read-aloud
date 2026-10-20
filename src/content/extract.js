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

  // Dropped only when reading a whole page. An explicit selection inside a
  // sidebar is still something the user asked to hear.
  const CHROME_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "DIALOG"]);

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

  function visible(element, cache) {
    if (cache.has(element)) return cache.get(element);
    let result = true;
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
      result = false;
    } else if (typeof element.checkVisibility === "function") {
      result = element.checkVisibility({ checkVisibilityCSS: true });
    } else {
      const style = getComputedStyle(element);
      result = style.display !== "none" && style.visibility !== "hidden";
    }
    cache.set(element, result);
    return result;
  }

  function textWeight(element) {
    let total = 0;
    let linked = 0;
    for (const node of element.querySelectorAll("p, li, h1, h2, h3, h4, blockquote")) {
      total += node.textContent.length;
    }
    for (const node of element.querySelectorAll("a")) linked += node.textContent.length;
    return total - linked * 1.5;
  }

  /** Best guess at the article body, falling back to <body>. */
  function findMainContent() {
    let best = null;
    let bestScore = 0;
    for (const selector of MAIN_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const score = textWeight(element);
        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }
    }
    if (best && bestScore > 400) return best;

    for (const element of document.body?.querySelectorAll("div, section, td") ?? []) {
      if (element.querySelectorAll("p").length < 3) continue;
      const score = textWeight(element);
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

  function collectTextNodes(root, range, dropChrome) {
    const cache = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
          if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (dropChrome && CHROME_TAGS.has(el.tagName) && el !== root) return NodeFilter.FILTER_REJECT;
          if (!visible(el, cache)) return NodeFilter.FILTER_REJECT;
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

  /**
   * @param {"page"|"selection"} scope
   * @returns {{text, charNodes, charOffsets, slices, scope}|null}
   */
  function extract(scope) {
    const range = scope === "selection" ? activeSelectionRange() : null;
    if (scope === "selection" && !range) return null;

    let root;
    if (range) {
      root = range.commonAncestorContainer;
      if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
    } else {
      root = findMainContent();
    }
    if (!root) return null;

    const slices = collectTextNodes(root, range, !range);
    if (!slices.length) return null;

    const built = buildText(slices);
    if (!built.text.trim()) return null;
    return { ...built, slices, scope: range ? "selection" : "page" };
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
