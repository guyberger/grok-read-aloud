(function (ns) {
  "use strict";

  /**
   * How much listening is left.
   *
   * "Part 3 of 12" answers a question nobody asked: a part is a billing and
   * latency decision, its size changes when a jump re-cuts the chunks, and
   * three of twelve says nothing about whether this page fits in the walk to
   * the station. What a listener wants is the time.
   *
   * Speech is per-character work at a roughly steady rate, so the time left is
   * the characters left times the seconds a character takes. That rate is not
   * something to guess at for long: every chunk the API answers with reports
   * its own `duration`, so from the first one on the estimate is measured
   * against this voice, this language and this page's own prose rather than
   * against an average of somebody else's.
   */

  /**
   * The rate assumed until a chunk has come back — a little over 15 characters
   * a second, which is ordinary English narration. It is only ever the first
   * second or two of a read: the opening chunk answers, and from then on the
   * figure is measured.
   */
  const DEFAULT_SECONDS_PER_CHAR = 0.065;

  /**
   * Accumulates what the API has said about its own pace during one read.
   *
   * An average over every chunk so far rather than the last one: chunk
   * durations vary with how much of a chunk is punctuation and how long the
   * pauses in it are, and the estimate should not jump around because one
   * paragraph happened to be dialogue.
   */
  function createPace() {
    let chars = 0;
    let seconds = 0;
    return {
      /** What one synthesised chunk says about the pace. */
      record(charCount, durationSeconds) {
        if (!(charCount > 0) || !(durationSeconds > 0)) return;
        chars += charCount;
        seconds += durationSeconds;
      },
      /** Whether the rate below came from the API or from the default. */
      get measured() {
        return chars > 0;
      },
      get secondsPerChar() {
        return chars > 0 ? seconds / chars : DEFAULT_SECONDS_PER_CHAR;
      },
      reset() {
        chars = 0;
        seconds = 0;
      },
    };
  }

  /**
   * Seconds of listening left, at the speed the audio is playing at.
   *
   * The chunk being spoken is not estimated: its audio is in hand and its
   * duration came back with it, so what is left of it is known to the
   * millisecond. Only the text beyond it is multiplied out. That is what keeps
   * the number steady — it is exact over the next minute and approximate over
   * the next twenty, which is the right way round.
   *
   * Speed is a divisor rather than part of the rate, because the extension
   * changes speed on the audio element rather than re-synthesising: the same
   * audio at 2x is the same seconds of speech in half the time.
   */
  function remainingSeconds({
    playedSeconds = 0,
    chunkDuration = 0,
    charsAfterChunk = 0,
    secondsPerChar = DEFAULT_SECONDS_PER_CHAR,
    rate = 1,
  } = {}) {
    const inHand = Math.max(0, chunkDuration - playedSeconds);
    const ahead = Math.max(0, charsAfterChunk) * Math.max(0, secondsPerChar);
    const speed = rate > 0 ? rate : 1;
    return (inHand + ahead) / speed;
  }

  ns.pace = { DEFAULT_SECONDS_PER_CHAR, createPace, remainingSeconds };
})(globalThis.__readAloud);
