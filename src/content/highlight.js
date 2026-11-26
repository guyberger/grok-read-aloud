(function (ns) {
  "use strict";

  const WORD_KEY = "read-aloud-word";
  const SENTENCE_KEY = "read-aloud-sentence";

  const supportsHighlightApi =
    typeof CSS !== "undefined" &&
    CSS.highlights &&
    typeof globalThis.Highlight === "function" &&
    CSS.supports?.("selector(::highlight(x))");

  let overlayRoot = null;
  let toast = null;
  let toastTimer = 0;

  function ensureOverlayRoot() {
    if (overlayRoot?.isConnected) return overlayRoot;
    overlayRoot = document.createElement("div");
    overlayRoot.className = "read-aloud-overlay-root";
    document.body.appendChild(overlayRoot);
    return overlayRoot;
  }

  function paintOverlay(key, ranges) {
    const root = ensureOverlayRoot();
    for (const node of root.querySelectorAll(`[data-key="${key}"]`)) node.remove();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    for (const range of ranges) {
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        const box = document.createElement("div");
        box.className = `read-aloud-overlay-rect ${key === WORD_KEY ? "is-word" : "is-sentence"}`;
        box.dataset.key = key;
        box.style.left = `${rect.left + scrollX}px`;
        box.style.top = `${rect.top + scrollY}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        root.appendChild(box);
      }
    }
  }

  // Custom properties set on the document inherit into open shadow roots.
  // `::highlight` does not, so a shadow root that holds a range needs the
  // same two rules adopted into it or the spoken word never lights up.
  const SHADOW_HIGHLIGHT_CSS = `
    ::highlight(${SENTENCE_KEY}) { background-color: var(--read-aloud-sentence-bg, rgba(255, 211, 77, 0.22)); }
    ::highlight(${WORD_KEY}) { background-color: var(--read-aloud-word-bg, #ffd34d); color: var(--read-aloud-word-fg, #141414); }
  `;
  let shadowSheet = null;
  const shadowRegistries = new Set();

  function highlightRules() {
    if (shadowSheet) return shadowSheet;
    try {
      shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync(SHADOW_HIGHLIGHT_CSS);
    } catch {
      shadowSheet = null;
    }
    return shadowSheet;
  }

  function ensureShadowStyle(root) {
    const sheet = highlightRules();
    if (sheet && root.adoptedStyleSheets && !root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return;
    }
    if (root.querySelector?.("style[data-read-aloud-highlight]")) return;
    const style = document.createElement("style");
    style.dataset.readAloudHighlight = "";
    style.textContent = SHADOW_HIGHLIGHT_CSS;
    root.append(style);
  }

  function rangesOf(range) {
    if (!range) return [];
    return (Array.isArray(range) ? range : [range]).filter(Boolean);
  }

  function setRange(key, range) {
    const ranges = rangesOf(range);
    if (supportsHighlightApi) {
      CSS.highlights.delete(key);
      for (const registry of shadowRegistries) registry.delete(key);
      if (!ranges.length) return;
      // The document registry is what a probe reads back. Ranges that live
      // in a shadow tree are also registered there, which is where they paint.
      CSS.highlights.set(key, new globalThis.Highlight(...ranges));
      const byRoot = new Map();
      for (const item of ranges) {
        const root = item.startContainer?.getRootNode?.();
        if (!(root instanceof ShadowRoot) || !root.highlights) continue;
        const group = byRoot.get(root) ?? [];
        group.push(item);
        byRoot.set(root, group);
      }
      for (const [root, group] of byRoot) {
        ensureShadowStyle(root);
        shadowRegistries.add(root.highlights);
        root.highlights.set(key, new globalThis.Highlight(...group));
      }
      return;
    }
    paintOverlay(key, ranges);
  }

  function configure({ highlightColor, sentenceTint }) {
    const root = document.documentElement;
    if (highlightColor) {
      root.style.setProperty("--read-aloud-word-bg", highlightColor);
      root.style.setProperty("--read-aloud-sentence-bg", tint(highlightColor, 0.22));
      root.style.setProperty("--read-aloud-word-fg", readableOn(highlightColor));
    }
    if (sentenceTint === false) root.style.setProperty("--read-aloud-sentence-bg", "transparent");
  }

  function parseHex(hex) {
    const value = String(hex).replace("#", "");
    const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
    const int = Number.parseInt(full, 16);
    if (!Number.isFinite(int) || full.length !== 6) return null;
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  }

  function tint(hex, alpha) {
    const rgb = parseHex(hex);
    return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : "rgba(255, 211, 77, 0.22)";
  }

  function readableOn(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return "#141414";
    const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return luminance > 0.55 ? "#141414" : "#ffffff";
  }

  function clear() {
    setRange(WORD_KEY, null);
    setRange(SENTENCE_KEY, null);
    overlayRoot?.remove();
    overlayRoot = null;
  }

  /**
   * The band a following read keeps the spoken word in: clear of the top
   * quarter of the viewport and of its bottom quarter or so, which is where
   * text sits while it is being read rather than where it has to be dragged
   * back from. It is also what says whether a listener who scrolled away has
   * come back to the read — see `follow.js`.
   */
  const BAND_TOP = 0.25;
  const BAND_BOTTOM = 0.72;

  /** The range's box, or null when it has none worth measuring. */
  function boxOf(range) {
    const rect = range?.getBoundingClientRect?.();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect;
  }

  function withinBand(rect) {
    return rect.top >= window.innerHeight * BAND_TOP && rect.bottom <= window.innerHeight * BAND_BOTTOM;
  }

  /** Whether `range` is already where a following read would keep it. */
  function inBand(range) {
    const rect = boxOf(range);
    return Boolean(rect) && withinBand(rect);
  }

  /** Keep the spoken word inside a comfortable band in the viewport. */
  function scrollTo(range) {
    const rect = boxOf(range);
    if (!rect || withinBand(rect)) return;
    window.scrollBy({
      top: rect.top - window.innerHeight * 0.38,
      behavior: "smooth",
    });
  }

  function notify(message) {
    if (!toast?.isConnected) {
      toast = document.createElement("div");
      toast.className = "read-aloud-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast?.remove();
      toast = null;
    }, 5200);
  }

  ns.highlight = {
    supportsHighlightApi,
    configure,
    setWord: (range) => setRange(WORD_KEY, range),
    setSentence: (range) => setRange(SENTENCE_KEY, range),
    repaint(wordRange, sentenceRange) {
      if (supportsHighlightApi) return;
      paintOverlay(SENTENCE_KEY, rangesOf(sentenceRange));
      paintOverlay(WORD_KEY, rangesOf(wordRange));
    },
    clear,
    inBand,
    scrollTo,
    notify,
  };
})(globalThis.__readAloud);
