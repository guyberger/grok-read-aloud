(function (ns) {
  "use strict";

  /**
   * Playback lives in the page because that is where the highlighting is, and
   * a worker has no audio output. Two engines: a media element (keeps pitch
   * when the rate changes) and a Web Audio fallback for pages whose CSP
   * refuses to load the blob URL.
   */

  function mediaEngine() {
    const audio = new Audio();
    audio.preload = "auto";
    let objectUrl = "";

    return {
      name: "media",
      async load(bytes, contentType) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
        audio.src = objectUrl;
        await new Promise((resolve, reject) => {
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
      },
      play: () => audio.play(),
      pause: () => audio.pause(),
      stop() {
        audio.pause();
        try {
          audio.currentTime = 0;
        } catch {
          // Ignore seeks on an unloaded element.
        }
      },
      getTime: () => audio.currentTime,
      getDuration: () => (Number.isFinite(audio.duration) ? audio.duration : 0),
      setRate(rate) {
        audio.playbackRate = rate;
      },
      onEnded(handler) {
        audio.addEventListener("ended", handler);
      },
      destroy() {
        audio.pause();
        audio.removeAttribute("src");
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = "";
      },
    };
  }

  function webAudioEngine() {
    const context = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    let buffer = null;
    let source = null;
    let startedAt = 0;
    let offset = 0;
    let playing = false;
    let rate = 1;
    let endedHandler = () => {};

    const currentTime = () =>
      playing ? offset + (context.currentTime - startedAt) * rate : offset;

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

    return {
      name: "webaudio",
      async load(bytes) {
        teardown(true);
        playing = false;
        offset = 0;
        buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
      async play() {
        if (!buffer || playing) return;
        if (context.state === "suspended") await context.resume();
        source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(context.destination);
        source.onended = () => {
          if (!playing) return;
          playing = false;
          offset = buffer.duration;
          endedHandler();
        };
        startedAt = context.currentTime;
        source.start(0, Math.min(offset, buffer.duration));
        playing = true;
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
      getDuration: () => buffer?.duration ?? 0,
      setRate(next) {
        if (playing) {
          offset = currentTime();
          startedAt = context.currentTime;
          if (source) source.playbackRate.value = next;
        }
        rate = next;
      },
      onEnded(handler) {
        endedHandler = handler;
      },
      destroy() {
        teardown(true);
        buffer = null;
        context.close().catch(() => {});
      },
    };
  }

  function createPlayer({ onEnded, onBlocked }) {
    let engine = null;
    let rate = 1;
    let ended = onEnded;

    async function engineFor(bytes, contentType) {
      if (engine) {
        try {
          await engine.load(bytes, contentType);
          return engine;
        } catch (error) {
          if (engine.name !== "media") throw error;
          engine.destroy();
          engine = null;
        }
      }
      try {
        const media = mediaEngine();
        await media.load(bytes, contentType);
        engine = media;
      } catch {
        const fallback = webAudioEngine();
        await fallback.load(bytes, contentType);
        engine = fallback;
      }
      engine.setRate(rate);
      engine.onEnded(() => ended?.());
      return engine;
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
      async load(bytes, contentType) {
        await engineFor(bytes, contentType);
      },
      play: () => playWithGestureFallback(),
      pause: () => engine?.pause(),
      stop: () => engine?.stop(),
      getTime: () => engine?.getTime() ?? 0,
      getDuration: () => engine?.getDuration() ?? 0,
      setRate(next) {
        rate = next;
        engine?.setRate(next);
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
