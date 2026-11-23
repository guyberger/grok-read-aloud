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
     * Seconds of audio at the start of the file that are context for the
     * synthesiser and are not part of this chunk. Playback starts after them,
     * and every time this engine reports is measured from there.
     */
    let leadSeconds = 0;
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

    /**
     * The same transport on every chunk. Setting `src` can drop these back to
     * the defaults, and a later chunk that kept a different rate, pitch
     * handling or volume is the voice changing at the join. `playbackRate`
     * stays at 1 even when the read is faster: speed is a stretch of the
     * bytes, and a rate other than 1 is what moves the pitch.
     */
    function holdVoice() {
      audio.playbackRate = 1;
      audio.preservesPitch = true;
      audio.mozPreservesPitch = true;
      audio.webkitPreservesPitch = true;
      audio.volume = 1;
    }

    function setSource(data, type) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(new Blob([data], { type }));
      audio.src = objectUrl;
      holdVoice();
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

    /**
     * Park at the start of the spoken audio. A position already past the
     * lead-in — a resume, a seek — is left where it is; one still inside the
     * context, which is where a freshly loaded element sits, is moved past it.
     */
    function parkAtLead() {
      if (!(leadSeconds > 0) || swapping) return;
      const target = leadSeconds / (shownRate || 1);
      try {
        if (audio.currentTime < target - 0.02) audio.currentTime = target;
      } catch {
        // Not seekable yet. The next play tries again.
      }
    }

    return {
      name: "media",
      get pitchPreserving() {
        return audio.preservesPitch !== false && (audio.playbackRate === 1 || undecodable);
      },
      get stretchedRate() {
        return shownRate;
      },
      get volume() {
        return audio.volume;
      },
      get lead() {
        return leadSeconds;
      },
      async load(nextBytes, nextType, atRate = rate, nextLead = 0) {
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
        if (mine !== loadId) return;
        shownRate = source.rate;
        holdVoice();
        if (undecodable) audio.playbackRate = rate;
        const full = Number.isFinite(audio.duration) ? audio.duration * shownRate : nextLead;
        leadSeconds = Math.min(Math.max(0, nextLead), full || nextLead);
        parkAtLead();
      },
      play() {
        wanted = "playing";
        parkAtLead();
        const playing = audio.src;
        // A speed change swaps the source under a play that is still
        // starting, which aborts it; the swap starts the new source itself.
        return audio.play().catch((error) => {
          // A pause or a new chunk aborts the play() that was still starting.
          // That is the pause landing, or the swap starting its own source —
          // not a failure of this one. `src` differs once the swap has
          // replaced it; `wanted` differs once pause or stop asked first.
          if (error?.name === "AbortError" && (audio.src !== playing || wanted !== "playing")) return;
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
          // The start of the chunk, which is past the unspoken context.
          audio.currentTime = leadSeconds / (shownRate || 1);
        } catch {
          // Ignore seeks on an unloaded element.
        }
      },
      seek(time) {
        const fileTime = Math.max(0, time) + leadSeconds;
        if (swapping) {
          heldTime = fileTime;
          return;
        }
        try {
          audio.currentTime = fileTime / shownRate;
        } catch {
          // Nothing loaded to seek within.
        }
      },
      getTime: () => Math.max(0, originalTime() - leadSeconds),
      getDuration: () => {
        const full = Number.isFinite(audio.duration) ? audio.duration * shownRate : 0;
        return Math.max(0, full - leadSeconds);
      },
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
          audio.preservesPitch = true;
          audio.volume = 1;
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
    const gain = context.createGain();
    gain.gain.value = 1;
    gain.connect(context.destination);
    let bytes = null;
    /** The buffer playing, and the rate its audio was stretched to. */
    let buffer = null;
    let shownRate = 1;
    let duration = 0;
    let rate = 1;
    /** Seconds at the start of the buffer that are context, not this chunk. */
    let leadSeconds = 0;
    let loadId = 0;
    let rateId = 0;
    let loading = false;
    let source = null;
    let startedAt = 0;
    /** Where playback is, or starts from, in seconds of the original audio. */
    let offset = 0;
    let playing = false;
    /**
     * What this engine was last asked for. A start that is still resuming the
     * audio context has not set `playing` yet, and a pause in that window has
     * to be remembered or the resume finishes by starting the audio anyway.
     */
    let wanted = "paused";
    /** Bumped by pause, stop, load and a newer start, so the one they overtook drops out. */
    let playId = 0;
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
      const mine = ++playId;
      if (!buffer || wanted !== "playing" || playing) return;
      if (context.state === "suspended") await context.resume();
      // Pause, stop, a new chunk or a newer start may have landed while the
      // context was resuming. Starting afterwards would undo that.
      if (mine !== playId || !buffer || wanted !== "playing" || playing) return;
      source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = 1;
      gain.gain.value = 1;
      source.connect(gain);
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
      get volume() {
        return gain.gain.value;
      },
      get lead() {
        return leadSeconds;
      },
      async load(nextBytes, _contentType, atRate = rate, nextLead = 0) {
        playId += 1;
        wanted = "paused";
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
            gain.gain.value = 1;
            leadSeconds = Math.min(Math.max(0, nextLead), duration);
            offset = leadSeconds;
            return;
          }
        } finally {
          if (mine === loadId) loading = false;
        }
      },
      play() {
        wanted = "playing";
        return startPlayback();
      },
      // A buffer source cannot move, so seeking means replacing it.
      seek(time) {
        const target = Math.max(0, Math.min(time + leadSeconds, duration));
        const resume = wanted === "playing";
        playId += 1;
        teardown(true);
        playing = false;
        offset = target;
        if (resume) startPlayback().catch(() => {});
      },
      pause() {
        wanted = "paused";
        playId += 1;
        if (!playing) return;
        offset = currentTime();
        playing = false;
        teardown(true);
      },
      stop() {
        wanted = "paused";
        playId += 1;
        playing = false;
        teardown(true);
        offset = leadSeconds;
      },
      getTime: () => Math.max(0, currentTime() - leadSeconds),
      getDuration: () => Math.max(0, duration - leadSeconds),
      async setRate(next) {
        if (next === rate) return;
        rate = next;
        if (!bytes || loading) return;
        const mine = ++rateId;
        const load = loadId;
        const stale = () => mine !== rateId || load !== loadId;
        const rendered = await bufferFor(next, stale).catch(() => null);
        if (!rendered || stale()) return;
        offset = currentTime();
        playId += 1;
        teardown(true);
        playing = false;
        buffer = rendered.buffer;
        shownRate = rendered.rate;
        // A pause during the render has the say: finishing the swap must not
        // start audio the listener has since asked to stop.
        if (wanted === "playing") await startPlayback();
      },
      onEnded(handler) {
        endedHandler = handler;
      },
      destroy() {
        loadId += 1;
        rateId += 1;
        playId += 1;
        wanted = "paused";
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
     * Which `play()` is the one still wanted. Pause, stop, a new chunk and a
     * newer play all move it on, and a start that has fallen behind does not
     * get to begin — including one that was waiting for a click.
     */
    let playGeneration = 0;
    /** Resolves the gesture wait with "no longer wanted", if one is armed. */
    let cancelGesture = null;

    function endGestureWait() {
      const cancel = cancelGesture;
      cancelGesture = null;
      cancel?.();
    }

    function invalidatePlay() {
      playGeneration += 1;
      endGestureWait();
    }

    /**
     * The next click or key press on the page. The click listener is the
     * bubble phase, registered after the one that jumps to a sentence, so
     * that jump can retire this wait before the click starts the audio the
     * listener is leaving.
     */
    function waitForGesture() {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (allowed) => {
          if (settled) return;
          settled = true;
          document.removeEventListener("click", onClick);
          document.removeEventListener("keydown", onKeyDown, true);
          if (cancelGesture === cancel) cancelGesture = null;
          resolve(allowed);
        };
        const onClick = () => finish(true);
        const onKeyDown = () => finish(true);
        const cancel = () => finish(false);
        cancelGesture = cancel;
        document.addEventListener("click", onClick);
        document.addEventListener("keydown", onKeyDown, true);
      });
    }

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

    async function engineFor(bytes, contentType, lead) {
      if (engine) {
        const current = engine;
        try {
          await current.load(bytes, contentType, rate, lead);
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
        await media.load(bytes, contentType, rate, lead);
      } catch {
        if (engine !== media) return;
        media.destroy();
        const fallback = adopt(webAudioEngine());
        await fallback.load(bytes, contentType, rate, lead);
      }
    }

    /**
     * Browsers block audio that was not started by a gesture on the page
     * itself. When that happens, wait for the next click or key press and
     * resume from there instead of failing the whole session.
     *
     * The wait is armed only while this play is still the one wanted. Stop,
     * pause, a jump and a newer play all retire it, so the click that arrives
     * afterwards is just a click — it does not start a read that has since
     * been called off. Resolves false when this play was retired, true when
     * audio actually started.
     */
    async function playWithGestureFallback() {
      if (!engine) return false;
      const mine = ++playGeneration;
      endGestureWait();
      const stale = () => mine !== playGeneration || !engine;

      try {
        await engine.play();
      } catch (error) {
        if (stale()) return false;
        if (error?.name !== "NotAllowedError") throw error;
        onBlocked?.();
        const allowed = await waitForGesture();
        if (!allowed || stale()) return false;
        await engine.play();
      }
      return !stale();
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
          volume: engine?.volume ?? 1,
          lead: engine?.lead ?? 0,
        };
      },
      async load(bytes, contentType, options = {}) {
        // A chunk that is about to be replaced must not have its pending
        // start complete against the new bytes.
        invalidatePlay();
        const lead = Number(options?.lead) || 0;
        await engineFor(bytes, contentType, lead);
      },
      play: () => playWithGestureFallback(),
      pause() {
        invalidatePlay();
        engine?.pause();
      },
      stop() {
        invalidatePlay();
        engine?.stop();
      },
      /**
       * Drop a start that has not produced sound yet. Audio already playing
       * is left to run: a jump keeps the chunk in progress until the next one
       * is ready. A play still waiting for a click must not survive, or the
       * click that asked for the new place would start the old one.
       */
      cancelStart() {
        invalidatePlay();
      },
      seek: (time) => engine?.seek(time),
      getTime: () => engine?.getTime() ?? 0,
      getDuration: () => engine?.getDuration() ?? 0,
      setRate(next) {
        rate = next;
        engine?.setRate(next)?.catch?.(() => {});
      },
      destroy() {
        invalidatePlay();
        ended = null;
        engine?.destroy();
        engine = null;
      },
    };
  }

  ns.player = { createPlayer };
})(globalThis.__readAloud);
