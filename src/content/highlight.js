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

  function paintOverlay(key, range) {
    const root = ensureOverlayRoot();
    for (const node of root.querySelectorAll(`[data-key="${key}"]`)) node.remove();
    if (!range) return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
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

  function setRange(key, range) {
    if (supportsHighlightApi) {
      if (range) CSS.highlights.set(key, new globalThis.Highlight(range));
      else CSS.highlights.delete(key);
      return;
    }
    paintOverlay(key, range);
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

  /** Keep the spoken word inside a comfortable band in the viewport. */
  function scrollTo(range) {
    const rect = range?.getBoundingClientRect?.();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const topBand = window.innerHeight * 0.25;
    const bottomBand = window.innerHeight * 0.72;
    if (rect.top >= topBand && rect.bottom <= bottomBand) return;
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
      paintOverlay(SENTENCE_KEY, sentenceRange);
      paintOverlay(WORD_KEY, wordRange);
    },
    clear,
    scrollTo,
    notify,
  };
})(globalThis.__readAloud);
