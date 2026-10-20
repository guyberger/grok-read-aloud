(function (ns) {
  "use strict";

  if (ns.reader) {
    ns.reader.refreshSettings();
    return;
  }

  const { ext, util, extract, align, highlight, player: playerFactory } = ns;

  const PREFETCH_AHEAD = 1;

  const state = {
    status: "idle", // idle | loading | playing | paused | error
    scope: "page",
    chunkIndex: 0,
    chunkCount: 0,
    error: "",
    engine: "none",
    aligned: true,
  };

  let settings = {
    voiceId: "eve",
    language: "en",
    rate: 1,
    chunkChars: 1200,
    autoScroll: true,
    highlightColor: "#ffd34d",
    sentenceTint: true,
    hasApiKey: false,
  };

  let doc = null;
  let chunks = [];
  let timeline = null;
  let cache = new Map();
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
      onBlocked: () =>
        highlight.notify("Audio is blocked until you interact with this page — click anywhere to start."),
    });
    player.setRate(settings.rate);
    return player;
  }

  async function requestChunk(index) {
    if (index < 0 || index >= chunks.length || cache.has(index)) return;
    const { start, end } = chunks[index];
    const text = doc.text.slice(start, end);
    const response = await ext.runtime.sendMessage({
      type: "synthesize",
      text,
      voiceId: settings.voiceId,
      language: settings.language,
    });
    if (!response?.ok) throw new Error(response?.error || "Synthesis failed.");

    cache.set(index, {
      bytes: util.base64ToBytes(response.audio),
      contentType: response.contentType,
      timeline: align.buildChunkTimeline({
        text,
        graphChars: response.graphChars,
        graphTimes: response.graphTimes,
        globalStart: start,
        duration: response.duration,
      }),
    });
  }

  function prefetch(index) {
    for (let i = index + 1; i <= index + PREFETCH_AHEAD; i += 1) {
      requestChunk(i).catch(() => {});
    }
    for (const key of cache.keys()) {
      if (key < index - 1) cache.delete(key);
    }
  }

  async function playChunk(index) {
    const session = sessionId;
    state.status = "loading";
    state.chunkIndex = index;
    emit();

    await requestChunk(index);
    if (session !== sessionId) return;

    const entry = cache.get(index);
    timeline = entry.timeline;
    state.aligned = entry.timeline.aligned;
    lastWord = -1;
    lastSentence = -1;

    const audio = ensurePlayer();
    await audio.load(entry.bytes, entry.contentType);
    if (session !== sessionId) return;

    audio.setRate(settings.rate);
    state.status = "playing";
    state.engine = audio.engineName;
    emit();

    prefetch(index);
    await audio.play();
    if (session !== sessionId) return;
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
    await refreshSettings();
    if (!settings.hasApiKey) {
      reportError("No API key set. Open the extension options and paste your xAI key.");
      return snapshot();
    }

    const wanted = scope === "auto" ? (window.getSelection()?.isCollapsed === false ? "selection" : "page") : scope;
    doc = extract.extract(wanted) || (wanted === "selection" ? extract.extract("page") : null);
    if (!doc) {
      reportError("Could not find readable text on this page.");
      return snapshot();
    }

    chunks = align.chunkRanges(doc.text, settings.chunkChars);
    if (!chunks.length) {
      reportError("Could not find readable text on this page.");
      return snapshot();
    }

    sessionId += 1;
    cache = new Map();
    state.scope = doc.scope;
    state.chunkCount = chunks.length;
    state.error = "";
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
    cache = new Map();
    lastWord = -1;
    lastSentence = -1;
    if (state.status !== "idle") {
      state.status = "idle";
      state.chunkIndex = 0;
      emit();
    }
    return snapshot();
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
    getState: () => snapshot(),
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

  window.addEventListener("pagehide", () => {
    stop();
    player?.destroy();
    player = null;
  });

  ns.reader = { refreshSettings, snapshot };
  refreshSettings();
})(globalThis.__readAloud);
