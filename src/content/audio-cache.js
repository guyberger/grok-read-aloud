(function (ns) {
  "use strict";

  /**
   * The audio a read has already paid for, kept for as long as the page is.
   *
   * Every chunk is a billed request and a second or two of waiting, so audio
   * in hand is the most valuable thing a read owns. Holding only the chunk
   * being spoken and its two neighbours means going back three paragraphs, or
   * reading a page a second time, buys the same seconds of speech again — and
   * waits for them again — when they were sitting in memory a moment ago.
   *
   * So what is fetched is kept until memory says otherwise. The budget is in
   * bytes because bytes are what a tab has to hold: at the 64 kbps the
   * extension asks for, the default is a little under an hour of speech, which
   * is more than any one page. When a page does run past it, the chunk that
   * has gone longest unplayed is the one to lose.
   */

  /** 24 MB — about fifty minutes of audio at 64 kbps. */
  const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

  /**
   * Audio for one stretch of text, as it was asked for.
   *
   * The voice and the language are part of the identity, not just the range:
   * the same words in another voice are different audio, and a chunk
   * prefetched before the setting changed must not be spoken after it.
   *
   * @typedef {{voiceId: string, language: string, start: number, end: number,
   *            text: string}} AudioRequest
   */

  function createAudioCache({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
    // A Map iterates in insertion order, which is made into recency order by
    // re-inserting an entry whenever it is used. The front of the iteration is
    // then the chunk that has gone longest without being wanted.
    const entries = new Map();
    let bytes = 0;

    const keyFor = ({ voiceId, language, start, end }) =>
      `${voiceId}\u0000${language}\u0000${start}-${end}`;

    function drop(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      bytes -= entry.size;
    }

    return {
      /** The key an in-flight request can be tracked under. */
      keyFor,

      /**
       * The audio for `request`, or null when it has to be fetched.
       *
       * A hit is checked against the text it was synthesised from, because a
       * character range is only an address: a page that rewrites itself under
       * a read — a route change, a thread that finished loading — leaves the
       * same range naming different words. Audio that no longer matches is
       * dropped rather than spoken over what is there now.
       */
      get(request) {
        const key = keyFor(request);
        const entry = entries.get(key);
        if (!entry) return null;
        if (entry.text !== request.text) {
          drop(key);
          return null;
        }
        entries.delete(key);
        entries.set(key, entry);
        return entry.value;
      },

      /** Keep `value`, evicting the least recently used audio to make room. */
      set(request, value) {
        const key = keyFor(request);
        drop(key);
        const size = value?.bytes?.byteLength ?? 0;
        entries.set(key, { text: request.text, value, size });
        bytes += size;

        // Never the entry just stored: it is the chunk about to be spoken, and
        // a budget is worth less than the request it would cost to fetch again.
        for (const oldest of entries.keys()) {
          if (bytes <= maxBytes || entries.size <= 1) break;
          drop(oldest);
        }
        return value;
      },

      /** Let go of everything — the page is going away. */
      clear() {
        entries.clear();
        bytes = 0;
      },

      /** What is held, for tests and for anything that reports on memory. */
      get stats() {
        return { count: entries.size, bytes, maxBytes };
      },
    };
  }

  ns.audioCache = { createAudioCache, DEFAULT_MAX_BYTES };
})(globalThis.__readAloud);
