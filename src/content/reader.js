(function (ns) {
  "use strict";

  if (ns.reader) {
    ns.reader.refreshSettings();
    return;
  }

  const {
    ext,
    util,
    extract,
    align,
    highlight,
    pointer,
    positions,
    handoff,
    pace,
    controls,
    player: playerFactory,
  } = ns;

  const PREFETCH_AHEAD = 1;

  /**
   * How often the playhead is written down while a page is being read. A
   * position is only ever read when a later read starts, so the cost of
   * being a few seconds behind is a few seconds of text heard twice.
   */
  const REMEMBER_EVERY_MS = 5000;

  /**
   * Cap on the first request of a read, and of a jump. The API charges by the
   * character and synthesises at roughly a fixed rate, so the wait before the
   * first sound is set by this number rather than by anything the extension
   * does locally. Around one or two sentences: short enough to start quickly,
   * long enough to land on a sentence boundary rather than mid-clause.
   */
  const FIRST_CHUNK_CHARS = 240;

  /**
   * How far into a sentence the playhead has to be for stepping back to mean
   * "read that sentence again" rather than "read the one before it". Pressing
   * back is how a listener recovers a few words they missed, and those words
   * are almost always in the sentence still being spoken.
   */
  const REPLAY_AFTER_SECONDS = 1.5;

  const state = {
    status: "idle", // idle | loading | playing | paused | error
    scope: "page",
    chunkIndex: 0,
    chunkCount: 0,
    error: "",
    notice: "",
    engine: "none",
    aligned: true,
  };

  /**
   * Where this page was left off, when that is somewhere worth continuing
   * from. The popup reads it to offer the choice; `start` acts on it.
   */
  let resumePoint = null;
  let rememberedAt = 0;
  let everPlayed = false;

  const BLOCKED_NOTICE = "Audio is blocked until you interact with this page — click anywhere to start.";
  const HANDOFF_NOTICE = "Paused — a read started in another tab.";

  let settings = {
    voiceId: "eve",
    language: "en",
    rate: 1,
    chunkChars: 1200,
    autoScroll: true,
    highlightColor: "#ffd34d",
    sentenceTint: true,
    clickToJump: true,
    readCodeBlocks: false,
    hasApiKey: false,
    signedIn: false,
    hasCredential: false,
  };

  let doc = null;
  let chunks = [];
  // Sentence ranges over the whole extracted text, built on first use. A
  // chunk's own timeline only knows the sentences inside that chunk, and
  // stepping between sentences has to cross both chunk boundaries and the
  // joins where a sentence was cut in two.
  let sentences = null;
  let timeline = null;
  // Keyed by character range rather than chunk index, because clicking into
  // text nothing has been fetched for re-cuts the chunks and the audio already
  // in hand must survive that.
  let cache = new Map();
  let inflight = new Map();
  // What the API has said about how long its audio runs per character of this
  // read, which is what turns the characters left into minutes left.
  const pacing = pace.createPace();
  let nextRequestId = 1;
  let player = null;
  let frame = 0;
  let sessionId = 0;
  let lastWord = -1;
  let lastSentence = -1;
  let lastPaintKey = "";

  function emit() {
    const state = snapshot();
    // The browser's media controls are shown the same thing the popup is, on
    // the same transitions, so the two can never disagree about whether this
    // page is talking.
    controls.update(state);
    ext.runtime.sendMessage({ type: "stateChanged", state }).catch(() => {});
  }

  function snapshot() {
    const chunkProgress = progressWithinChunk();
    return {
      ...state,
      resume: resumePoint ? { percent: resumePoint.percent } : null,
      progress:
        state.chunkCount > 0
          ? util.clamp((state.chunkIndex + chunkProgress) / state.chunkCount, 0, 1)
          : 0,
      remainingSeconds: remainingSeconds(),
      rate: settings.rate,
      voiceId: settings.voiceId,
      hasApiKey: settings.hasApiKey,
      signedIn: settings.signedIn,
      hasCredential: settings.hasCredential,
      title: document.title,
    };
  }

  function progressWithinChunk() {
    if (!player || !timeline?.duration) return 0;
    return util.clamp(player.getTime() / timeline.duration, 0, 1);
  }

  /**
   * How long there is left to listen, or null when nothing is being read.
   *
   * While a chunk is loading its timeline still describes the previous one, so
   * nothing is taken as being in hand: the estimate runs from the character
   * the next audio starts at, which is where the listener actually is.
   */
  function remainingSeconds() {
    if (!doc || !chunks.length || !ACTIVE.has(state.status)) return null;
    const inHand = timeline && player && state.status !== "loading";
    const from = inHand ? chunks[state.chunkIndex].end : playheadCharIndex();
    return pace.remainingSeconds({
      playedSeconds: inHand ? player.getTime() : 0,
      chunkDuration: inHand ? timeline.duration : 0,
      charsAfterChunk: doc.text.length - from,
      secondsPerChar: pacing.secondsPerChar,
      rate: settings.rate,
    });
  }

  async function refreshSettings() {
    try {
      const response = await ext.runtime.sendMessage({ type: "getPublicSettings" });
      if (response?.ok) settings = { ...settings, ...response.settings };
    } catch {
      // Keep the previous snapshot.
    }
    highlight.configure(settings);
    player?.setRate(settings.rate);
  }

  function ensurePlayer() {
    if (player) return player;
    player = playerFactory.createPlayer({
      onEnded: () => advance(),
      onBlocked: () => {
        state.notice = BLOCKED_NOTICE;
        highlight.notify(BLOCKED_NOTICE);
        emit();
      },
      // Something outside the extension reached the audio: the media controls,
      // or anything in the system that takes audio over. The read follows it,
      // rather than leaving a popup that says Playing above a highlight that
      // has stopped moving — and the place is kept, so taking it back is one
      // press of the same button.
      onPausedOutside: () => pause(),
      onResumedOutside: () => {
        resume().catch(reportError);
      },
    });
    player.setRate(settings.rate);
    // Attached with the player rather than at injection: until a read starts,
    // the media session is the page's own.
    controls.attach({
      play: () => resume(),
      pause: () => pause(),
      stop: () => stop(),
      previous: () => skipSentence(-1),
      next: () => skipSentence(1),
    });
    return player;
  }

  const cacheKey = (chunk) => `${chunk.start}:${chunk.end}`;

  function requestChunk(index) {
    const chunk = chunks[index];
    if (!chunk) return Promise.resolve();
    const key = cacheKey(chunk);
    if (cache.has(key)) return Promise.resolve();

    const pending = inflight.get(key);
    if (pending) return pending.promise;

    const requestId = `${sessionId}-${nextRequestId++}`;
    const text = doc.text.slice(chunk.start, chunk.end);
    const promise = (async () => {
      const response = await ext.runtime.sendMessage({
        type: "synthesize",
        requestId,
        text,
        voiceId: settings.voiceId,
        language: settings.language,
      });
      if (!response?.ok) throw new Error(response?.error || "Synthesis failed.");
      // The worker says here when it had to fall back from the xAI sign-in to
      // the API key. The audio is fine; the user still wants to know.
      if (response.notice && state.notice !== response.notice) {
        state.notice = response.notice;
        emit();
      }

      // What this chunk cost in audio seconds per character of text, which is
      // what the estimate of the time left is built from.
      pacing.record(text.length, response.duration);

      cache.set(key, {
        bytes: util.base64ToBytes(response.audio),
        contentType: response.contentType,
        timeline: align.buildChunkTimeline({
          text,
          graphChars: response.graphChars,
          graphTimes: response.graphTimes,
          globalStart: chunk.start,
          duration: response.duration,
        }),
      });
    })().finally(() => {
      if (inflight.get(key)?.requestId === requestId) inflight.delete(key);
    });

    inflight.set(key, { promise, requestId });
    return promise;
  }

  /**
   * Drop every request whose audio is no longer wanted. The worker holds the
   * only fetch, so it is the one that can actually cancel it.
   */
  function abortRequests(keep = new Set()) {
    for (const [key, entry] of [...inflight]) {
      if (keep.has(key)) continue;
      inflight.delete(key);
      ext.runtime.sendMessage({ type: "abortSynthesis", requestId: entry.requestId }).catch(() => {});
    }
  }

  function neighbourKeys(index) {
    const keys = new Set();
    for (let i = index - 1; i <= index + PREFETCH_AHEAD; i += 1) {
      if (chunks[i]) keys.add(cacheKey(chunks[i]));
    }
    return keys;
  }

  function prefetch(index) {
    for (let i = index + 1; i <= index + PREFETCH_AHEAD; i += 1) {
      requestChunk(i).catch(() => {});
    }
    const keep = neighbourKeys(index);
    for (const key of cache.keys()) {
      if (!keep.has(key)) cache.delete(key);
    }
  }

  async function playChunk(index, startTime = 0) {
    const session = sessionId;
    state.status = "loading";
    state.chunkIndex = index;
    emit();

    // Both requests go out before either answer is waited on. The one after
    // this chunk is wanted either way, and issuing it now rather than once
    // this chunk is playing gives it the whole of this chunk's synthesis time
    // to arrive in — which is what keeps a small opening chunk from simply
    // moving the wait to the first join.
    const wanted = requestChunk(index);
    prefetch(index);

    await wanted;
    if (session !== sessionId) return;

    const entry = cache.get(cacheKey(chunks[index]));
    if (!entry) return;
    timeline = entry.timeline;
    state.aligned = entry.timeline.aligned;
    lastWord = -1;
    lastSentence = -1;

    const audio = ensurePlayer();
    await audio.load(entry.bytes, entry.contentType);
    if (session !== sessionId) return;

    audio.setRate(settings.rate);
    if (startTime > 0) audio.seek(startTime);
    state.status = "playing";
    state.engine = audio.engineName;
    emit();

    update();
    // Taking the read silences whichever other tab had it. It happens as this
    // tab starts speaking rather than when the read was asked for, so a read
    // that never gets as far as audio — no credential, a request that failed
    // — never silences a tab that is working.
    handoff.take();
    await audio.play();
    if (session !== sessionId) return;
    if (state.notice === BLOCKED_NOTICE) {
      state.notice = "";
      emit();
    }
    everPlayed = true;
    // A chunk boundary is a position worth keeping even in a tab that is not
    // on screen, where the frame loop — and with it the periodic write —
    // stops but the audio carries on.
    rememberPosition({ force: true });
    startLoop();
  }

  function advance() {
    if (state.status !== "playing") return;
    const next = state.chunkIndex + 1;
    if (next >= chunks.length) {
      finish();
      return;
    }
    playChunk(next).catch(reportError);
  }

  function finish() {
    stopLoop();
    // The page was heard to the end, so there is nothing left to continue.
    forgetPosition();
    highlight.setWord(null);
    highlight.setSentence(null);
    state.status = "idle";
    state.chunkIndex = chunks.length ? chunks.length - 1 : 0;
    emit();
  }

  function reportError(error) {
    stopLoop();
    // A read that broke part-way through is the clearest case for remembering
    // a position: trying again then carries on from the chunk that failed
    // rather than paying to synthesise the page from the top again.
    rememberPosition({ force: true });
    state.status = "error";
    state.error = error?.message || String(error);
    highlight.notify(state.error);
    emit();
  }

  function startLoop() {
    stopLoop();
    const tick = () => {
      frame = requestAnimationFrame(tick);
      update();
    };
    frame = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function update() {
    if (!timeline || !player) return;
    const time = player.getTime();
    const wordIndex = util.lastAtOrBefore(timeline.words, time);
    const sentenceIndex = util.lastAtOrBefore(timeline.sentences, time);

    const paintKey = `${Math.round(window.scrollY)}:${window.innerWidth}`;
    const moved = wordIndex !== lastWord || sentenceIndex !== lastSentence;
    const needsRepaint = !highlight.supportsHighlightApi && paintKey !== lastPaintKey;
    if (!moved && !needsRepaint) return;

    lastPaintKey = paintKey;
    if (moved) rememberPosition();
    const wordRange = wordIndex >= 0 ? rangeOf(timeline.words[wordIndex]) : null;
    const sentenceRange = sentenceIndex >= 0 ? rangeOf(timeline.sentences[sentenceIndex]) : null;

    if (sentenceIndex !== lastSentence || needsRepaint) highlight.setSentence(sentenceRange);
    if (wordIndex !== lastWord || needsRepaint) highlight.setWord(wordRange);

    if (moved && wordIndex !== lastWord && settings.autoScroll && wordRange) {
      highlight.scrollTo(wordRange);
    }
    lastWord = wordIndex;
    lastSentence = sentenceIndex;
  }

  function rangeOf(span) {
    return span ? extract.rangeFor(doc, span.start, span.end) : null;
  }

  /**
   * Start reading, from where this page was left off unless asked for the top.
   *
   * `from: "start"` is the popup's Start over: it drops the position before
   * reading, so the read that follows cannot be resumed back into the middle.
   */
  async function start({ scope = "auto", from = "resume" } = {}) {
    // Read before the reset, which is what the position would not survive.
    const storedReady = from === "resume" ? positions.load() : Promise.resolve(null);
    if (from !== "resume") forgetPosition();
    reset();

    // Reading the settings is a round trip to the worker and extraction is a
    // walk of the document; neither needs the other, so they overlap.
    const settingsReady = refreshSettings();

    const wanted = scope === "auto" ? (window.getSelection()?.isCollapsed === false ? "selection" : "page") : scope;
    const walk = (how) =>
      extract.extract(wanted, how) || (wanted === "selection" ? extract.extract("page", how) : null);

    // Whether code blocks are read is the one setting extraction depends on,
    // so it runs on the snapshot in hand and re-walks only if the round trip
    // comes back with a different answer — which costs a few milliseconds on
    // the one read after the setting was changed, rather than putting the
    // round trip in front of every read.
    const readCodeBlocks = settings.readCodeBlocks;
    doc = walk({ readCodeBlocks });
    sentences = null;

    await settingsReady;
    if (settings.readCodeBlocks !== readCodeBlocks) doc = walk({ readCodeBlocks: settings.readCodeBlocks });
    if (!settings.hasCredential) {
      reportError(
        settings.tierDenied
          ? "xAI will not let the signed-in account through to the API. Add an API key in the extension options."
          : "No xAI credentials. Sign in with xAI or add an API key in the extension options.",
      );
      return snapshot();
    }
    if (!doc) {
      reportError("Could not find readable text on this page.");
      return snapshot();
    }

    // The browser paints its own selection above custom highlights, so the
    // spoken word would be invisible underneath it. The slices already hold
    // direct node references, so dropping the selection costs nothing.
    if (doc.scope === "selection") window.getSelection()?.removeAllRanges();

    chunks = align.chunkRanges(doc.text, settings.chunkChars, { firstChars: FIRST_CHUNK_CHARS });
    if (!chunks.length) {
      reportError("Could not find readable text on this page.");
      return snapshot();
    }

    // Where the read begins. A remembered position is a character index like
    // any other, so continuing from one is the same move as clicking a word
    // that has not been fetched: a chunk boundary is forced there, and the
    // first request comes back starting on the word about to be spoken rather
    // than opening with the part of the page that was already heard.
    const stored = doc.scope === "page" ? await storedReady : null;
    const at = stored && positions.offered(stored) ? positions.locate(doc.text, stored) : -1;
    let first = 0;
    if (at >= 0) {
      const wordStart = align.wordStartAt(doc.text, at);
      chunks = align.chunkRanges(doc.text, settings.chunkChars, {
        boundaries: [wordStart],
        firstChars: FIRST_CHUNK_CHARS,
      });
      first = align.chunkIndexFor(chunks, wordStart);
      resumePoint = stored;
    }

    sessionId += 1;
    abortRequests();
    cache = new Map();
    state.scope = doc.scope;
    state.chunkCount = chunks.length;
    state.error = "";
    state.notice = "";
    playChunk(first).catch(reportError);
    return snapshot();
  }

  function pause() {
    if (state.status !== "playing") return snapshot();
    player?.pause();
    stopLoop();
    rememberPosition({ force: true });
    state.status = "paused";
    emit();
    return snapshot();
  }

  async function resume() {
    if (state.status !== "paused") return snapshot();
    // Resuming is this tab asking for the read back, so the explanation for
    // why it stopped is no longer true.
    if (state.notice === HANDOFF_NOTICE) state.notice = "";
    state.status = "playing";
    emit();
    handoff.take();
    await player?.play();
    startLoop();
    return snapshot();
  }

  /**
   * Another tab has started speaking, so this one goes quiet.
   *
   * Pausing rather than stopping: the place is kept, the popup offers Resume,
   * and taking the read back is one click — which claims it straight back and
   * silences the other tab in turn.
   *
   * A read still loading its first chunk is left alone. It has made no sound
   * to overlap with yet, and it will claim the read for itself the moment it
   * does, which is the rule either way: the tab that spoke last keeps it.
   */
  function yieldRead() {
    if (state.status !== "playing") return;
    state.notice = HANDOFF_NOTICE;
    pause();
  }

  /**
   * Everything stopping does except forgetting where the read had got to.
   * Starting a read resets the one before it, and the position it left behind
   * is the thing the new read is about to continue from.
   */
  function reset() {
    sessionId += 1;
    stopLoop();
    player?.stop();
    highlight.clear();
    timeline = null;
    abortRequests();
    cache = new Map();
    // The pace is measured per read: a voice or a language changed between two
    // reads speaks at its own rate, and carrying the old one over would make
    // the first minutes of the new read confidently wrong.
    pacing.reset();
    lastWord = -1;
    lastSentence = -1;
    everPlayed = false;
    state.notice = "";
    if (state.status !== "idle") {
      state.status = "idle";
      state.chunkIndex = 0;
      emit();
    }
    return snapshot();
  }

  /**
   * Stop, the transport control: the panel goes back to Ready, so this page is
   * finished with and the position it was at goes with it. Pausing, closing
   * the tab and failing all keep theirs — those are reads that were
   * interrupted rather than ended.
   */
  function stop() {
    forgetPosition();
    return reset();
  }

  /**
   * Write down where the playhead is, so a later read can carry on from it.
   *
   * Only a whole-page read has anywhere to carry on from: a selection read is
   * about text the user picked out, which may not be selected — or even be
   * there — next time. Nothing is remembered before the first audio plays
   * either, so a read that failed on its credentials cannot overwrite a
   * position with the top of the page.
   */
  function rememberPosition({ force = false } = {}) {
    if (!everPlayed || !doc || doc.scope !== "page" || !chunks.length) return;
    const now = Date.now();
    if (!force && now - rememberedAt < REMEMBER_EVERY_MS) return;
    rememberedAt = now;

    const entry = positions.entryFor({
      text: doc.text,
      charIndex: playheadCharIndex(),
      title: document.title,
      at: now,
    });
    resumePoint = positions.offered(entry) ? entry : null;
    positions.store(entry);
  }

  function forgetPosition() {
    resumePoint = null;
    rememberedAt = 0;
    positions.clear();
  }

  const ACTIVE = new Set(["loading", "playing", "paused"]);

  /**
   * Move playback to the word at `charIndex` and keep reading from there.
   *
   * Three ways in, cheapest first. The word is in the chunk already playing:
   * a seek, no request at all. The word is in a chunk whose audio is already
   * in hand — the one just left, or the one prefetched ahead — so that audio
   * plays from the word's own timestamp. Otherwise nothing has been fetched
   * for the target yet, and a chunk boundary is forced at the clicked word
   * before requesting it: the chunk that comes back then *starts* at that word
   * rather than opening with text that would be synthesised only to be
   * skipped. That is both the fastest start and the fewest characters billed,
   * and it costs nothing, because re-cutting only moves boundaries nothing has
   * been spent on yet.
   */
  async function jumpToCharIndex(charIndex) {
    if (!doc || !chunks.length || charIndex < 0) return snapshot();
    if (!ACTIVE.has(state.status)) return snapshot();

    const wordStart = align.wordStartAt(doc.text, charIndex);
    // While a chunk is still loading, `timeline` still describes the previous
    // one, so a seek would land in the wrong audio. That falls through to the
    // paths below, which re-join the load already in flight.
    const current = state.status === "loading" ? null : chunks[state.chunkIndex];

    if (current && wordStart >= current.start && wordStart < current.end && timeline) {
      player?.seek(align.timeForCharIndex(timeline, wordStart));
      repaint();
      if (state.status === "paused") await resume();
      return snapshot();
    }

    // Whatever the old position was loading or prefetching is no longer what
    // comes next, so retire that generation before starting the new one.
    sessionId += 1;
    stopLoop();

    let target = align.chunkIndexFor(chunks, wordStart);
    let startTime = 0;
    const ready = cache.get(cacheKey(chunks[target]));
    if (ready) {
      startTime = align.timeForCharIndex(ready.timeline, wordStart);
    } else {
      chunks = align.chunkRanges(doc.text, settings.chunkChars, {
        boundaries: [wordStart],
        firstChars: FIRST_CHUNK_CHARS,
      });
      target = align.chunkIndexFor(chunks, wordStart);
      state.chunkCount = chunks.length;
    }

    abortRequests(neighbourKeys(target));
    state.error = "";
    await playChunk(target, startTime).catch(reportError);
    return snapshot();
  }

  /** Character index of the word being spoken, or the top of the chunk. */
  function playheadCharIndex() {
    if (timeline && player && state.status !== "loading") {
      const index = util.lastAtOrBefore(timeline.words, player.getTime());
      if (index >= 0) return timeline.words[index].start;
    }
    return chunks[state.chunkIndex]?.start ?? 0;
  }

  /**
   * Whether stepping back should re-read the sentence being spoken instead of
   * the one before it. A sentence that began in an earlier chunk has no start
   * time in this chunk's timeline, which reads as zero — correctly, since the
   * playhead is by definition well past it.
   */
  function wellIntoSentence(from) {
    if (!timeline || !player) return false;
    const start = align.sentenceStartFrom(sentences, from, 0);
    if (start < 0) return false;
    return player.getTime() - align.timeForCharIndex(timeline, start) > REPLAY_AFTER_SECONDS;
  }

  /**
   * Step a sentence back (`delta` < 0) or forward, and keep reading.
   *
   * The destination is a character index, so this is the same move as clicking
   * a word: a seek when the sentence is in the audio already in hand, and a
   * chunk that begins at the sentence when it is not. Stepping forward off the
   * end of the text does nothing; stepping back from the first sentence
   * restarts it.
   */
  async function skipSentence(delta) {
    if (!doc || !chunks.length) return snapshot();
    if (!ACTIVE.has(state.status)) return snapshot();

    sentences ??= align.sentences(doc.text);
    const from = playheadCharIndex();
    const offset = delta < 0 ? (wellIntoSentence(from) ? 0 : -1) : 1;

    let target = align.sentenceStartFrom(sentences, from, offset);
    if (target < 0 && offset < 0) target = align.sentenceStartFrom(sentences, from, 0);
    if (target < 0) return snapshot();

    return jumpToCharIndex(target);
  }

  /** Repaint the highlight at the playhead without waiting for a frame. */
  function repaint() {
    lastWord = -1;
    lastSentence = -1;
    update();
  }

  function onTextClick(event) {
    if (!settings.clickToJump) return;
    if (!doc || !ACTIVE.has(state.status)) return;
    const charIndex = extract.charIndexFromPoint(doc, event.clientX, event.clientY);
    // Outside the text being read — page furniture, or anywhere at all in a
    // selection read — and the click was never ours.
    if (charIndex < 0) return;
    jumpToCharIndex(charIndex).catch(reportError);
  }

  async function toggle(args) {
    if (state.status === "playing") return pause();
    if (state.status === "paused") return resume();
    return start(args);
  }

  async function setRate(rate) {
    settings.rate = util.clamp(Number(rate) || 1, 0.5, 3);
    player?.setRate(settings.rate);
    emit();
    return snapshot();
  }

  const handlers = {
    ping: () => ({ ok: true }),
    // Refreshed first so an opening popup never reports a key that has since
    // been saved, or a voice that has since changed.
    getState: async () => {
      const [, stored] = await Promise.all([refreshSettings(), positions.load()]);
      resumePoint = stored && positions.offered(stored) ? stored : null;
      return snapshot();
    },
    start,
    toggle,
    pause,
    resume,
    stop,
    skipSentence: (message) => skipSentence(message.delta),
    setRate: (message) => setRate(message.rate),
    settingsChanged: async () => {
      await refreshSettings();
      return snapshot();
    },
  };

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;
    Promise.resolve(handler(message))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  /**
   * What a reader writes into the settings area that is not a setting: where
   * this page has got to, and which tab holds the read. Both are written
   * while a page is being read, and re-reading the settings for either would
   * be a round trip to the worker for a value that has not changed.
   */
  const READER_KEYS = new Set([positions.STORE_KEY, handoff.CLAIM_KEY]);

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // A read starting in another tab arrives here, as that tab's claim.
    if (handoff.taken(changes)) yieldRead();
    if (Object.keys(changes).every((key) => READER_KEYS.has(key))) return;
    refreshSettings();
  });

  pointer.watch(onTextClick);

  // Closing the tab or following a link is an interrupted read, not a finished
  // one, so the position is kept rather than stopped away.
  window.addEventListener("pagehide", () => {
    rememberPosition({ force: true });
    reset();
    controls.detach();
    player?.destroy();
    player = null;
  });

  ns.reader = { refreshSettings, snapshot };
  refreshSettings();
})(globalThis.__readAloud);
