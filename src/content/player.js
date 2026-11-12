(function (ns) {
  "use strict";

  /**
   * Playback lives in the page because that is where the highlighting is, and
   * a worker has no audio output. Two engines: a media element, and a Web
   * Audio fallback for pages whose CSP refuses to load the blob URL.
   *
   * Neither is ever asked to play faster. A voice played faster goes up in
   * pitch, and the media element's own pitch-keeping stretch warbles from
   * about 1.5× up — so away from 1× both engines play audio that
   * `stretch.js` has already time-stretched, at 1×. Times in and out of an
   * engine are always seconds of the original audio, which is what the
   * timestamps, the highlight and `pace.js` count in.
   */

  const stretch = () => ns.stretch;

  function mediaEngine({ onPausedOutside, onResumedOutside } = {}) {
    const audio = new Audio();
    audio.preload = "auto";
    // Never used to change speed, but if anything ever does, keep the pitch.
    audio.preservesPitch = true;
    let objectUrl = "";

    /**
     * What this engine was last asked for.
     *
     * The audio element can be paused and started again without the extension
     * being involved at all: the browser's media controls reach it directly,
     * and so does anything in the system that takes audio over. Its events say
     * *that* it changed, never *who* changed it — so the last thing asked for
     * is kept here, and an event that disagrees with it is somebody else's.
     */
    let wanted = "paused";
    /** True while the source is being swapped for another rate's. */
    let swapping = false;
    /** The original-audio time to report while swapping. */
    let heldTime = 0;

    let bytes = null;
    let contentType = "";
    /** The rate asked for, and the rate the loaded source plays at. */
    let rate = 1;
    let shownRate = 1;
    /**
     * Bumped by every load, and by every rate change, so that work for a
     * chunk or a speed nobody wants any more drops out.
     */
    let loadId = 0;
    let rateId = 0;
    let loading = false;
    /** True when the audio could not be decoded and plays as it came. */
    let undecodable = false;
    let endedHandler = () => {};

    audio.addEventListener("pause", () => {
      // The pause at the end of a chunk is the element running out of audio,
      // which is already handled as the chunk ending.
      if (swapping || wanted !== "playing" || audio.ended) return;
      wanted = "paused";
      onPausedOutside?.();
    });

    audio.addEventListener("play", () => {
      if (swapping || wanted !== "paused") return;
      wanted = "playing";
      onResumedOutside?.();
    });

    audio.addEventListener("ended", () => {
      if (!swapping) endedHandler();
    });

    function setSource(data, type) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([data], { type }));
      audio.src = objectUrl;
      audio.playbackRate = 1;
      return new Promise((resolve, reject) => {
        const done = () => {
          cleanup();
          resolve();
        };
        const fail = () => {
          cleanup();
          reject(new Error("engine-unavailable"));
        };
        const cleanup = () => {
          audio.removeEventListener("loadedmetadata", done);
          audio.removeEventListener("error", fail);
        };
        audio.addEventListener("loadedmetadata", done, { once: true });
        audio.addEventListener("error", fail, { once: true });
        audio.load();
      });
    }

    /**
     * The source for `atRate`: the original bytes at 1×, a WAV of the
     * stretched audio otherwise. Null if it was cancelled meanwhile.
     */
    async function sourceFor(atRate, isCancelled) {
      if (stretch().isUnity(atRate)) return { data: bytes, type: contentType, rate: 1 };
      const rendered = await stretch().render(bytes, atRate, { isCancelled });
      if (!rendered || isCancelled()) return null;
      return { data: stretch().encodeWav(rendered.samples, rendered.sampleRate), type: "audio/wav", rate: atRate };
    }

    const originalTime = () => (swapping ? heldTime : audio.currentTime * shownRate);

    return {
      name: "media",
      get pitchPreserving() {
        return audio.preservesPitch !== false && (audio.playbackRate === 1 || undecodable);
      },
      get stretchedRate() {
        return shownRate;
      },
      async load(nextBytes, nextType, atRate = rate) {
        // Loading a new source stops whatever was playing, which is this
        // engine's own doing rather than anything outside it.
        wanted = "paused";
        const mine = ++loadId;
        rateId += 1;
        bytes = nextBytes;
        contentType = nextType;
        rate = atRate;
        undecodable = false;
        loading = true;
        let source = null;
        try {
          // A speed change while this renders is picked up here rather than
          // by a swap, so the chunk starts at the speed last asked for.
          for (;;) {
            const want = rate;
            try {
              source = await sourceFor(want, () => mine !== loadId || rate !== want);
            } catch {
              // Audio this browser can play but cannot decode: play it as it
              // came. `preservesPitch` still holds the voice where it was.
              undecodable = true;
              source = { data: bytes, type: contentType, rate: 1 };
            }
            // A newer load owns the element now, and it is what gets waited on.
            if (mine !== loadId) return;
            if (source && (undecodable || rate === want)) break;
          }
        } finally {
          if (mine === loadId) loading = false;
        }
        swapping = false;
        await setSource(source.data, source.type);
        shownRate = source.rate;
        if (undecodable) audio.playbackRate = rate;
      },
      play() {
        wanted = "playing";
        const playing = audio.src;
        // A speed change swaps the source under a play that is still
        // starting, which aborts it; the swap starts the new source itself.
        return audio.play().catch((error) => {
          if (error?.name === "AbortError" && audio.src !== playing) return;
          throw error;
        });
      },
      pause() {
        wanted = "paused";
        audio.pause();
      },
      stop() {
        wanted = "paused";
        audio.pause();
        try {
          audio.currentTime = 0;
        } catch {
          // Ignore seeks on an unloaded element.
        }
      },
      seek(time) {
        if (swapping) {
          heldTime = Math.max(0, time);
          return;
        }
        try {
          audio.currentTime = Math.max(0, time) / shownRate;
        } catch {
          // Nothing loaded to seek within.
        }
      },
      getTime: originalTime,
      getDuration: () => (Number.isFinite(audio.duration) ? audio.duration * shownRate : 0),
      /**
       * The new speed takes over once its audio is rendered — tens of
       * milliseconds — and from the same word: the swap keeps the place in
       * the original audio and carries on from there.
       */
      async setRate(next) {
        if (next === rate) return;
        rate = next;
        if (!bytes || loading) return;
        if (undecodable) {
          audio.playbackRate = next;
          return;
        }
        const mine = ++rateId;
        const load = loadId;
        const stale = () => mine !== rateId || load !== loadId;
        let source;
        try {
          source = await sourceFor(next, stale);
        } catch {
          return;
        }
        if (!source || stale()) return;
        heldTime = originalTime();
        const resume = wanted === "playing" && !audio.paused && !audio.ended;
        swapping = true;
        try {
          await setSource(source.data, source.type);
          if (stale()) return;
          shownRate = source.rate;
          audio.currentTime = Math.min(heldTime / shownRate, audio.duration || Infinity);
          if (resume && wanted === "playing") await audio.play();
        } catch {
          // Left paused where it was; the next press of play takes it on.
        } finally {
          if (!stale()) swapping = false;
        }
      },
      onEnded(handler) {
        endedHandler = handler;
      },
      destroy() {
        wanted = "paused";
        loadId += 1;
        rateId += 1;
        audio.pause();
        audio.removeAttribute("src");
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = "";
        bytes = null;
      },
    };
  }

  function webAudioEngine() {
    const context = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    let bytes = null;
    /** The buffer playing, and the rate its audio was stretched to. */
    let buffer = null;
    let shownRate = 1;
    let duration = 0;
    let rate = 1;
    let loadId = 0;
    let rateId = 0;
    let loading = false;
    let source = null;
    let startedAt = 0;
    /** Where playback is, or starts from, in seconds of the original audio. */
    let offset = 0;
    let playing = false;
    let endedHandler = () => {};

    const currentTime = () =>
      playing ? Math.min(duration, offset + (context.currentTime - startedAt) * shownRate) : offset;

    function teardown(silent) {
      if (!source) return;
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source = null;
      if (!silent) playing = false;
    }

    async function startPlayback() {
      if (!buffer || playing) return;
      if (context.state === "suspended") await context.resume();
      source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = 1;
      source.connect(context.destination);
      source.onended = () => {
        if (!playing) return;
        playing = false;
        offset = duration;
        endedHandler();
      };
      startedAt = context.currentTime;
      source.start(0, Math.min(offset / shownRate, buffer.duration));
      playing = true;
    }

    async function bufferFor(atRate, isCancelled) {
      const rendered = await stretch().render(bytes, atRate, { isCancelled });
      if (!rendered || isCancelled()) return null;
      const next = context.createBuffer(1, rendered.samples.length, rendered.sampleRate);
      next.copyToChannel(rendered.samples, 0);
      return { buffer: next, rate: rendered.rate };
    }

    return {
      name: "webaudio",
      get pitchPreserving() {
        return !source || source.playbackRate.value === 1;
      },
      get stretchedRate() {
        return shownRate;
      },
      async load(nextBytes, _contentType, atRate = rate) {
        teardown(true);
        playing = false;
        offset = 0;
        const mine = ++loadId;
        rateId += 1;
        bytes = nextBytes;
        rate = atRate;
        loading = true;
        try {
          const decoded = await stretch().decode(bytes);
          for (;;) {
            const want = rate;
            const next = await bufferFor(want, () => mine !== loadId || rate !== want);
            if (mine !== loadId) return;
            if (!next) continue;
            duration = decoded.duration;
            buffer = next.buffer;
            shownRate = next.rate;
            return;
          }
        } finally {
          if (mine === loadId) loading = false;
        }
      },
      play: () => startPlayback(),
      // A buffer source cannot move, so seeking means replacing it.
      seek(time) {
        const target = Math.max(0, Math.min(time, duration));
        const wasPlaying = playing;
        teardown(true);
        playing = false;
        offset = target;
        if (wasPlaying) startPlayback().catch(() => {});
      },
      pause() {
        if (!playing) return;
        offset = currentTime();
        playing = false;
        teardown(true);
      },
      stop() {
        playing = false;
        teardown(true);
        offset = 0;
      },
      getTime: currentTime,
      getDuration: () => duration,
      async setRate(next) {
        if (next === rate) return;
        rate = next;
        if (!bytes || loading) return;
        const mine = ++rateId;
        const load = loadId;
        const stale = () => mine !== rateId || load !== loadId;
        const rendered = await bufferFor(next, stale).catch(() => null);
        if (!rendered || stale()) return;
        const wasPlaying = playing;
        offset = currentTime();
        teardown(true);
        playing = false;
        buffer = rendered.buffer;
        shownRate = rendered.rate;
        if (wasPlaying) startPlayback().catch(() => {});
      },
      onEnded(handler) {
        endedHandler = handler;
      },
      destroy() {
        loadId += 1;
        rateId += 1;
        teardown(true);
        buffer = null;
        bytes = null;
        context.close().catch(() => {});
      },
    };
  }

  /**
   * `onPausedOutside` and `onResumedOutside` report playback that changed
   * without being asked for here — see `wanted` above. Only the media element
   * can be reached that way; a Web Audio buffer has no controls on it for
   * anything else to find.
   */
  function createPlayer({ onEnded, onBlocked, onPausedOutside, onResumedOutside }) {
    let engine = null;
    let rate = 1;
    let ended = onEnded;

    /**
     * Loads take a moment now — the audio is decoded and stretched first — so
     * a second load (a jump, say) can arrive while the first is still going.
     * The engine is settled before anything is awaited, so both land on the
     * same one, and the newer load is the one it plays.
     */
    function adopt(next) {
      engine = next;
      engine.onEnded(() => ended?.());
      return engine;
    }

    async function engineFor(bytes, contentType) {
      if (engine) {
        const current = engine;
        try {
          await current.load(bytes, contentType, rate);
          return;
        } catch (error) {
          if (current.name !== "media") throw error;
          // Another load has already dealt with this engine failing.
          if (engine !== current) return;
          current.destroy();
          engine = null;
        }
      }
      const media = adopt(mediaEngine({ onPausedOutside, onResumedOutside }));
      try {
        await media.load(bytes, contentType, rate);
      } catch {
        if (engine !== media) return;
        media.destroy();
        const fallback = adopt(webAudioEngine());
        await fallback.load(bytes, contentType, rate);
      }
    }

    /**
     * Browsers block audio that was not started by a gesture on the page
     * itself. When that happens, wait for the next click or key press and
     * resume from there instead of failing the whole session.
     */
    async function playWithGestureFallback() {
      try {
        await engine.play();
        return true;
      } catch (error) {
        if (error?.name !== "NotAllowedError") throw error;
        onBlocked?.();
        await new Promise((resolve) => {
          const retry = () => {
            document.removeEventListener("pointerdown", retry, true);
            document.removeEventListener("keydown", retry, true);
            resolve();
          };
          document.addEventListener("pointerdown", retry, true);
          document.addEventListener("keydown", retry, true);
        });
        await engine.play();
        return true;
      }
    }

    return {
      get engineName() {
        return engine?.name ?? "none";
      },
      /**
       * How the audio is being sped up, for checking that it never touches
       * the pitch: the engine, the rate asked for, the rate the playing audio
       * was stretched to, and whether the voice is where it was recorded.
       */
      get playback() {
        return {
          engine: engine?.name ?? "none",
          rate,
          stretchedRate: engine?.stretchedRate ?? 1,
          pitchPreserving: engine ? engine.pitchPreserving : true,
        };
      },
      async load(bytes, contentType) {
        await engineFor(bytes, contentType);
      },
      play: () => playWithGestureFallback(),
      pause: () => engine?.pause(),
      stop: () => engine?.stop(),
      seek: (time) => engine?.seek(time),
      getTime: () => engine?.getTime() ?? 0,
      getDuration: () => engine?.getDuration() ?? 0,
      setRate(next) {
        rate = next;
        engine?.setRate(next)?.catch?.(() => {});
      },
      destroy() {
        ended = null;
        engine?.destroy();
        engine = null;
      },
    };
  }

  ns.player = { createPlayer };
})(globalThis.__readAloud);
