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
    if (style.contentVisibility === "hidden") return false;
    // Still in the tree, and none of the checks above notice it, but not on
    // the page. See `takenOutOfSight`.
    return !takenOutOfSight(element, style);
  }

  /**
   * Whether the element is in the tree but not on the page.
   *
   * `display`, `visibility` and the `hidden` attribute are the easy cases, and
   * they are not how a page hides a label while leaving it for assistive
   * technology. Those recipes set none of them:
   *
   * - a one-pixel box, absolutely positioned, with the overflow clipped,
   *   often with `clip: rect(0, 0, 0, 0)` as well
   * - `clip-path: inset(50%)` or `circle(0)`, which leave no ink
   * - a box parked entirely off the page (`left: -9999px` is the old form)
   * - `opacity: 0`
   *
   * Reading them speaks "skip to content" and the other labels a page hides
   * from everyone looking at it. A `clip` only counts on a positioned
   * element, because that is the only time the property does anything.
   * `content-visibility: auto` and a line clamp are the opposite — text that
   * is still the page, just not all painted at once — and neither matches
   * anything here.
   */
  function takenOutOfSight(element, style) {
    if (Number.parseFloat(style.opacity) === 0) return true;
    if (clipPathHides(style.clipPath)) return true;
    if (style.position !== "absolute" && style.position !== "fixed") return false;
    if (clipHides(style.clip)) return true;
    if (parkedOutside(element, style)) return true;
    if (!overflowClips(style)) return false;
    const width = cssPx(style.width);
    const height = cssPx(style.height);
    // Both axes, so a hairline rule is not mistaken for a hidden paragraph.
    // The screen-reader-only box is one pixel by one pixel.
    return width !== null && height !== null && width <= 1 && height <= 1;
  }

  function cssPx(value) {
    if (!value || !value.endsWith("px")) return null;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  function overflowClips(style) {
    const clips = (value) => value === "hidden" || value === "clip";
    return clips(style.overflowX) && clips(style.overflowY);
  }

  /** `rect()` whose box is at most a pixel in both directions. */
  function clipHides(clip) {
    if (!clip || clip === "auto") return false;
    const match = /^rect\(\s*([-\d.]+)px[\s,]+([-\d.]+)px[\s,]+([-\d.]+)px[\s,]+([-\d.]+)px\s*\)$/.exec(clip);
    if (!match) return false;
    const top = Number(match[1]);
    const right = Number(match[2]);
    const bottom = Number(match[3]);
    const left = Number(match[4]);
    return Math.abs(right - left) <= 1 && Math.abs(bottom - top) <= 1;
  }

  /**
   * A clip-path that leaves nothing painted. Percentages only: a pixel inset
   * needs the box it is cutting, and the recipes in use are written in
   * percentages and a zero radius.
   */
  function clipPathHides(clipPath) {
    if (!clipPath || clipPath === "none") return false;
    const inset = /^inset\(\s*([^)]+)\)$/.exec(clipPath.trim());
    if (inset) {
      const parts = inset[1].trim().split(/\s+/);
      if (parts.length < 1 || parts.length > 4) return false;
      // A bare `0` computes to `0px`. Anything else in pixels needs the box
      // it cuts, which this does not have, so it is left alone.
      const n = parts.map(insetPercent);
      if (n.some((part) => part === null)) return false;
      const top = n[0];
      const right = n.length > 1 ? n[1] : n[0];
      const bottom = n.length > 2 ? n[2] : n[0];
      const left = n.length > 3 ? n[3] : right;
      // Either axis closing leaves no ink. `inset(50%)` closes both;
      // `inset(50% 0)` closes only the block axis and is just as blank.
      return top + bottom >= 100 || left + right >= 100;
    }
    const circle = /^circle\(\s*([-\d.]+)(px|%)\b/.exec(clipPath.trim());
    if (circle) return Number.parseFloat(circle[1]) <= 0;
    return false;
  }

  /** A percentage, or 0 for a zero length. Null when the value needs a box. */
  function insetPercent(part) {
    if (part.endsWith("%")) {
      const n = Number.parseFloat(part);
      return Number.isFinite(n) ? n : null;
    }
    if (/^0([a-z]+)?$/.test(part)) return 0;
    return null;
  }

  /**
   * Whether a positioned box lies entirely off the page.
   *
   * Fixed boxes are compared with the viewport, which is what they are
   * positioned against. Everything else is compared with the document: a
   * paragraph scrolled out of the window is still the page, and negative
   * overflow — the `left: -9999px` label — is not, because nothing scrolls
   * there. A few pixels of overlap is a design hanging off its container
   * and stays.
   */
  function parkedOutside(element, style) {
    const rect = element.getBoundingClientRect();
    const slop = 8;
    if (style.position === "fixed") {
      return (
        rect.bottom < -slop ||
        rect.right < -slop ||
        rect.top > window.innerHeight + slop ||
        rect.left > window.innerWidth + slop
      );
    }
    const top = rect.top + window.scrollY;
    const left = rect.left + window.scrollX;
    return top + rect.height < -slop || left + rect.width < -slop;
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

  /**
   * A citation mark and nothing else: `[1]`, `[note 2]`, `(3)`, `1,2`, `†`.
   *
   * The brackets and the dagger are how a page points at a note without
   * putting the note in the sentence. A bare number is included too, because
   * the same mark is often written that way — callers still have to tell it
   * from an exponent, which is written with the same digits.
   */
  const CITE_MARK =
    /^(?:(?:\[(?:(?:notes?|fn|ref)\.?)?(?:\d+[a-z]?(?:[-–—]\d+[a-z]?)?|[a-z]{1,2})\]|\((?:(?:notes?|fn|ref)\.?)?\d+[a-z]?(?:[-–—]\d+[a-z]?)?\)|\d+(?:[-–—]\d+)?[a-z]?|[*†‡§¶‖※^↑↩←]+)[,;]?)+$/iu;

  /** Class and id tokens pages actually use for a reference, not a container. */
  const CITE_CLASS =
    /(?:^|[\s_-])(?:footnote|footnotes|endnote|endnotes|fnref|cite|cites|citation|citations|noteref|reference|references)(?=$|[\s_:-]|\d)/i;

  const CITE_ROLES = new Set(["doc-noteref", "doc-endnoteref"]);

  function compactText(element) {
    return element.textContent.replace(/\s+/gu, "");
  }

  function isCitationMark(text) {
    return Boolean(text) && text.length <= 32 && CITE_MARK.test(text);
  }

  /**
   * Brackets, parentheses, daggers and a run of marks. A bare `2` is absent
   * on purpose: `mc²` is a superscript digit too, and the two cannot be told
   * apart from the characters alone.
   */
  function isDecoratedMark(text) {
    if (text.startsWith("[") || text.startsWith("(")) return true;
    if (/^[*†‡§¶‖※^↑↩←]+$/u.test(text)) return true;
    return /[,;]/.test(text);
  }

  function hasCitationClass(element) {
    return CITE_CLASS.test(`${element.getAttribute("class") || ""} ${element.id || ""}`);
  }

  function couldBeMarker(element) {
    if (CITE_ROLES.has(element.getAttribute("role"))) return true;
    const tag = element.tagName;
    if (tag === "SUP" || tag === "SUB" || tag === "A") return true;
    // A span is a marker only when the page has already labelled it as one.
    // Treating every span as a candidate would ask for the text of whatever
    // wrapper a site had put around the article.
    if (tag === "SPAN" || tag === "CITE") return hasCitationClass(element);
    return false;
  }

  /**
   * Whether this element is a citation marker rather than a word.
   *
   * The note at the bottom of the page is ordinary prose and is read when
   * the voice gets there. The mark in the sentence — the `[1]` after a
   * clause — is not part of the clause, and speaking it says "left bracket
   * one right bracket" in the middle of a thought.
   *
   * A bare superscript digit is kept. Nothing else about it says "footnote",
   * and dropping it would turn `mc²` into `mc`.
   */
  function marksCitation(element) {
    if (!couldBeMarker(element) || element.childElementCount > 8) return false;
    const compact = compactText(element);
    if (!isCitationMark(compact)) return false;
    if (CITE_ROLES.has(element.getAttribute("role")) || hasCitationClass(element)) return true;
    if (isDecoratedMark(compact)) return true;

    const link = element.tagName === "A" ? element : element.querySelector("a[href]");
    if (!link) return false;
    const href = link.getAttribute("href") || "";
    // A number that links at a fragment, or that a superscript exists only
    // to carry, is a note. The same number with nowhere to go is an exponent.
    if (href.startsWith("#")) return true;
    if (element.tagName === "SUP" || element.tagName === "SUB") return true;
    const parent = link.parentElement?.tagName;
    return parent === "SUP" || parent === "SUB";
  }

  /** Whether a text node's element sits inside a citation marker. Memoised. */
  function inCitation(element, root, cache) {
    for (let current = element; current && current !== root.parentElement; current = current.parentElement) {
      let known = cache.get(current);
      if (known === undefined) cache.set(current, (known = marksCitation(current)));
      if (known) return true;
    }
    return false;
  }

  const WORD_CHAR = /\p{L}|\p{N}/u;

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

  function collectTextNodes(root, range, chromeTags, cache = new Map(), { readCodeBlocks = false, skipCitations = true } = {}) {
    // Asking the layout costs a style resolve, and a page of API docs has a
    // great many `<code>` elements, so each one is asked once per walk.
    const codeBlocks = new Map();
    const inCodeBlock = (element) => {
      let known = codeBlocks.get(element);
      if (known === undefined) codeBlocks.set(element, (known = isCodeBlock(element)));
      return known;
    };
    const citations = new Map();

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
      if (clipped) {
        slices.push({
          node,
          start: clipped[0],
          end: clipped[1],
          // Kept as a slice so the words on either side stay apart, and so a
          // mark sitting against a comma does not grow a space of its own.
          // Nothing in it is spoken.
          gap: skipCitations && inCitation(node.parentElement, root, citations),
        });
      }
      node = walker.nextNode();
    }
    return slices;
  }

  /** First character a slice would actually speak, ignoring its own spaces. */
  function firstSolidChar(slice) {
    const data = slice.node.data;
    for (let offset = slice.start; offset < slice.end; offset += 1) {
      const char = data[offset];
      if (!ns.util.isWhitespace(char)) return char;
    }
    return "";
  }

  /** The next character that will be spoken after `index`, skipping markers. */
  function nextSpokenChar(slices, index) {
    for (let i = index + 1; i < slices.length; i += 1) {
      if (slices[i].gap) continue;
      const char = firstSolidChar(slices[i]);
      if (char) return char;
    }
    return "";
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
      if (slice.gap) {
        // The mark is not spoken. Between two words it still has to leave
        // them apart — `pond[1]lasts` is "pond lasts" — and against punctuation
        // it has to leave no space, so `water[1],` stays "water,".
        const previous = chars.length ? chars[chars.length - 1] : "";
        const next = nextSpokenChar(slices, sliceIndex);
        if (previous && next && WORD_CHAR.test(previous) && WORD_CHAR.test(next)) pendingSpace = true;
        continue;
      }
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
   * @param {{readCodeBlocks?: boolean, skipCitations?: boolean, root?: Element}} options
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
      // A selection of nothing but a snippet, or nothing but a citation
      // marker, is still text the user picked out and asked to hear, and
      // silence is not an answer to that — so a selection the filters would
      // empty is read with both set aside.
      const built =
        root &&
        (buildFrom(root, range, null, new Map(), options) ??
          buildFrom(root, range, null, new Map(), { readCodeBlocks: true, skipCitations: false }));
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

  /**
   * The offset of the character of `node` drawn under (x, y) — the one after
   * the caret or the one before it — or -1 when the point is on neither.
   *
   * The caret APIs answer a different question: they snap to the nearest
   * caret position wherever the point is, so the blank end of a short line,
   * the gap between two paragraphs and the padding around them all come back
   * as text. Taken on their own they make all of that blank space clickable,
   * and the cursor promise it. A point counts as on a character when it is
   * inside the box the character is drawn in, stretched to the full height of
   * its line so the leading between two lines of a paragraph is not a hole.
   */
  function characterAt(node, offset, x, y) {
    const length = node.data.length;
    const range = document.createRange();
    const lineHeight = parseFloat(getComputedStyle(node.parentElement ?? document.body).lineHeight);
    for (const start of [offset, offset - 1]) {
      if (start < 0 || start >= length) continue;
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      for (const rect of range.getClientRects()) {
        const leading = Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - rect.height) / 2) : 0;
        if (
          x >= rect.left - HIT_SLOP_PX &&
          x <= rect.right + HIT_SLOP_PX &&
          y >= rect.top - leading - HIT_SLOP_PX &&
          y <= rect.bottom + leading + HIT_SLOP_PX
        ) {
          return start;
        }
      }
    }
    return -1;
  }

  /** Sub-pixel rounding at a glyph's edge should not make it a hole. */
  const HIT_SLOP_PX = 1;

  /**
   * Index into `doc.text` of the character under a viewport point, or -1 if
   * the point is not on a character being read — off the text altogether, or
   * on blank space inside the element it came from.
   */
  function charIndexFromPoint(doc, x, y) {
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return -1;
    const at = characterAt(caret.node, caret.offset, x, y);
    if (at < 0) return -1;
    return charIndexAt(doc, caret.node, at);
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
