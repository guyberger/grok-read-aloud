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

  // The same furniture written as a landmark on a div, which is how a page
  // that never used the element still marks it. `search` has no element of
  // its own; it is the landmark a search form gets. `alertdialog` is a dialog.
  // The first token of `role` is the one the page gave it.
  const CHROME_ROLES = new Set([
    "banner",
    "navigation",
    "contentinfo",
    "complementary",
    "search",
    "form",
    "dialog",
    "alertdialog",
  ]);

  // The reading written above a word, and the parentheses a page shows when
  // ruby is not laid out. The word is the base. Speaking the reading too says
  // the word and then its pronunciation, and a reading on each character
  // interleaves the two so neither can be followed.
  const RUBY_ANNOTATION = new Set(["RT", "RP", "RTC"]);

  // Below this, a whole-page read is treated as a failed guess rather than a
  // short page, and the body is read instead.
  const MIN_PAGE_CHARS = 200;

  /** The landmark role on `element`, or "" when it has none. */
  function landmarkRole(element) {
    const raw = element.getAttribute("role");
    if (!raw) return "";
    return raw.trim().toLowerCase().split(/\s+/)[0] || "";
  }

  /**
   * Whether `element` is page furniture for this read.
   *
   * Tags and landmark roles name the same things. A `<header>` inside the
   * article is the exception the tag list already makes: it holds the title,
   * and a template that also called it a banner has not turned the title
   * into a site header. A banner that is not a header is the site header
   * either way. Selections pass no chrome set and drop nothing.
   */
  function marksChrome(element, tag, chromeTags) {
    if (!chromeTags) return false;
    if (chromeTags.has(tag)) return true;
    const role = landmarkRole(element);
    if (!role || !CHROME_ROLES.has(role)) return false;
    if (role === "banner" && tag === "HEADER" && chromeTags === CONTENT_CHROME_TAGS) return false;
    return true;
  }

  function isElementNode(node) {
    return node?.nodeType === Node.ELEMENT_NODE;
  }

  /**
   * Parent in the flat tree.
   *
   * A node assigned to a slot is rendered there. A node whose parent is a
   * shadow root is rendered inside the host. Otherwise the parent is the
   * element parent, which is all a light-DOM page has ever had.
   */
  function flatParent(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    const parent = node.parentNode;
    if (!parent) return null;
    if (parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && parent.host) return parent.host;
    return isElementNode(parent) ? parent : null;
  }

  /** Whether `node` sits inside `ancestor` once slots and shadow roots are flattened. */
  function flatContains(ancestor, node) {
    if (!ancestor || !node) return false;
    for (let current = node; current; current = flatParent(current)) {
      if (current === ancestor) return true;
    }
    return false;
  }

  /**
   * Rendered children, in order.
   *
   * An open shadow root replaces the host's light children. A slot contributes
   * the nodes it shows — its assigned nodes, or its fallback when nothing is
   * assigned. Light children of a shadow host are reached only through a
   * slot, so a node the shadow does not show is not visited. A closed shadow
   * root cannot be seen (`shadowRoot` is null); its light children are walked
   * as they always were.
   */
  function composedKids(node) {
    if (!node) return [];
    if (isElementNode(node) && node.tagName === "SLOT") {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return [...assigned];
      return expandSlots(node);
    }
    if (isElementNode(node) && node.shadowRoot) return composedKids(node.shadowRoot);
    return expandSlots(node);
  }

  function expandSlots(node) {
    const kids = [];
    const list = node.childNodes;
    if (!list) return kids;
    for (let i = 0; i < list.length; i += 1) {
      const child = list[i];
      if (isElementNode(child) && child.tagName === "SLOT") kids.push(...composedKids(child));
      else kids.push(child);
    }
    return kids;
  }

  /**
   * Visit `root`'s rendered descendants, parents before children.
   * Returning false from `visit` skips that node's subtree.
   */
  function walkComposed(root, visit) {
    const stack = [];
    const push = (kids) => {
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    };
    push(composedKids(root));
    while (stack.length) {
      const node = stack.pop();
      if (visit(node) === false) continue;
      if (node.nodeType === Node.TEXT_NODE) continue;
      push(composedKids(node));
    }
  }

  function composedFirst(node) {
    const kids = composedKids(node);
    return kids.length ? kids[0] : null;
  }

  /** Whether `element` or a descendant hosts an open shadow root. */
  function hasOpenShadow(element) {
    if (!isElementNode(element)) return false;
    if (element.shadowRoot) return true;
    for (const host of element.querySelectorAll("*")) {
      if (host.shadowRoot) return true;
    }
    return false;
  }

  // A box this small, on an axis it clips, shows nothing. The same threshold
  // as a screen-reader-only box: a hairline can be a rule, and a line clamp
  // is many times this.
  const COLLAPSED_PX = 1;

  // Whether a box clips to nothing. Reset on every extract: opening a panel
  // changes the answer, and a cached rect would keep the panel shut.
  let clipCache = new WeakMap();

  // DETAILS and SUMMARY are blocks so a folded question does not run on into
  // the next one, and an open answer does not run on from its summary.
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL",
    "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
    "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "SUMMARY", "TABLE", "TD", "TH", "TR", "UL",
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
   * underneath it. A closed disclosure is decided separately, in
   * `disclosureHides`, because the folded answer still has a box. A box
   * collapsed to nothing is decided in `collapsedHides`, because a fixed bar
   * drawn out of that box is still on the page.
   */
  function selfRendered(element) {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    if (disclosureHides(element)) return false;
    if (collapsedHides(element)) return false;
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

  /**
   * Whether this node is the folded part of a disclosure.
   *
   * A closed `<details>` keeps its answer in the tree as an ordinary block.
   * `display`, `visibility` and the box size all still say it is there — the
   * summary is a normal line, and the answer is a normal paragraph the
   * browser has simply not rendered. Reading it speaks a paragraph the page
   * is still holding back, and pays for the characters.
   *
   * The first `<summary>` child is the part on the page. A second summary is
   * not: the browser shows one label. Text parented by the `<details>` itself
   * is the answer, not the label, which is why a text node has to be asked
   * and not only its parent — the disclosure element is on the page, because
   * it draws the summary. Opening it renders the rest. A disclosure inside
   * one that is still closed is folded with it, summary included.
   */
  function disclosureHides(node) {
    const element = isElementNode(node) ? node : flatParent(node);
    if (!element) return false;
    for (
      let details = element.tagName === "DETAILS" ? element : flatParent(element);
      details;
      details = flatParent(details)
    ) {
      if (!isElementNode(details) || details.tagName !== "DETAILS" || details.open) continue;
      const summary = disclosureSummary(details);
      // `contains` stops at a shadow boundary, so a summary drawn in a shadow
      // root is asked in the flat tree instead.
      if (summary && flatContains(summary, node)) continue;
      // The disclosure element itself stays. Hiding it would hide its summary,
      // which is the one line actually on the page.
      if (node !== details) return true;
    }
    return false;
  }

  /** The summary the browser shows: the first rendered `<summary>` child, or none. */
  function disclosureSummary(details) {
    for (const child of composedKids(details)) {
      if (isElementNode(child) && child.tagName === "SUMMARY") return child;
    }
    return null;
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

  // Which element lays out a text node's line, and whether that element's
  // indent is large enough to push a whole line out. Reset with the clip
  // cache: changing the indent changes the answer.
  let blockOf = new WeakMap();
  let indentOf = new WeakMap();

  /**
   * Whether `display` is a block container, the box `text-indent` applies to.
   *
   * An inline sets the property and nothing happens: the indent belongs to
   * the block that lays the line out. `inline-block` is that block for its
   * own text. `display: contents` is neither, and the walk continues through
   * it.
   */
  function isBlockContainer(display) {
    return (
      display === "block" ||
      display === "flow-root" ||
      display === "inline-block" ||
      display === "inline-flex" ||
      display === "inline-grid" ||
      display === "flex" ||
      display === "grid" ||
      display === "list-item" ||
      display === "table-cell" ||
      display === "table-caption"
    );
  }

  /** The block container that lays `element`'s line out, or null. */
  function blockContainer(element) {
    const known = blockOf.get(element);
    if (known !== undefined) return known;
    let block = null;
    for (let current = element; current && block === null; current = flatParent(current)) {
      const cached = blockOf.get(current);
      if (cached !== undefined) {
        block = cached;
        break;
      }
      const display = getComputedStyle(current).display;
      if (display === "none") break;
      if (isBlockContainer(display)) block = current;
    }
    blockOf.set(element, block);
    return block;
  }

  /**
   * Whether `textIndent` is large enough that a whole line might sit outside
   * its box. A couple of ems — a first-line indent, a hanging indent — is
   * not. `100%` and a few thousand pixels are.
   *
   * Percentages come back unresolved, unlike a length in ems. They refer to
   * the width of this block, so `100%` is exactly one box wide.
   */
  function largeIndent(textIndent, width) {
    const token = (textIndent || "").trim().split(/\s+/)[0] || "";
    if (!token || token === "0" || token === "0px") return null;
    if (token.endsWith("%")) {
      const pct = Number.parseFloat(token);
      if (!Number.isFinite(pct) || Math.abs(pct) < 100) return null;
      return { negative: pct < 0 };
    }
    if (!token.endsWith("px")) return null;
    const px = Number.parseFloat(token);
    if (!Number.isFinite(px) || Math.abs(px) + 0.5 < width) return null;
    return { negative: px < 0 };
  }

  /**
   * The box that clips `block` on the inline axis, or null when nothing does.
   *
   * The search stops at a scrollport. Text inside one can be scrolled back
   * into view, and a clip outside it is the scrollport's own edge, not a
   * reason to drop the text.
   */
  function inlineClip(block) {
    for (let current = block; current; current = flatParent(current)) {
      const overflow = getComputedStyle(current).overflowX;
      if (overflow === "hidden" || overflow === "clip") return current;
      if (overflow === "auto" || overflow === "scroll") return null;
    }
    return null;
  }

  /** Resolved indent for `block`, or null when it cannot hide a line. */
  function indentInfo(block) {
    const known = indentOf.get(block);
    if (known !== undefined) return known;
    const width = block.clientWidth;
    const amount = width > 0 ? largeIndent(getComputedStyle(block).textIndent, width) : null;
    const info = amount ? { negative: amount.negative, clip: inlineClip(block) } : null;
    indentOf.set(block, info);
    return info;
  }

  /** Glyph boxes of `node`, ignoring fragments that have no ink. */
  function textRects(node) {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const rects = [];
    for (const rect of range.getClientRects()) {
      if (rect.width > 0.5 && rect.height > 0.5) rects.push(rect);
    }
    return rects;
  }

  /** Whether `rect` draws inside `box`. A pixel of slop is subpixel rounding. */
  function overlapsBox(rect, box) {
    const slop = 1;
    return (
      rect.right > box.left + slop &&
      rect.left < box.right - slop &&
      rect.bottom > box.top + slop &&
      rect.top < box.bottom - slop
    );
  }

  /**
   * Whether `node`'s glyphs have all been pushed off the page by an indent.
   *
   * `text-indent: -9999px`, and `text-indent: 100%` on a line the box clips,
   * are how a page shows a picture in place of a heading and keeps the words
   * for assistive technology. The box is a normal size, so it is not a
   * collapsed box, and the element is not positioned, so nothing above asks
   * where the glyphs went. The glyphs are what get asked.
   *
   * Every glyph outside the clip means the line is not on the page. A line
   * that reaches back into the box, and a later line the indent never
   * applied to, still have ink, and then the whole text is read — the two
   * share a node whenever the page did not split them. With no clip, only a
   * negative indent can hide anything, and only by leaving the glyphs where
   * the document does not scroll. A positive indent with nothing clipping it
   * is the line drawn beside its box, and it stays.
   */
  function indentHides(node) {
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const element = node.parentElement;
    if (!element) return false;
    const block = blockContainer(element);
    if (!block) return false;
    const info = indentInfo(block);
    if (!info) return false;
    const rects = textRects(node);
    if (!rects.length) return false;
    if (info.clip) {
      const box = info.clip.getBoundingClientRect();
      for (const rect of rects) {
        if (overlapsBox(rect, box)) return false;
      }
      return true;
    }
    if (!info.negative) return false;
    const slop = 8;
    for (const rect of rects) {
      const top = rect.top + window.scrollY;
      const left = rect.left + window.scrollX;
      if (!(top + rect.height < -slop || left + rect.width < -slop)) return false;
    }
    return true;
  }

  /**
   * Whether this node is inside a box the page has collapsed to nothing.
   *
   * A shut accordion that is not a disclosure — `max-height: 0`, `height: 0`,
   * a grid row of `0fr`, a drawer of zero width — keeps its answer in the
   * tree as an ordinary block and clips the overflow. `display`, `visibility`
   * and `opacity` all still say the answer is there. Reading it speaks a
   * paragraph the page is holding back, and pays for the characters.
   *
   * The box itself stays rendered. A fixed bar nested inside it is painted
   * on the viewport, and an absolute note escapes a clip that is not its
   * containing block; both are still the page. A line clamp and a scrollport
   * have a real box, so neither matches, and the lines they clip are read
   * in full. `display: contents` has no box at all.
   */
  function collapsedHides(node) {
    const element = isElementNode(node) ? node : node.parentElement;
    if (!element) return false;
    // A text node is in the flow of its parent, so the parent is the first
    // box that might clip it. An element is clipped only by an ancestor:
    // calling the collapsed box itself hidden would hide the fixed bar too.
    const start = isElementNode(node) ? flatParent(element) : element;
    for (let clip = start; clip; clip = flatParent(clip)) {
      if (!boxCollapsed(clip)) continue;
      if (escapesClip(element, clip)) continue;
      return true;
    }
    return false;
  }

  /** Whether `element`'s border box clips an axis down to nothing. */
  function boxCollapsed(element) {
    const known = clipCache.get(element);
    if (known !== undefined) return known;
    const style = getComputedStyle(element);
    let collapsed = false;
    if (style.display !== "contents" && style.display !== "none") {
      const clipY = style.overflowY === "hidden" || style.overflowY === "clip";
      const clipX = style.overflowX === "hidden" || style.overflowX === "clip";
      if (clipY || clipX) {
        const rect = element.getBoundingClientRect();
        collapsed = (clipY && rect.height <= COLLAPSED_PX) || (clipX && rect.width <= COLLAPSED_PX);
      }
    }
    clipCache.set(element, collapsed);
    return collapsed;
  }

  /**
   * Whether `element` is painted outside `clip`.
   *
   * Fixed boxes are painted against the viewport, and absolute boxes against
   * the nearest positioned ancestor. A collapsed box clips them only once
   * something in between — the clip included — has become their containing
   * block: a transform, a filter, a perspective, `contain: paint`, or a
   * position other than static for an absolute box. Until then the browser
   * still draws them, and they are part of the page.
   */
  function escapesClip(element, clip) {
    if (element === clip) return false;
    let mode = null;
    for (let current = element; current && current !== clip; current = flatParent(current)) {
      const position = getComputedStyle(current).position;
      if (position === "fixed") mode = "fixed";
      else if (position === "absolute" && mode !== "fixed") mode = "absolute";
    }
    if (mode !== "fixed" && mode !== "absolute") return false;
    for (let current = flatParent(element); current; current = flatParent(current)) {
      if (capturesPositioned(getComputedStyle(current), mode)) return false;
      if (current === clip) break;
    }
    return true;
  }

  /** Whether `style` makes the element a containing block for `mode`. */
  function capturesPositioned(style, mode) {
    if (mode === "absolute" && style.position !== "static") return true;
    if (style.transform && style.transform !== "none") return true;
    if (style.filter && style.filter !== "none") return true;
    if (style.perspective && style.perspective !== "none") return true;
    if (style.backdropFilter && style.backdropFilter !== "none") return true;
    const contain = style.contain || "";
    if (contain === "strict" || /\bpaint\b/.test(contain)) return true;
    const will = style.willChange || "";
    if (will.includes("transform") || will.includes("filter") || will.includes("perspective")) return true;
    return style.contentVisibility === "auto" || style.contentVisibility === "hidden";
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

  // The TeX source a `<semantics>` element carries beside the formula. It is
  // not the formula, and speaking it says "E equals m c caret 2".
  const FORMULA_NOISE = new Set(["ANNOTATION", "ANNOTATION-XML"]);

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
    const stop = flatParent(root);
    for (let current = element; current && current !== stop; current = flatParent(current)) {
      let known = cache.get(current);
      if (known === undefined) cache.set(current, (known = marksCitation(current)));
      if (known) return true;
    }
    return false;
  }

  const WORD_CHAR = /\p{L}|\p{N}/u;

  /**
   * Whether the element is painted, ancestors included. Memoised per walk.
   *
   * `aria-hidden` is deliberately not a reason. It takes an element out of
   * the accessibility tree and leaves it on the screen, which is how the
   * visible copy of a formula is marked so a screen reader will not read
   * the equation twice. `visible` still honours it, for everything else.
   */
  function painted(element, cache) {
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
      if (!selfPainted(current)) {
        result = false;
        break;
      }
      current = flatParent(current);
    }
    for (const node of pending) cache.set(node, result);
    return result;
  }

  function selfPainted(element) {
    if (element.hasAttribute("hidden")) return false;
    // A formula inside a folded disclosure, or inside a box collapsed to
    // nothing, is not on the page, even when its face is `aria-hidden` and
    // would otherwise be the copy that is read.
    if (disclosureHides(element)) return false;
    if (collapsedHides(element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (style.contentVisibility === "hidden") return false;
    return !takenOutOfSight(element, style);
  }

  /** HTML uppercases its own tags; MathML and SVG do not. Compare one way. */
  function tagOf(element) {
    return element.tagName.toUpperCase();
  }

  /** An image, an SVG, or the copy marked so a screen reader skips it. */
  function isFace(element) {
    const tag = tagOf(element);
    return tag === "IMG" || tag === "SVG" || element.getAttribute("aria-hidden") === "true";
  }

  /** Whether `tags` contains the tag of `element` or of an ancestor below `stop`. */
  function tagWithin(element, stop, tags) {
    for (let current = element; current && current !== stop; current = flatParent(current)) {
      if (isElementNode(current) && tags.has(tagOf(current))) return true;
    }
    return false;
  }

  /**
   * Find every formula and decide which of its copies is read.
   *
   * A formula is drawn twice. The copy on the screen is what a listener
   * should hear: letters laid out in HTML, an SVG of paths, or an image.
   * The other copy is for assistive technology and is clipped to a pixel
   * or `display: none`, while the screen copy is `aria-hidden` so it is not
   * read twice. Honouring both rules drops the equation out of the sentence,
   * and "the relation holds" is then a different sentence. Reading both says
   * it twice.
   *
   * The element that holds the two copies and nothing else is the formula.
   * Its screen copy is read. Where that copy has no letters — paths, or an
   * image — the accessible copy or the image's alt is read instead, and the
   * highlight is the drawing. A `<math>` that is itself on screen, with no
   * twin, is not one of these and is read as it stands.
   */
  function indexFormulas(root, visibleCache) {
    const paintCache = new Map();
    const infoOf = new Map();
    const sourceOf = new Map();
    const glyphBlocked = new Set(["MATH", ...FORMULA_NOISE, ...SKIP_TAGS]);

    const describe = (element) => {
      let info = infoOf.get(element);
      if (info) return info;
      info = { widget: false, unpaintedMath: false, paintedPresentation: false, prose: false };
      infoOf.set(element, info);
      const tag = tagOf(element);

      if (tag === "MATH" && !painted(element, paintCache)) info.unpaintedMath = true;
      if (tag !== "MATH" && isFace(element) && painted(element, paintCache)) {
        info.paintedPresentation = true;
      }

      const kids = composedKids(element);
      let prose = false;
      if (!SKIP_TAGS.has(tag)) {
        for (const node of kids) {
          if (node.nodeType === Node.TEXT_NODE && node.data.trim()) prose = true;
        }
      }
      let childWidget = false;
      for (const child of kids) {
        if (!isElementNode(child)) continue;
        const childInfo = describe(child);
        const childTag = tagOf(child);
        if (childInfo.widget) childWidget = true;
        if (childTag === "MATH") {
          if (childInfo.unpaintedMath) info.unpaintedMath = true;
          continue;
        }
        if (childInfo.unpaintedMath) info.unpaintedMath = true;
        if (childInfo.paintedPresentation) info.paintedPresentation = true;
        // Letters inside the drawing, the script, or the aria-hidden copy
        // are the formula. Letters anywhere else are the sentence around it,
        // and a sentence is not a formula.
        if (!isFace(child) && !SKIP_TAGS.has(childTag) && childInfo.prose) prose = true;
      }
      info.prose = prose;
      info.widget =
        tag !== "MATH" &&
        tag !== "SVG" &&
        tag !== "IMG" &&
        !SKIP_TAGS.has(tag) &&
        !childWidget &&
        info.unpaintedMath &&
        info.paintedPresentation &&
        !prose;
      return info;
    };

    const top = root.ownerDocument?.documentElement;
    if (top && (top === root || top.contains(root))) describe(top);
    else describe(root);

    const owningWidget = (element) => {
      for (let current = element; current; current = flatParent(current)) {
        if (infoOf.get(current)?.widget) return current;
      }
      return null;
    };

    const hasGlyphs = (widget) => {
      // A face that is only a mark — a decorative asterisk beside a clipped
      // formula — is not the formula. Letters or digits are.
      let text = "";
      walkComposed(widget, (node) => {
        if (node.nodeType !== Node.TEXT_NODE) return;
        const parent = node.parentElement;
        if (parent && painted(parent, paintCache) && !tagWithin(parent, widget, glyphBlocked)) text += node.data;
      });
      return /[\p{L}\p{N}]/u.test(text);
    };

    const inMath = (element, widget) => tagWithin(element, widget, new Set(["MATH"]));

    const altImage = (widget) => {
      let found = null;
      walkComposed(widget, (node) => {
        if (found || !isElementNode(node) || tagOf(node) !== "IMG") return;
        if (inMath(node, widget)) return;
        if (!node.alt.trim() || !painted(node, paintCache)) return;
        found = node;
      });
      return found;
    };

    const faceBox = (widget) => {
      let svg = null;
      let img = null;
      walkComposed(widget, (node) => {
        if (!isElementNode(node) || inMath(node, widget) || !painted(node, paintCache)) return;
        const tag = tagOf(node);
        if (!svg && tag === "SVG") svg = node;
        if (!img && tag === "IMG") img = node;
      });
      return svg || img || widget;
    };

    const choose = (widget) => {
      const parent = widget.parentElement;
      // An ancestor that is genuinely hidden hides the formula with it. The
      // formula's own face is the one `aria-hidden` that does not.
      if (parent && !visible(parent, visibleCache)) return { kind: "none" };
      if (!painted(widget, paintCache)) return { kind: "none" };
      if (hasGlyphs(widget)) return { kind: "visual" };
      const img = altImage(widget);
      if (img) return { kind: "alt", box: img, text: img.alt.trim() };
      return { kind: "math", box: faceBox(widget) };
    };

    const sourceFor = (widget) => {
      let source = sourceOf.get(widget);
      if (!source) sourceOf.set(widget, (source = choose(widget)));
      return source;
    };

    return { owningWidget, sourceFor, paintCache };
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
      current = flatParent(current);
    }
    for (const node of pending) cache.set(node, result);
    return result;
  }

  /**
   * Whether `element` sits in a subtree the page has marked `inert`, not
   * counting `root` itself.
   *
   * The container the read chose may be inert. A dialog traps focus by
   * marking the article, and the article is still the page that was asked
   * for. What gets left out is a part that carries its own `inert`: a slide
   * held off to the side, a panel the page has not opened.
   *
   * The cache stores whether an element itself has the attribute. Ancestors
   * are asked on the way up, so one cache is right for every root.
   */
  function inInert(element, root, cache) {
    for (let current = element; current && current !== root; current = flatParent(current)) {
      let known = cache.get(current);
      if (known === undefined) cache.set(current, (known = current.hasAttribute("inert")));
      if (known) return true;
    }
    return false;
  }

  const WEIGHT_TAGS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE"]);

  /**
   * A recommendation, a sidebar, or anything sitting in one.
   *
   * The class and id tokens are the ones a card of related reading wears
   * when it is not marked with the element. A story whose class merely
   * contains the letters is not one of them.
   */
  function recommendationName(element) {
    const id = (element.id || "").toLowerCase();
    const classes = String(element.className || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const tokens = id ? [id, ...classes] : classes;
    for (const token of tokens) {
      if (token === "teaser" || token === "recommend" || token === "recommended" || token === "recommendation") {
        return true;
      }
      if (token.includes("teaser") || token.includes("recommend")) return true;
      if (token === "sidebar" || token.startsWith("sidebar-") || token.startsWith("sidebar_")) return true;
      if (token.startsWith("related-") || token.startsWith("related_")) return true;
    }
    return false;
  }

  function inMarginal(element) {
    for (let current = element; current && current !== document.body; current = flatParent(current)) {
      if (!isElementNode(current)) continue;
      if (current.tagName === "ASIDE") return true;
      if (landmarkRole(current) === "complementary") return true;
      if (recommendationName(current)) return true;
    }
    return false;
  }

  function textWeight(element, cache, inert) {
    let total = 0;
    let linked = 0;
    const counts = (node) => visible(node, cache) && !inInert(node, element, inert);
    const add = (node) => {
      if (!isElementNode(node) || !counts(node)) return;
      const tag = tagOf(node);
      if (WEIGHT_TAGS.has(tag)) total += node.textContent.length;
      if (tag === "A") linked += node.textContent.length;
    };
    // The light-DOM path is the one every existing page is scored by.
    // Open shadow roots are outside querySelectorAll, so a host whose
    // article is drawn in one is scored from the rendered tree instead.
    if (!hasOpenShadow(element)) {
      for (const node of element.querySelectorAll("p, li, h1, h2, h3, h4, blockquote")) add(node);
      for (const node of element.querySelectorAll("a")) add(node);
    } else {
      walkComposed(element, add);
    }
    return total - linked * 1.5;
  }

  /** `selector` matches in the document and in every open shadow root. */
  function queryAllDeep(selector) {
    const found = [];
    const visit = (root) => {
      if (!root.querySelectorAll) return;
      found.push(...root.querySelectorAll(selector));
      for (const host of root.querySelectorAll("*")) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(document);
    return found;
  }

  function paragraphCount(element) {
    if (!hasOpenShadow(element)) return element.querySelectorAll("p").length;
    let count = 0;
    walkComposed(element, (node) => {
      if (isElementNode(node) && node.tagName === "P") count += 1;
    });
    return count;
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
   *
   * An inert candidate loses to a rendered one. A slide that is a second
   * article, still painted and marked inert, can hold more text than the
   * article on screen; scoring it would read the slide. Held-back text
   * inside a candidate does not count toward it either. When the only
   * candidate above the threshold is itself inert, it is still the page.
   *
   * An article inside a sidebar, a complementary landmark, or a
   * recommendation card does not win on the strength of its tag. It is
   * scored with the other marginal containers and loses to any rendered
   * story that clears the threshold. It is still the page when nothing
   * else does — a document that is only that card should be read, not
   * skipped.
   */
  function findMainContent(cache = new Map()) {
    clipCache = new WeakMap();
    const inert = new Map();
    let best = null;
    let bestScore = 0;
    let inertBest = null;
    let inertScore = 0;
    let marginalBest = null;
    let marginalScore = 0;

    const rank = (element) => {
      if (!visible(element, cache)) return;
      const score = textWeight(element, cache, inert);
      if (element.hasAttribute("inert")) {
        if (score > inertScore) {
          inertBest = element;
          inertScore = score;
        }
        return;
      }
      if (inMarginal(element)) {
        if (score > marginalScore) {
          marginalBest = element;
          marginalScore = score;
        }
        return;
      }
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    };

    // Selector matches are considered before plain containers, and the
    // first of two equal scores wins, so an article inside <main> stays
    // the article. A marginal article does not take that shortcut.
    for (const selector of MAIN_SELECTORS) {
      for (const element of queryAllDeep(selector)) rank(element);
    }
    if (best && bestScore > 400) return best;
    // An inert article is the page when nothing rendered cleared the bar.
    // A plain div does not get to outscore it by being considered afterwards.
    if (inertBest && inertScore > 400) return inertBest;

    best = null;
    bestScore = 0;
    for (const element of queryAllDeep("div, section, td")) {
      if (paragraphCount(element) < 3) continue;
      rank(element);
    }
    if (best && bestScore > 400) return best;
    if (marginalBest && marginalScore > 400) return marginalBest;
    if (inertBest && inertScore > 400) return inertBest;
    return document.body;
  }

  function blockAncestor(node) {
    let current = flatParent(node);
    while (current && !BLOCK_TAGS.has(current.tagName)) current = flatParent(current);
    return current || document.body;
  }

  function rangeIntersects(range, node) {
    if (!range) return true;
    try {
      return range.intersectsNode(node);
    } catch {
      // A range and a node in different trees — a selection in the document
      // and a text node in a shadow root — throw instead of returning false.
      return false;
    }
  }

  function clipToSelection(node, range) {
    const length = node.data.length;
    if (!range) return [0, length];
    if (!rangeIntersects(range, node)) return null;
    let start = 0;
    let end = length;
    if (node === range.startContainer) start = Math.min(range.startOffset, length);
    if (node === range.endContainer) end = Math.min(range.endOffset, length);
    return end > start ? [start, end] : null;
  }

  function collectTextNodes(
    root,
    range,
    chromeTags,
    cache = new Map(),
    { readCodeBlocks = false, skipCitations = true, skipRuby = true, skipInert = true } = {},
  ) {
    // Asking the layout costs a style resolve, and a page of API docs has a
    // great many `<code>` elements, so each one is asked once per walk.
    const codeBlocks = new Map();
    const inCodeBlock = (element) => {
      let known = codeBlocks.get(element);
      if (known === undefined) codeBlocks.set(element, (known = isCodeBlock(element)));
      return known;
    };
    const citations = new Map();
    const inert = new Map();
    // Held-back text stays in the slice list so the words on either side do
    // not run together, and so a selection of nothing else can still read it.
    const heldBack = (element) => skipInert && inInert(element, root, inert);
    const formulas = indexFormulas(root, cache);
    const hiddenFormula = new Set(["MATH", ...FORMULA_NOISE]);
    const mathTag = new Set(["MATH"]);

    const boundary = flatParent(root);
    const skippedAncestor = (element) => {
      for (let el = element; el && el !== boundary; el = flatParent(el)) {
        if (!isElementNode(el)) continue;
        const tag = tagOf(el);
        if (FORMULA_NOISE.has(tag)) return true;
        if (SKIP_TAGS.has(tag)) return true;
        if (skipRuby && RUBY_ANNOTATION.has(tag)) return true;
        if (!readCodeBlocks && CODE_TAGS.has(tag) && inCodeBlock(el)) return true;
        if (el !== root && marksChrome(el, tag, chromeTags)) return true;
      }
      return false;
    };

    // `painted` closes over the cache `indexFormulas` built. A glyph inside
    // an `aria-hidden` face is still on screen; `visible` would drop it.
    function formulasPainted(element) {
      return painted(element, formulas.paintCache);
    }

    const acceptText = (node) => {
      // A text node of nothing but a space is still a space. The one between
      // `<em>only</em> <em>while</em>` is its own node, and dropping it
      // speaks "onlywhile". A newline in the source is that same space.
      if (!node.data) return false;
      // A text node parented by the shadow root has no element parent.
      // The host is the element that renders it.
      const parent = node.parentElement ?? flatParent(node);
      if (!parent) return false;
      // Before the formula branch, so a folded equation is not rescued by
      // being the copy that would have been spoken.
      if (disclosureHides(node)) return false;

      const widget = formulas.owningWidget(parent);
      if (widget) {
        const source = formulas.sourceFor(widget);
        // The copy that is not on screen, and a formula that is itself
        // hidden, contribute nothing. An image formula is spoken from its
        // alt, spliced in below, rather than from a text node.
        if (source.kind === "visual") {
          if (tagWithin(parent, widget, hiddenFormula)) return false;
          if (!formulasPainted(parent)) return false;
        } else if (source.kind === "math") {
          if (!tagWithin(parent, widget, mathTag)) return false;
          if (tagWithin(parent, widget, FORMULA_NOISE)) return false;
        } else {
          return false;
        }
        if (skippedAncestor(parent)) return false;
        return true;
      }

      // `visible` walks past the root as well, so a root that sits inside a
      // hidden container yields nothing rather than hidden text. A collapsed
      // box stays rendered — a fixed bar inside it may still be on the page
      // — so its own text has to be asked separately. This stays after the
      // formula branch: the accessible copy of an equation is a one-pixel
      // box on purpose, and that copy is the one a path drawing is read from.
      if (collapsedHides(node) || !visible(parent, cache)) return false;
      // After visibility, so a hidden subtree is not measured. A line the
      // indent pushed out has a normal box and would otherwise be read.
      if (indentHides(node)) return false;
      if (skippedAncestor(parent)) return false;
      return true;
    };

    const altSliceFor = (img) => {
      const widget = formulas.owningWidget(img);
      if (!widget) return null;
      const source = formulas.sourceFor(widget);
      if (source.kind !== "alt" || source.box !== img || !source.text) return null;
      if (!rangeIntersects(range, img)) return null;
      if (skippedAncestor(img) || heldBack(img)) return null;
      return {
        node: null,
        literal: source.text,
        box: img,
        start: 0,
        end: source.text.length,
        gap: false,
      };
    };

    const slices = [];
    const pushText = (node) => {
      const clipped = clipToSelection(node, range);
      if (!clipped) return;
      const parent = node.parentElement ?? flatParent(node);
      const widget = formulas.owningWidget(parent);
      const source = widget ? formulas.sourceFor(widget) : null;
      slices.push({
        node,
        start: clipped[0],
        end: clipped[1],
        // Kept as a slice so the words on either side stay apart, and so a
        // mark sitting against a comma does not grow a space of its own.
        // Nothing in it is spoken.
        gap: (skipCitations && inCitation(parent, root, citations)) || heldBack(parent),
        // A formula whose letters are not on the page — an SVG of paths —
        // is highlighted as the drawing, which is.
        box: source?.kind === "math" ? source.box : null,
      });
    };

    // The root itself is not a descendant. An image asked for by name — a
    // selection of just the equation — is still the formula.
    if (isElementNode(root) && tagOf(root) === "IMG") {
      const alt = altSliceFor(root);
      if (alt) slices.push(alt);
    }

    walkComposed(root, (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (acceptText(node)) pushText(node);
        return;
      }
      if (isElementNode(node) && tagOf(node) === "IMG") {
        const alt = altSliceFor(node);
        if (alt) slices.push(alt);
      }
    });
    return slices;
  }

  /**
   * The characters a slice contributes, and the node they sit at.
   * An image formula has no text node; its alt is the characters and the
   * image is where they sit.
   */
  function sliceText(slice) {
    if (slice.literal != null) return { data: slice.literal, start: 0, end: slice.literal.length, at: slice.box };
    return { data: slice.node.data, start: slice.start, end: slice.end, at: slice.node };
  }

  /** First character a slice would actually speak, ignoring its own spaces. */
  function firstSolidChar(slice) {
    const { data, start, end } = sliceText(slice);
    for (let offset = start; offset < end; offset += 1) {
      const char = data[offset];
      if (ns.util.isSilent(char) || ns.util.isWhitespace(char) || ns.util.isLineBreak(char)) continue;
      return char;
    }
    return "";
  }

  /**
   * What a slice contributes. A slice of only a soft hyphen contributes
   * nothing: it joins the letters on either side. A slice of only a space,
   * including the newline the source put between two elements, contributes
   * a space. U+2028 and U+2029 are the exception, because they are breaks
   * rather than spaces.
   */
  function sliceKind(slice) {
    const { data, start, end } = sliceText(slice);
    let space = false;
    let breakChar = false;
    for (let offset = start; offset < end; offset += 1) {
      const char = data[offset];
      if (ns.util.isSilent(char)) continue;
      if (ns.util.isLineBreak(char)) {
        breakChar = true;
        continue;
      }
      if (ns.util.isWhitespace(char)) {
        space = true;
        continue;
      }
      return "text";
    }
    if (breakChar) return "break";
    if (space) return "space";
    return "empty";
  }

  /**
   * The next rendered node, not descending into `node` itself.
   * Slots and open shadow roots are flattened, so a `<br>` drawn in a
   * shadow root still sits between the text nodes on either side of it.
   */
  function nodeAfter(node) {
    let current = node;
    while (current) {
      const parent = flatParent(current);
      if (!parent) return null;
      const kids = composedKids(parent);
      const index = kids.indexOf(current);
      if (index >= 0 && index + 1 < kids.length) return kids[index + 1];
      current = parent;
    }
    return null;
  }

  /**
   * Whether a visible `<br>` sits between two text nodes.
   *
   * A line break is not an ancestor of either side, so the block walk never
   * sees it, and the two lines run together. One the page has hidden is not
   * a break: the words on either side are one line. One inside a ruby
   * annotation or an inert subtree is not a break either: it belongs to the
   * reading, or to the part the page is holding back, and the words on
   * either side of it stay one sentence.
   */
  function lineBreakBetween(fromNode, toNode, cache) {
    if (!fromNode || !toNode || fromNode === toNode || fromNode.nextSibling === toNode) return false;
    let current = nodeAfter(fromNode);
    for (let guard = 0; current && guard < 200; guard += 1) {
      if (current === toNode) return false;
      // A break inside a ruby annotation belongs to the reading, which is
      // not spoken, and descending would split the word. A break inside an
      // inert subtree belongs to the part the page is holding back.
      if (
        current.nodeType === Node.ELEMENT_NODE &&
        (RUBY_ANNOTATION.has(tagOf(current)) || current.hasAttribute("inert"))
      ) {
        current = nodeAfter(current);
        continue;
      }
      if (current.nodeType === Node.ELEMENT_NODE && current.tagName === "BR" && visible(current, cache)) {
        return true;
      }
      const first = isElementNode(current) ? composedFirst(current) : null;
      if (first && !SKIP_TAGS.has(current.tagName) && visible(current, cache)) {
        current = first;
        continue;
      }
      current = nodeAfter(current);
    }
    return false;
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
  function buildText(slices, cache) {
    const chars = [];
    const charNodes = [];
    const charOffsets = [];
    let pendingSpace = false;
    let pendingBreak = false;
    let previousBlock = null;
    let previousNode = null;

    const pushSynthetic = (char) => {
      chars.push(char);
      charNodes.push(-1);
      charOffsets.push(-1);
    };

    const emitBreak = () => {
      while (
        chars.length &&
        ns.util.isWhitespace(chars[chars.length - 1]) &&
        chars[chars.length - 1] !== "\n"
      ) {
        chars.pop();
        charNodes.pop();
        charOffsets.pop();
      }
      if (chars.length && chars[chars.length - 1] !== "\n") pushSynthetic("\n");
      pendingSpace = false;
      pendingBreak = false;
    };

    for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
      const slice = slices[sliceIndex];
      const source = sliceText(slice);
      if (slice.gap) {
        // A citation mark, or text the page has marked inert, is not spoken.
        // Between two words it still has to leave them apart — `pond[1]lasts`
        // and `pond<span inert>held</span>lasts` are both "pond lasts" — and
        // against punctuation it has to leave no space, so `water[1],` stays
        // "water,".
        const previous = chars.length ? chars[chars.length - 1] : "";
        const next = nextSpokenChar(slices, sliceIndex);
        if (previous && next && WORD_CHAR.test(previous) && WORD_CHAR.test(next)) pendingSpace = true;
        continue;
      }
      const block = blockAncestor(source.at);
      const kind = sliceKind(slice);
      // A blank slice is not a block of its own, and it is not a position to
      // measure the next break from. The following word still sees a `<br>`
      // that sat in front of the space.
      if (kind !== "text") {
        if (kind === "break") pendingBreak = true;
        else if (kind === "space" && previousBlock && block === previousBlock && chars.length) pendingSpace = true;
        continue;
      }

      const blockBefore = previousBlock && block !== previousBlock;
      const breakBefore =
        pendingBreak ||
        (!blockBefore && previousNode && lineBreakBetween(previousNode, source.at, cache));
      if ((blockBefore || breakBefore) && chars.length) emitBreak();
      previousBlock = block;
      previousNode = source.at;

      const data = source.data;
      for (let offset = source.start; offset < source.end; offset += 1) {
        const char = data[offset];
        if (ns.util.isSilent(char)) continue;
        if (ns.util.isLineBreak(char)) {
          emitBreak();
          continue;
        }
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
    const built = buildText(slices, cache);
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
    clipCache = new WeakMap();
    blockOf = new WeakMap();
    indentOf = new WeakMap();
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
      // A selection of nothing but a snippet, a citation marker, a ruby
      // annotation, or text the page has marked inert is still text the user
      // picked out and asked to hear, and silence is not an answer to that —
      // an empty selection is read as the whole page. So a selection the
      // filters would empty is read with those set aside.
      const built =
        root &&
        (buildFrom(root, range, null, new Map(), options) ??
          buildFrom(root, range, null, new Map(), {
            readCodeBlocks: true,
            skipCitations: false,
            skipRuby: false,
            skipInert: false,
          }));
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
    // An image formula has no text node; the first character it contributed
    // is what a click on the drawing lands on.
    const byNode = new Map();
    const byBox = new Map();
    for (let i = 0; i < doc.slices.length; i += 1) {
      const node = doc.slices[i].node;
      if (node && !byNode.has(node)) byNode.set(node, i);
    }
    for (let i = 0; i < doc.charNodes.length; i += 1) {
      const sliceIndex = doc.charNodes[i];
      if (sliceIndex < 0) continue;
      const box = doc.slices[sliceIndex].box;
      // The space in front of a formula is charged to its first slice. A click
      // on the drawing belongs on the formula, not on that space.
      if (box && !byBox.has(box) && !ns.util.isWhitespace(doc.text[i])) byBox.set(box, i);
    }
    doc.reverse = { spans, byNode, byBox };
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
    if (caret?.node?.nodeType === Node.TEXT_NODE) {
      const at = characterAt(caret.node, caret.offset, x, y);
      if (at >= 0) {
        const index = charIndexAt(doc, caret.node, at);
        if (index >= 0) return index;
      }
    }
    // A formula drawn as an image or as paths has no character box to hit.
    // The drawing itself is the word.
    const element = document.elementFromPoint(x, y);
    if (!element || !doc?.slices?.length) return -1;
    const { byBox } = reverseIndex(doc);
    for (let current = element; current; current = flatParent(current)) {
      const index = byBox.get(current);
      if (index !== undefined) return index;
    }
    // The caret APIs sometimes stop at a shadow host. The element under the
    // point is already inside the open shadow, so the character is found by
    // the boxes of the text rendered there.
    let hit = -1;
    walkComposed(element, (node) => {
      if (hit >= 0 || node.nodeType !== Node.TEXT_NODE) return;
      const at = offsetAtPoint(node, x, y);
      if (at < 0) return;
      const index = charIndexAt(doc, node, at);
      if (index >= 0) hit = index;
    });
    return hit;
  }

  /** The offset of the character of `node` whose glyph contains (x, y), or -1. */
  function offsetAtPoint(node, x, y) {
    const length = node.data?.length ?? 0;
    if (!length) return -1;
    const range = node.ownerDocument.createRange();
    const lineHeight = parseFloat(getComputedStyle(node.parentElement ?? document.body).lineHeight);
    const leadingFor = (rect) => (Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - rect.height) / 2) : 0);
    range.selectNodeContents(node);
    let covers = false;
    for (const rect of range.getClientRects()) {
      if (pointInGlyph(rect, x, y, leadingFor(rect))) {
        covers = true;
        break;
      }
    }
    if (!covers) return -1;
    for (let start = 0; start < length; start += 1) {
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      for (const rect of range.getClientRects()) {
        if (pointInGlyph(rect, x, y, leadingFor(rect))) return start;
      }
    }
    return -1;
  }

  function pointInGlyph(rect, x, y, leading) {
    return (
      x >= rect.left - HIT_SLOP_PX &&
      x <= rect.right + HIT_SLOP_PX &&
      y >= rect.top - leading - HIT_SLOP_PX &&
      y <= rect.bottom + leading + HIT_SLOP_PX
    );
  }

  /**
   * DOM Range covering global character indices [start, end), or null when
   * those characters are in no node of the page — text fetched from somewhere
   * else, which is how a canvas-drawn Google Doc is read.
   */
  function anchorOf(slice) {
    return slice?.box || slice?.node || null;
  }

  /** One range for [start, end), or null when those characters share no node. */
  function buildRange(doc, start, end) {
    const { charNodes, charOffsets, slices } = doc;
    let from = start;
    while (from < end && charNodes[from] < 0) from += 1;
    let to = end - 1;
    while (to >= from && charNodes[to] < 0) to -= 1;
    if (from > to) return null;

    const range = document.createRange();
    const startSlice = slices[charNodes[from]];
    const endSlice = slices[charNodes[to]];
    try {
      // A formula with no letters of its own is one drawing, so the whole
      // of it highlights together. Letters on the page highlight as letters.
      if (startSlice.box && endSlice.box && startSlice.box === endSlice.box) {
        range.selectNode(startSlice.box);
        return range;
      }
      if (startSlice.box) range.setStartBefore(startSlice.box);
      else range.setStart(startSlice.node, charOffsets[from]);
      if (endSlice.box) range.setEndAfter(endSlice.box);
      else range.setEnd(endSlice.node, charOffsets[to] + 1);
    } catch {
      // A single Range cannot cross a shadow boundary. Callers that can
      // paint several ranges use `rangesFor`.
      return null;
    }
    return range;
  }

  /**
   * DOM ranges covering global character indices [start, end).
   *
   * One range when the characters share a tree, which is every light-DOM
   * article and a shadow article whose text lives in one root. A sentence
   * that steps through a slot into another tree is several ranges, because
   * a Range cannot cross that boundary.
   */
  function rangesFor(doc, start, end) {
    if (!doc?.slices?.length) return [];
    const { charNodes, slices } = doc;
    const ranges = [];
    let runFrom = -1;
    let runRoot = null;
    const flush = (until) => {
      if (runFrom < 0) return;
      const range = buildRange(doc, runFrom, until);
      if (range) ranges.push(range);
      runFrom = -1;
      runRoot = null;
    };
    for (let i = start; i < end; i += 1) {
      const sliceIndex = charNodes[i];
      if (sliceIndex < 0) continue;
      const root = anchorOf(slices[sliceIndex])?.getRootNode?.() ?? null;
      if (runFrom < 0) {
        runFrom = i;
        runRoot = root;
        continue;
      }
      if (root !== runRoot) {
        flush(i);
        runFrom = i;
        runRoot = root;
      }
    }
    flush(end);
    return ranges;
  }

  function rangeFor(doc, start, end) {
    return rangesFor(doc, start, end)[0] ?? null;
  }

  ns.extract = {
    extract,
    rangeFor,
    rangesFor,
    findMainContent,
    isCodeBlock,
    charIndexAt,
    charIndexFromPoint,
  };
})(globalThis.__readAloud);
