(function (ns) {
  "use strict";

  if (ns.reader) {
    ns.reader.refreshSettings();
    return;
  }

  const { ext, util, extract, align, highlight, pointer, player: playerFactory } = ns;

  const PREFETCH_AHEAD = 1;

  /**
   * Cap on the first request of a read, and of a jump. The API charges by the
   * character and synthesises at roughly a fixed rate, so the wait before the
   * first sound is set by this number rather than by anything the extension
   * does locally. Around one or two sentences: short enough to start quickly,
   * long enough to land on a sentence boundary rather than mid-clause.
   */
  const FIRST_CHUNK_CHARS = 240;

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

  const BLOCKED_NOTICE = "Audio is blocked until you interact with this page — click anywhere to start.";

  let settings = {
    voiceId: "eve",
    language: "en",
    rate: 1,
    chunkChars: 1200,
    autoScroll: true,
    highlightColor: "#ffd34d",
    sentenceTint: true,
    clickToJump: true,
    hasApiKey: false,
  };

  let doc = null;
  let chunks = [];
  let timeline = null;
  // Keyed by character range rather than chunk index, because clicking into
  // text nothing has been fetched for re-cuts the chunks and the audio already
  // in hand must survive that.
  let cache = new Map();
  let inflight = new Map();
  let nextRequestId = 1;
  let player = null;
  let frame = 0;
  let sessionId = 0;
  let lastWord = -1;
  let lastSentence = -1;
  let lastPaintKey = "";

  function emit() {
    ext.runtime.sendMessage({ type: "stateChanged", state: snapshot() }).catch(() => {});
  }

  function snapshot() {
    const chunkProgress = progressWithinChunk();
    return {
      ...state,
      progress:
        state.chunkCount > 0
          ? util.clamp((state.chunkIndex + chunkProgress) / state.chunkCount, 0, 1)
          : 0,
      rate: settings.rate,
      voiceId: settings.voiceId,
      hasApiKey: settings.hasApiKey,
      title: document.title,
    };
  }

  function progressWithinChunk() {
    if (!player || !timeline?.duration) return 0;
    return util.clamp(player.getTime() / timeline.duration, 0, 1);
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
    });
    player.setRate(settings.rate);
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
    await audio.play();
    if (session !== sessionId) return;
    if (state.notice === BLOCKED_NOTICE) {
      state.notice = "";
      emit();
    }
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
    highlight.setWord(null);
    highlight.setSentence(null);
    state.status = "idle";
    state.chunkIndex = chunks.length ? chunks.length - 1 : 0;
    emit();
  }

  function reportError(error) {
    stopLoop();
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

  async function start({ scope = "auto" } = {}) {
    stop();

    // Reading the settings is a round trip to the worker and extraction is a
    // walk of the document; neither needs the other, so they overlap.
    const settingsReady = refreshSettings();

    const wanted = scope === "auto" ? (window.getSelection()?.isCollapsed === false ? "selection" : "page") : scope;
    doc = extract.extract(wanted) || (wanted === "selection" ? extract.extract("page") : null);

    await settingsReady;
    if (!settings.hasApiKey) {
      reportError("No API key set. Open the extension options and paste your xAI key.");
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

    sessionId += 1;
    abortRequests();
    cache = new Map();
    state.scope = doc.scope;
    state.chunkCount = chunks.length;
    state.error = "";
    state.notice = "";
    playChunk(0).catch(reportError);
    return snapshot();
  }

  function pause() {
    if (state.status !== "playing") return snapshot();
    player?.pause();
    stopLoop();
    state.status = "paused";
    emit();
    return snapshot();
  }

  async function resume() {
    if (state.status !== "paused") return snapshot();
    state.status = "playing";
    emit();
    await player?.play();
    startLoop();
    return snapshot();
  }

  function stop() {
    sessionId += 1;
    stopLoop();
    player?.stop();
    highlight.clear();
    timeline = null;
    abortRequests();
    cache = new Map();
    lastWord = -1;
    lastSentence = -1;
    state.notice = "";
    if (state.status !== "idle") {
      state.status = "idle";
      state.chunkIndex = 0;
      emit();
    }
    return snapshot();
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
      await refreshSettings();
      return snapshot();
    },
    start,
    toggle,
    pause,
    resume,
    stop,
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

  ext.storage.onChanged.addListener((changes, area) => {
    if (area === "local") refreshSettings();
  });

  pointer.watch(onTextClick);

  window.addEventListener("pagehide", () => {
    stop();
    player?.destroy();
    player = null;
  });

  ns.reader = { refreshSettings, snapshot };
  refreshSettings();
})(globalThis.__readAloud);
