// Injected as a classic script, so everything hangs off one shared namespace
// and every file must be safe to evaluate twice.
var ReadAloud = (globalThis.__readAloud = globalThis.__readAloud || {});

ReadAloud.ext = globalThis.browser || globalThis.chrome;

ReadAloud.util = {
  clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  },

  base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },

  /** Index of the last entry whose `start` is <= value, or -1. */
  lastAtOrBefore(items, value, key = "t0") {
    let low = 0;
    let high = items.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (items[mid][key] <= value) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  },

  /**
   * A space, including the ones a page uses instead of U+0020.
   *
   * A no-break space, a thin space and an ideographic space still separate
   * words: `20 km` is two of them, and a sentence can end in front of one.
   * A zero-width space is not a space separator, but it is a word boundary
   * in scripts that do not write a space of their own, so it counts as one
   * here too. A newline, a tab and the other ASCII whitespace collapse the
   * way HTML whitespace does.
   */
  isWhitespace(char) {
    return (
      char === "\n" ||
      char === "\t" ||
      char === "\r" ||
      char === "\f" ||
      char === "\u000b" ||
      char === "\u200B" ||
      /\p{Zs}/u.test(char)
    );
  },

  /**
   * A line or paragraph separator written as a character. HTML turns a
   * newline in the source into a space; these two do not.
   */
  isLineBreak(char) {
    return char === "\u2028" || char === "\u2029";
  },

  /**
   * A character that is in the text and has nothing to say.
   *
   * A soft hyphen only exists so a line may break; the word on either side
   * of it is one word. The rest are direction marks, a word joiner and the
   * object-replacement character an inline image leaves behind. A zero-width
   * joiner is absent on purpose: it is what holds an emoji sequence together.
   */
  isSilent(char) {
    return /[\u00AD\u061C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\uFFFC]/u.test(char);
  },
};
