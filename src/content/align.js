(function (ns) {
  "use strict";

  const isSpace = ns.util.isWhitespace;
  const SENTENCE_ENDERS = new Set([".", "!", "?", "…", "。", "！", "？"]);

  /**
   * Cut [from, to) into request-sized pieces, appending them to `ranges`.
   *
   * `limitAt` gives the size allowed for the nth piece of this segment, which
   * is how the first request can be small and the rest full-sized.
   */
  function chunkSegment(text, from, to, limitAt, ranges) {
    let start = from;
    let index = 0;

    while (start < to) {
      const limit = limitAt(index);
      index += 1;
      while (start < to && isSpace(text[start])) start += 1;
      if (start >= to) break;

      if (to - start <= limit) {
        ranges.push({ start, end: to });
        break;
      }

      const window = text.slice(start, start + limit);
      let cut = window.lastIndexOf("\n");
      if (cut < limit * 0.4) {
        cut = -1;
        for (let i = window.length - 1; i >= limit * 0.4; i -= 1) {
          if (SENTENCE_ENDERS.has(window[i]) && (i + 1 >= window.length || isSpace(window[i + 1]))) {
            cut = i + 1;
            break;
          }
        }
      }
      if (cut < 0) {
        for (let i = window.length - 1; i >= limit * 0.4; i -= 1) {
          if (isSpace(window[i])) {
            cut = i;
            break;
          }
        }
      }
      if (cut < 0) cut = window.length;

      const end = start + cut;
      ranges.push({ start, end });
      start = end;
    }
  }

  /**
   * Split text into request-sized pieces, preferring paragraph breaks, then
   * sentence ends, then any word boundary.
   *
   * `boundaries` forces a chunk to begin at each of those character indices.
   * Jumping into text no audio has been fetched for uses it to make the
   * request start at the word the reader is about to speak.
   *
   * `firstChars` caps the first piece of each segment and doubles from there
   * until it reaches `maxChars`. Synthesis is per-character work, so the wait
   * before the first sound is set by how much text the first request carries —
   * a small opening chunk is heard sooner, and by the time it has been spoken
   * there has been ample time to fetch a full-sized one. The ramp restarts at
   * every forced boundary, because jumping somewhere new has exactly the same
   * problem as starting does.
   *
   * @returns {{start:number,end:number}[]} global character ranges
   */
  function chunkRanges(text, maxChars, { boundaries = [], firstChars = 0 } = {}) {
    const limit = Math.max(200, maxChars | 0);
    const first = firstChars ? Math.min(Math.max(80, firstChars | 0), limit) : limit;
    const limitAt = (index) => Math.min(limit, first * 2 ** index);

    const cuts = [...new Set(boundaries)]
      .filter((cut) => cut > 0 && cut < text.length)
      .sort((a, b) => a - b);

    const ranges = [];
    let from = 0;
    for (const cut of [...cuts, text.length]) {
      chunkSegment(text, from, cut, limitAt, ranges);
      from = cut;
    }

    return ranges.filter((range) => text.slice(range.start, range.end).trim().length > 0);
  }

  /**
   * First character of the word covering `index`, so a click lands on a whole
   * word rather than halfway through one. A click in the gap between words
   * takes the word that follows, and one past the last word takes the last.
   */
  function wordStartAt(text, index) {
    if (!text.length) return 0;
    let i = Math.min(Math.max(index, 0), text.length - 1);

    if (isSpace(text[i])) {
      let forward = i;
      while (forward < text.length && isSpace(text[forward])) forward += 1;
      if (forward < text.length) return forward;
      while (i >= 0 && isSpace(text[i])) i -= 1;
      if (i < 0) return 0;
    }

    while (i > 0 && !isSpace(text[i - 1])) i -= 1;
    return i;
  }

  /** Index of the chunk holding `charIndex`. */
  function chunkIndexFor(chunks, charIndex) {
    if (!chunks?.length) return -1;
    for (let i = 0; i < chunks.length; i += 1) {
      if (charIndex < chunks[i].end) return i;
    }
    return chunks.length - 1;
  }

  /** Media time at which a chunk's timeline starts speaking `charIndex`. */
  function timeForCharIndex(timeline, charIndex) {
    const spans = timeline?.words;
    if (!spans?.length) return 0;
    const index = ns.util.lastAtOrBefore(spans, charIndex, "start");
    return index < 0 ? 0 : spans[index].t0;
  }

  /**
   * Map each character of the submitted text to its spoken time span.
   *
   * `graph_chars` mirrors the submitted text one-for-one when no pronunciation
   * replacements or normalisation are in play, so this is normally an exact
   * index walk. The small lookahead window keeps it from derailing if the API
   * ever inserts or drops a character.
   */
  function characterTimes(text, graphChars, graphTimes) {
    const length = text.length;
    const starts = new Float64Array(length).fill(NaN);
    const ends = new Float64Array(length).fill(NaN);
    if (!Array.isArray(graphChars) || !Array.isArray(graphTimes)) return null;

    let cursor = 0;
    for (let i = 0; i < length; i += 1) {
      const limit = Math.min(graphChars.length, cursor + 8);
      let match = -1;
      for (let p = cursor; p < limit; p += 1) {
        if (graphChars[p] === text[i]) {
          match = p;
          break;
        }
      }
      if (match === -1) continue;
      const pair = graphTimes[match];
      if (Array.isArray(pair) && pair.length >= 2) {
        starts[i] = pair[0];
        ends[i] = pair[1];
      }
      cursor = match + 1;
    }

    interpolateGaps(starts, ends);
    return { starts, ends };
  }

  function interpolateGaps(starts, ends) {
    const length = starts.length;
    let i = 0;
    while (i < length) {
      if (!Number.isNaN(starts[i])) {
        i += 1;
        continue;
      }
      const gapStart = i;
      while (i < length && Number.isNaN(starts[i])) i += 1;
      const before = gapStart > 0 ? ends[gapStart - 1] : 0;
      const after = i < length ? starts[i] : before;
      const span = Math.max(0, after - before);
      const step = span / (i - gapStart || 1);
      for (let k = gapStart; k < i; k += 1) {
        starts[k] = before + step * (k - gapStart);
        ends[k] = before + step * (k - gapStart + 1);
      }
    }
  }

  function tokenRanges(text, predicateEnd) {
    const tokens = [];
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
      const isBoundary = predicateEnd(text, i);
      if (!isSpace(text[i]) && start === -1) start = i;
      if (start !== -1 && isBoundary) {
        tokens.push({ start, end: i + 1 });
        start = -1;
      }
    }
    if (start !== -1) tokens.push({ start, end: text.length });
    return tokens;
  }

  function words(text) {
    return tokenRanges(text, (value, i) => i + 1 >= value.length || isSpace(value[i + 1]));
  }

  function sentences(text) {
    return tokenRanges(
      text,
      (value, i) =>
        value[i] === "\n" ||
        (SENTENCE_ENDERS.has(value[i]) && (i + 1 >= value.length || isSpace(value[i + 1]))),
    );
  }

  function timeSpans(tokens, times, text, duration) {
    let previousEnd = 0;
    return tokens.map((token) => {
      let t0 = Infinity;
      let t1 = -Infinity;
      if (times) {
        for (let i = token.start; i < token.end; i += 1) {
          if (!Number.isNaN(times.starts[i])) t0 = Math.min(t0, times.starts[i]);
          if (!Number.isNaN(times.ends[i])) t1 = Math.max(t1, times.ends[i]);
        }
      }
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
        // No usable timing: fall back to proportional placement.
        t0 = (token.start / Math.max(1, text.length)) * duration;
        t1 = (token.end / Math.max(1, text.length)) * duration;
      }
      t0 = Math.max(previousEnd, t0);
      t1 = Math.max(t0, t1);
      previousEnd = t0;
      return { start: token.start, end: token.end, t0, t1 };
    });
  }

  /**
   * Turn one synthesised chunk into word and sentence spans carrying absolute
   * (document-wide) character indices and media-time boundaries.
   */
  function buildChunkTimeline({ text, graphChars, graphTimes, globalStart = 0, duration = 0 }) {
    const times = characterTimes(text, graphChars, graphTimes);
    const total = duration || (times ? times.ends[times.ends.length - 1] || 0 : 0);
    const shift = (span) => ({
      start: span.start + globalStart,
      end: span.end + globalStart,
      t0: span.t0,
      t1: span.t1,
    });
    return {
      words: timeSpans(words(text), times, text, total).map(shift),
      sentences: timeSpans(sentences(text), times, text, total).map(shift),
      duration: total,
      aligned: Boolean(times),
    };
  }

  ns.align = {
    chunkRanges,
    characterTimes,
    words,
    sentences,
    buildChunkTimeline,
    wordStartAt,
    chunkIndexFor,
    timeForCharIndex,
  };
})(globalThis.__readAloud);
