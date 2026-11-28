(function (ns) {
  "use strict";

  const isSpace = ns.util.isWhitespace;
  const SENTENCE_ENDERS = new Set([".", "!", "?", "…", "。", "！", "？"]);

  /**
   * Punctuation that can sit between a full stop and the space after it. A
   * sentence ends after the quote mark that closes it, not before it — cut at
   * the stop and `He said "Stop."` leaves a stray `"` to open the next one.
   */
  const CLOSERS = new Set(['"', "'", "”", "’", "»", "›", ")", "]", "}", "」", "』", "〉"]);

  /**
   * Words that take a full stop without finishing a sentence. Without this,
   * every `Dr. Mair` and `e.g. the flag` is two sentences: stepping back lands
   * on a two-letter fragment, the tint covers a title rather than a clause,
   * and — the audible one — a chunk can be cut there, so the API is handed
   * text ending in `led by Dr.` and reads the name with a full stop in it.
   *
   * Only words that rarely end a sentence are listed. `etc.` and `No.` are
   * deliberately absent: both finish sentences often enough that joining them
   * to the next one would be the commoner mistake.
   */
  const ABBREVIATIONS = new Set([
    // Titles and forms of address.
    "mr", "mrs", "ms", "mx", "dr", "prof", "rev", "hon", "sr", "jr", "st", "fr",
    "gen", "col", "sgt", "capt", "lt", "maj", "pres", "gov", "sen", "rep",
    // References and editorial shorthand.
    "al", "ca", "cf", "viz", "approx", "est", "fig", "figs", "eq", "eqs", "ref",
    "refs", "vol", "vols", "ch", "chs", "sec", "secs", "pp", "para", "ed", "eds",
    "trans", "repr", "dept", "univ", "vs",
    // Company suffixes.
    "inc", "ltd", "corp", "co", "llc", "plc", "bros",
    // Places.
    "mt", "ave", "rd", "blvd", "apt",
    // Months and days, which are abbreviated in dates far more often than they
    // are written at the end of a sentence.
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov",
    "dec", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  ]);

  const LETTER = /\p{L}/u;
  const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

  /**
   * Whether the full stop at `dot` belongs to an abbreviation rather than to
   * the end of a sentence.
   *
   * A single letter standing on its own covers the dotted forms in one rule:
   * the last stop of `U.S.`, `a.m.`, `e.g.` and `Ph.D.` all follow one letter
   * whose own predecessor is a stop, and the stops in `J. R. R. Tolkien`
   * follow one letter after a space. A stop after a digit — `in 1999.` — is
   * not an abbreviation at all.
   */
  function abbreviates(text, dot) {
    let start = dot;
    while (start > 0 && LETTER.test(text[start - 1])) start -= 1;
    if (start === dot) return false;
    if (dot - start === 1 && (start === 0 || !LETTER_OR_DIGIT.test(text[start - 1]))) return true;
    return ABBREVIATIONS.has(text.slice(start, dot).toLowerCase());
  }

  /**
   * Whether a sentence ends at `index` — the one place the three things that
   * care agree: the spans the tint and the sentence steps walk, and the points
   * a chunk may be cut at.
   *
   * A sentence ends on a terminator (or the last of the quotes and brackets
   * closing over it) that whitespace follows, unless the terminator is a full
   * stop an abbreviation owns. A newline ends one outright: a heading or a
   * list item carries no punctuation of its own.
   */
  function sentenceEndsAt(text, index) {
    const char = text[index];
    if (char === "\n") return true;
    if (!SENTENCE_ENDERS.has(char) && !CLOSERS.has(char)) return false;
    if (index + 1 < text.length && !isSpace(text[index + 1])) return false;

    let stop = index;
    while (stop >= 0 && CLOSERS.has(text[stop])) stop -= 1;
    if (stop < 0 || !SENTENCE_ENDERS.has(text[stop])) return false;
    return text[stop] === "." ? !abbreviates(text, stop) : true;
  }

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
          // Asked of the whole text rather than the window, so the look-back
          // for an abbreviation is not truncated at the window's edge and the
          // character after the last one in the window is the real one.
          if (sentenceEndsAt(text, start + i)) {
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

      // A heading or other short line left as the tail of this request is
      // spoken as the end of an utterance, and the paragraph under it starts
      // the next request from cold — which is the voice changing between the
      // two. Keep the short line with the text it introduces instead.
      const end = joinShortLine(text, start, start + cut, limit);
      ranges.push({ start, end });
      start = end;
    }
  }

  /**
   * How short a line has to be before it is kept with the text after it.
   * A heading, or a one-line fragment, is about this long; a sentence of
   * prose is longer, and still ends a chunk on its own.
   */
  const SHORT_LINE_CHARS = 64;

  /** Index of the line `end` closes, or `start` when the chunk is one line. */
  function lineStart(text, start, end) {
    for (let i = end - 1; i >= start; i -= 1) {
      if (text[i] === "\n") return i + 1;
    }
    return start;
  }

  /**
   * Move a cut that would finish on a short line back to the start of that
   * line, so the line opens the next chunk. Only when the chunk that remains
   * is still a reasonable size — the same floor the search above uses.
   */
  function joinShortLine(text, start, end, limit) {
    const from = lineStart(text, start, end);
    if (from <= start) return end;
    const line = text.slice(from, end).trim();
    if (!line || line.length >= SHORT_LINE_CHARS) return end;
    if (from - start < limit * 0.4) return end;
    return from;
  }

  /**
   * How much of the text before a chunk is submitted with it, so the model
   * speaks the chunk as a continuation of that sentence rather than as a new
   * utterance. The audio for this prefix is not played.
   */
  const CONTEXT_CHARS = 200;

  /**
   * The sentence immediately before `start`, capped at `maxChars`.
   *
   * Empty at the top of the text, where starting fresh is the right delivery.
   * The returned string is exactly the slice of `text` that ends at `start`,
   * so concatenating it with the chunk reconstructs the original text and the
   * timestamps stay aligned to it.
   */
  function leadingContext(text, start, maxChars = CONTEXT_CHARS) {
    if (!text || start <= 0) return "";
    let cursor = Math.min(start, text.length) - 1;
    while (cursor >= 0 && isSpace(text[cursor])) cursor -= 1;
    if (cursor < 0) return "";
    // Step off this sentence's own terminator. The break it ends on is not
    // the one before it, and a quote closing over a stop is the terminator
    // even though the stop itself is not followed by whitespace.
    while (cursor >= 0 && sentenceEndsAt(text, cursor)) cursor -= 1;
    if (cursor < 0) return "";

    const from = Math.max(0, start - maxChars);
    let contextStart = from;
    for (let i = cursor; i >= from; i -= 1) {
      if (sentenceEndsAt(text, i)) {
        contextStart = i + 1;
        break;
      }
    }
    while (contextStart < start && isSpace(text[contextStart])) contextStart += 1;
    // The cap opened in the middle of a word. Advance to the next one so the
    // model is not handed a stump.
    if (
      contextStart === from &&
      from > 0 &&
      !isSpace(text[from - 1]) &&
      !sentenceEndsAt(text, from - 1)
    ) {
      while (contextStart < start && !isSpace(text[contextStart])) contextStart += 1;
      while (contextStart < start && isSpace(text[contextStart])) contextStart += 1;
    }
    if (contextStart >= start || !text.slice(contextStart, start).trim()) return "";
    return text.slice(contextStart, start);
  }

  /**
   * Timestamps and duration for the spoken part of a submission.
   *
   * `submission` is the context prefix plus the chunk. The prefix is what
   * keeps the voice continuous, and it is skipped on playback: `lead` is how
   * far into the audio the chunk itself starts, and the returned timestamps
   * are shifted so the chunk's first character is at time 0.
   */
  function withoutContext({ submission, contextChars = 0, graphChars, graphTimes, duration = 0 }) {
    if (!contextChars) return { graphChars, graphTimes, duration, lead: 0 };
    const times = characterTimes(submission, graphChars, graphTimes);
    if (!times) {
      const lead = duration > 0 ? (duration * contextChars) / submission.length : 0;
      return { graphChars: null, graphTimes: null, duration: Math.max(0, duration - lead), lead };
    }
    const rawLead =
      contextChars >= submission.length ? times.ends[submission.length - 1] : times.starts[contextChars];
    const lead = Number.isNaN(rawLead) || rawLead == null ? 0 : Math.max(0, rawLead);
    const spoken = submission.slice(contextChars);
    const chars = [];
    const pairs = [];
    // One entry per code point, the same shape the API uses, so the chunk
    // timeline is not handed a surrogate half as if it were a character.
    for (let i = 0; i < spoken.length; ) {
      const width = spoken.codePointAt(i) > 0xffff ? 2 : 1;
      const at = contextChars + i;
      const start = times.starts[at];
      const end = times.ends[at + width - 1];
      chars.push(spoken.slice(i, i + width));
      pairs.push([
        Math.max(0, (Number.isNaN(start) ? lead : start) - lead),
        Math.max(0, (Number.isNaN(end) ? lead : end) - lead),
      ]);
      i += width;
    }
    const full = duration || times.ends[submission.length - 1] || lead;
    return { graphChars: chars, graphTimes: pairs, duration: Math.max(0, full - lead), lead };
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
   * A short line — a heading, a single fragment — is not left as the tail of a
   * chunk. Spoken there, it finishes the utterance, and the paragraph it
   * introduces starts the next request as a new one, which is the voice
   * changing between them. The line opens the next chunk instead, so it is
   * synthesised with the text under it.
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

  /**
   * Index of the span holding `charIndex`, in a list of ranges that covers the
   * text in order. A character in the gap between two spans belongs to the one
   * that follows it, and anything past the end belongs to the last.
   */
  function spanIndexFor(spans, charIndex) {
    if (!spans?.length) return -1;
    for (let i = 0; i < spans.length; i += 1) {
      if (charIndex < spans[i].end) return i;
    }
    return spans.length - 1;
  }

  /** Index of the chunk holding `charIndex`. */
  function chunkIndexFor(chunks, charIndex) {
    return spanIndexFor(chunks, charIndex);
  }

  /**
   * First character of the sentence `offset` sentences from the one covering
   * `charIndex`, or -1 when there is no such sentence.
   *
   * An `offset` of 0 is the start of the sentence being read, which is what
   * stepping back from the middle of one resolves to: a listener who missed a
   * few words wants that sentence again, not the one before it.
   */
  function sentenceStartFrom(spans, charIndex, offset = 0) {
    const index = spanIndexFor(spans, charIndex);
    if (index < 0) return -1;
    const target = index + offset;
    if (target < 0 || target >= spans.length) return -1;
    return spans[target].start;
  }

  /**
   * Seconds already heard of the sentence that contains `charIndex`.
   *
   * A chunk join is not a sentence boundary. The sentence being spoken may
   * have begun in an earlier chunk, and the clock of the chunk just started
   * is then near zero — how far into this chunk the voice is, not how far
   * into the sentence. Earlier chunks add the audio of this sentence they
   * already played. A chunk whose audio is no longer in hand adds
   * `secondsPerChar` for the characters of the sentence it held, because the
   * join was only reached by finishing that chunk.
   *
   * `pieces` are the chunks in order. `current` is the piece the playhead is
   * in, and `playhead` is that piece's media time, past any unspoken lead-in.
   */
  function spokenIntoSentence({ spans, charIndex, pieces, current, playhead = 0 } = {}) {
    if (!pieces?.length || current < 0 || current >= pieces.length) return 0;
    const start = sentenceStartFrom(spans, charIndex, 0);
    if (start < 0) return 0;
    const here = pieces[current];
    if (start >= here.start) return Math.max(0, playhead - timeForCharIndex(here.timeline, start));

    let elapsed = Math.max(0, playhead);
    for (let index = current - 1; index >= 0; index -= 1) {
      const piece = pieces[index];
      if (piece.end <= start) break;
      elapsed += heardFrom(piece, Math.max(start, piece.start));
      if (piece.start <= start) break;
    }
    return elapsed;
  }

  /** Audio of `piece` from `from` through the end of that chunk. */
  function heardFrom(piece, from) {
    const duration = piece.timeline?.duration;
    if (Number.isFinite(duration) && duration > 0) {
      return Math.max(0, duration - timeForCharIndex(piece.timeline, from));
    }
    if (piece.timeline) return 0;
    const rate = piece.secondsPerChar;
    if (!(rate > 0)) return 0;
    return Math.max(0, piece.end - from) * rate;
  }

  /**
   * First character a step of `delta` lands on, or -1 past the end of the text.
   *
   * Back replays the sentence being spoken once `elapsed` seconds of it have
   * been heard, and steps to the one before when that sentence has barely
   * begun. `elapsed` is what `spokenIntoSentence` reports, so a sentence that
   * crosses a chunk join counts the audio from the chunk where it started.
   * Forward always leaves the sentence being spoken, whether or not a join
   * falls inside it. Back from the first sentence restarts it.
   */
  function sentenceStepTarget(spans, charIndex, delta, { elapsed = 0, replayAfter = 1.5 } = {}) {
    const heard = Number.isFinite(elapsed) ? elapsed : 0;
    const offset = delta < 0 ? (heard > replayAfter ? 0 : -1) : 1;
    let target = sentenceStartFrom(spans, charIndex, offset);
    if (target < 0 && offset < 0) target = sentenceStartFrom(spans, charIndex, 0);
    return target;
  }

  /** Media time at which a chunk's timeline starts speaking `charIndex`. */
  function timeForCharIndex(timeline, charIndex) {
    const spans = timeline?.words;
    if (!spans?.length) return 0;
    const index = ns.util.lastAtOrBefore(spans, charIndex, "start");
    return index < 0 ? 0 : spans[index].t0;
  }

  /**
   * Map each UTF-16 unit of the submitted text to its spoken time span.
   *
   * The API's `graph_chars` is one string per Unicode code point: an emoji is
   * one entry there and two units in a JavaScript string. A cluster — a
   * skin-tone emoji, a ZWJ sequence, a flag, a letter plus a combining mark —
   * is several of those code points, and a caller may also have packed the
   * whole cluster into one entry or split it into surrogate halves. All three
   * shapes are read back into code points before anything is compared, and
   * the page text is walked the same way, so the two sides agree on what a
   * character is.
   *
   * The match itself is a diff, not a fixed look-ahead. A window of eight
   * loses the rest of the line once eight unmatched entries sit in front of
   * it, which is exactly what a row of emoji did, and what any longer run of
   * symbols would do even after the units agree.
   */
  function characterTimes(text, graphChars, graphTimes) {
    if (!Array.isArray(graphChars) || !Array.isArray(graphTimes)) return null;
    const length = text.length;
    const starts = new Float64Array(length).fill(NaN);
    const ends = new Float64Array(length).fill(NaN);
    if (length && graphChars.length) {
      const page = codePointsOf(text);
      const heard = codePointsFromGraph(graphChars, graphTimes);
      const matched = alignUnits(
        page.map((point) => point.text),
        heard.map((point) => point.text),
      );
      for (let i = 0; i < page.length; i += 1) {
        const at = matched[i];
        if (at < 0) continue;
        const timing = heard[at];
        if (!Number.isFinite(timing.t0) || !Number.isFinite(timing.t1)) continue;
        const point = page[i];
        for (let unit = point.start; unit < point.end; unit += 1) {
          starts[unit] = timing.t0;
          ends[unit] = timing.t1;
        }
      }
    }
    interpolateGaps(starts, ends);
    return { starts, ends };
  }

  /** Code points of `text`, each with the UTF-16 span it occupies. */
  function codePointsOf(text) {
    const points = [];
    for (let i = 0; i < text.length; ) {
      const width = text.codePointAt(i) > 0xffff ? 2 : 1;
      points.push({ text: text.slice(i, i + width), start: i, end: i + width });
      i += width;
    }
    return points;
  }

  function isHighSurrogate(char) {
    if (char.length !== 1) return false;
    const code = char.charCodeAt(0);
    return code >= 0xd800 && code <= 0xdbff;
  }

  function isLowSurrogate(char) {
    if (char.length !== 1) return false;
    const code = char.charCodeAt(0);
    return code >= 0xdc00 && code <= 0xdfff;
  }

  /** `[start, end]` in seconds, or null when the entry is not a usable pair. */
  function timePair(pair) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const start = Number(pair[0]);
    const end = Number(pair[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return [start, end];
  }

  /**
   * Code points of `graphChars`, in order, each carrying the time span of the
   * entry it came from.
   *
   * An entry that already holds several code points — a family emoji, a flag,
   * a skin tone — shares that one span across them. Two entries that are the
   * halves of one surrogate pair are one code point again, timed from the
   * first half's start to the second half's end.
   */
  function codePointsFromGraph(graphChars, graphTimes) {
    const points = [];
    for (let index = 0; index < graphChars.length; index += 1) {
      const piece = graphChars[index] == null ? "" : String(graphChars[index]);
      if (!piece) continue;
      const next = index + 1 < graphChars.length ? String(graphChars[index + 1] ?? "") : "";
      if (isHighSurrogate(piece) && isLowSurrogate(next)) {
        const span = spanAcross(timePair(graphTimes[index]), timePair(graphTimes[index + 1]));
        points.push({ text: piece + next, t0: span[0], t1: span[1] });
        index += 1;
        continue;
      }
      const span = timePair(graphTimes[index]) ?? [NaN, NaN];
      for (const point of codePointsOf(piece)) {
        points.push({ text: point.text, t0: span[0], t1: span[1] });
      }
    }
    return points;
  }

  /** The earliest start and the latest end of the pairs that were present. */
  function spanAcross(first, second) {
    const pairs = [first, second].filter(Boolean);
    if (!pairs.length) return [NaN, NaN];
    return [
      Math.min(...pairs.map((pair) => pair[0])),
      Math.max(...pairs.map((pair) => pair[1])),
    ];
  }

  /**
   * For each unit of `page`, the index of the same unit in `heard`, or -1
   * when the reply never reported it. Inserted reply units are skipped.
   * Identical sequences take the direct path; anything else is a diff of the
   * region the shared prefix and suffix do not already explain.
   */
  function alignUnits(page, heard) {
    const n = page.length;
    const m = heard.length;
    const map = new Array(n).fill(-1);
    if (!n || !m) return map;

    let prefix = 0;
    while (prefix < n && prefix < m && page[prefix] === heard[prefix]) {
      map[prefix] = prefix;
      prefix += 1;
    }
    if (prefix === n && prefix === m) return map;

    let suffix = 0;
    while (
      suffix < n - prefix &&
      suffix < m - prefix &&
      page[n - 1 - suffix] === heard[m - 1 - suffix]
    ) {
      suffix += 1;
    }
    for (let k = 0; k < suffix; k += 1) map[n - 1 - k] = m - 1 - k;

    const nMid = n - prefix - suffix;
    const mMid = m - prefix - suffix;
    if (!nMid || !mMid) return map;

    const mid = diffUnits(page.slice(prefix, prefix + nMid), heard.slice(prefix, prefix + mMid));
    for (let i = 0; i < nMid; i += 1) {
      if (mid[i] >= 0) map[prefix + i] = prefix + mid[i];
    }
    return map;
  }

  /**
   * Longest common subsequence, so an insertion or a deletion of any length
   * stays local. Past a couple of million cells the middle is no longer a
   * small edit and a forward scan is used instead — still with no cap on how
   * far the next real character may be.
   */
  function diffUnits(page, heard) {
    const n = page.length;
    const m = heard.length;
    if (n * m > 2_000_000) return greedyUnits(page, heard);

    const choice = new Uint8Array(n * m);
    let prev = new Int32Array(m + 1);
    let curr = new Int32Array(m + 1);
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        const cell = (i - 1) * m + (j - 1);
        if (page[i - 1] === heard[j - 1]) {
          curr[j] = prev[j - 1] + 1;
          choice[cell] = 0;
        } else if (prev[j] >= curr[j - 1]) {
          curr[j] = prev[j];
          choice[cell] = 1;
        } else {
          curr[j] = curr[j - 1];
          choice[cell] = 2;
        }
      }
      const swap = prev;
      prev = curr;
      curr = swap;
      curr.fill(0);
    }

    const map = new Array(n).fill(-1);
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      const taken = choice[(i - 1) * m + (j - 1)];
      if (taken === 0 && page[i - 1] === heard[j - 1]) {
        map[i - 1] = j - 1;
        i -= 1;
        j -= 1;
      } else if (taken === 1) {
        i -= 1;
      } else {
        j -= 1;
      }
    }
    return map;
  }

  /** Nearest later equal unit, with no limit on the gap in front of it. */
  function greedyUnits(page, heard) {
    const lists = new Map();
    for (let j = 0; j < heard.length; j += 1) {
      const list = lists.get(heard[j]);
      if (list) list.push(j);
      else lists.set(heard[j], [j]);
    }
    const cursor = new Map();
    const map = new Array(page.length).fill(-1);
    let from = 0;
    for (let i = 0; i < page.length; i += 1) {
      const list = lists.get(page[i]);
      if (!list) continue;
      let at = cursor.get(page[i]) ?? 0;
      while (at < list.length && list[at] < from) at += 1;
      cursor.set(page[i], at);
      if (at >= list.length) continue;
      map[i] = list[at];
      from = list[at] + 1;
      cursor.set(page[i], at + 1);
    }
    return map;
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
    return tokenRanges(text, sentenceEndsAt);
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
    sentenceEndsAt,
    buildChunkTimeline,
    wordStartAt,
    spanIndexFor,
    chunkIndexFor,
    sentenceStartFrom,
    spokenIntoSentence,
    sentenceStepTarget,
    timeForCharIndex,
    leadingContext,
    withoutContext,
    CONTEXT_CHARS,
  };
})(globalThis.__readAloud);
