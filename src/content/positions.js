(function (ns) {
  "use strict";

  /** One entry per page, under one storage key, so pruning is one write. */
  const STORE_KEY = "readingPositions";

  /** How many pages are remembered, and for how long. */
  const MAX_PAGES = 40;
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * The text a position is remembered by, rather than the character index
   * alone. An index is only true of the page as it was: a comment that
   * appeared, an advert that expanded, a sentence the author fixed, and the
   * same number now points at the middle of a different word. The text that
   * was about to be spoken is still there, a few hundred characters either
   * way, so that is what the position is found by when the index no longer
   * holds. Long enough to be unique in an article, short enough to survive an
   * edit inside it.
   */
  const ANCHOR_CHARS = 80;

  /**
   * Prefixes to fall back to when the whole anchor is gone — the text right at
   * the position was itself edited. Below `MIN_ANCHOR_CHARS` a match says
   * little enough that starting from the top is the honest answer.
   */
  const ANCHOR_PREFIXES = [40, 24];
  const MIN_ANCHOR_CHARS = 16;

  /**
   * How far in a position has to be before continuing from it is worth
   * offering. The opening of a page is quicker to hear again than to decide
   * about, and a position in the last few percent is a page that was finished.
   */
  const MIN_OFFER_CHARS = 400;
  const MAX_OFFER_FRACTION = 0.97;

  /**
   * The page a position belongs to. The fragment is dropped: following a
   * footnote link and coming back is the same page, and the extension reads
   * the same text either way.
   */
  function pageKey(url = globalThis.location?.href ?? "") {
    const text = String(url);
    const fragment = text.indexOf("#");
    return fragment < 0 ? text : text.slice(0, fragment);
  }

  /** What to remember about a playhead, with the text to find it by again. */
  function entryFor({ text = "", charIndex = 0, title = "", at = Date.now() } = {}) {
    const index = Math.min(Math.max(charIndex | 0, 0), Math.max(0, text.length - 1));
    return {
      charIndex: index,
      anchor: text.slice(index, index + ANCHOR_CHARS),
      percent: text.length ? index / text.length : 0,
      title: String(title).slice(0, 120),
      at,
    };
  }

  /** Whether continuing from this position is worth offering at all. */
  function offered(entry) {
    return Boolean(
      entry?.anchor && entry.charIndex >= MIN_OFFER_CHARS && entry.percent < MAX_OFFER_FRACTION,
    );
  }

  /** The occurrence of `needle` closest to `near`, or -1. */
  function nearestOccurrence(text, needle, near) {
    let best = -1;
    let bestDistance = Infinity;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      const distance = Math.abs(at - near);
      if (distance >= bestDistance) continue;
      best = at;
      bestDistance = distance;
    }
    return best;
  }

  /**
   * Where this position is in the text as it is now, or -1 when the page has
   * changed too much to say. The stored index is tried first, so an unchanged
   * page costs one string comparison.
   */
  function locate(text, entry) {
    if (!text || !entry?.anchor) return -1;
    const at = Math.max(0, entry.charIndex | 0);
    if (text.startsWith(entry.anchor, at)) return at;

    const lengths = [entry.anchor.length, ...ANCHOR_PREFIXES].filter(
      (length, index, list) =>
        length >= MIN_ANCHOR_CHARS && length <= entry.anchor.length && list.indexOf(length) === index,
    );
    for (const length of lengths) {
      const found = nearestOccurrence(text, entry.anchor.slice(0, length), at);
      if (found >= 0) return found;
    }
    return -1;
  }

  /** Drop what has gone stale, keep the pages read most recently. */
  function prune(pages, now = Date.now()) {
    const kept = Object.entries(pages ?? {})
      .filter(([, entry]) => entry?.anchor && now - (entry.at ?? 0) < MAX_AGE_MS)
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_PAGES);
    return Object.fromEntries(kept);
  }

  const area = () => ns.ext?.storage?.local;

  async function all() {
    const stored = await area().get(STORE_KEY);
    const pages = stored?.[STORE_KEY];
    return pages && typeof pages === "object" ? pages : {};
  }

  // A position is a convenience. Every path below swallows its failures:
  // nothing about a read should break because storage would not answer.
  async function load(key = pageKey()) {
    try {
      const entry = (await all())[key];
      return entry?.anchor ? entry : null;
    } catch {
      return null;
    }
  }

  async function store(entry, key = pageKey()) {
    try {
      await area().set({ [STORE_KEY]: prune({ ...(await all()), [key]: entry }, entry.at) });
    } catch {
      // Nothing to do about it, and nothing worth saying.
    }
  }

  async function clear(key = pageKey()) {
    try {
      const pages = await all();
      if (!(key in pages)) return;
      delete pages[key];
      await area().set({ [STORE_KEY]: pages });
    } catch {
      // As above.
    }
  }

  ns.positions = {
    STORE_KEY,
    pageKey,
    entryFor,
    offered,
    locate,
    prune,
    load,
    store,
    clear,
  };
})(globalThis.__readAloud);
