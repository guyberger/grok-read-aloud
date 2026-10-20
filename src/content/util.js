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

  isWhitespace(char) {
    return char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";
  },
};
