(function (ns) {
  "use strict";

  if (ns.transport) return;

  /**
   * The playback transport.
   *
   * Status is one of idle, loading, playing, paused, error, and nothing else
   * writes it. Every command is defined for every status, so a pause that
   * lands while a chunk is still being fetched, a voice change under that
   * request, and a jump whose request fails all have one answer instead of
   * whichever branch happened to be written.
   *
   * `generation` is the read currently wanted. Stop, a new start and a jump
   * move it on, and a chunk or a failure from an older generation is ignored.
   *
   * `held` means the listener has asked for silence. A chunk that arrives
   * while it is set is loaded and not started. It survives the generation
   * bump that commits a start, so a pause during the moment before the first
   * request is still a pause when that request returns.
   *
   * `audible` means the engine holds the chunk this generation asked for.
   * Resume plays it when it does, and otherwise goes back to waiting.
   *
   * A voice or speed change does not touch any of this. The request already
   * in flight keeps the voice it was asked in; the next one reads the setting.
   */

  const STATUSES = ["idle", "loading", "playing", "paused", "error"];

  function outcome(state, patch = {}) {
    return {
      status: patch.status ?? state.status,
      generation: patch.generation ?? state.generation,
      held: patch.held ?? state.held,
      audible: patch.audible ?? state.audible,
      engine: patch.engine ?? "none",
      syncHighlight: patch.syncHighlight ?? false,
      accepted: patch.accepted ?? false,
    };
  }

  function reject(state) {
    return outcome(state);
  }

  function unexpected(status) {
    throw new Error(`Unhandled playback status ${status}`);
  }

  /** Drop whatever was in flight and go quiet. Stop and the start of a read. */
  function onReset(state) {
    switch (state.status) {
      case "idle":
      case "loading":
      case "playing":
      case "paused":
      case "error":
        return outcome(state, {
          status: "idle",
          generation: state.generation + 1,
          held: false,
          audible: false,
          engine: "stop",
          // Already idle: the generation still moves, so a start that is
          // waiting on the network can tell it has been replaced, but there
          // is no transition to announce.
          accepted: state.status !== "idle",
        });
      default:
        return unexpected(state.status);
    }
  }

  /**
   * Separate the read that is about to speak from the one that was still
   * preparing (a document fetch, a settings round trip). Held is kept: a
   * pause during that preparation is about the audio, not about which
   * generation number it carries.
   */
  function onCommit(state) {
    switch (state.status) {
      case "idle":
      case "loading":
      case "playing":
      case "paused":
      case "error":
        return outcome(state, { generation: state.generation + 1, accepted: true });
      default:
        return unexpected(state.status);
    }
  }

  /** A chunk is about to be fetched. A pause already asked for stays a pause. */
  function onLoad(state) {
    switch (state.status) {
      case "idle":
      case "loading":
      case "playing":
      case "paused":
      case "error":
        return outcome(state, {
          status: state.held ? "paused" : "loading",
          held: state.held,
          audible: false,
          accepted: true,
        });
      default:
        return unexpected(state.status);
    }
  }

  function onPause(state) {
    switch (state.status) {
      case "idle":
        return reject(state);
      case "loading":
      case "playing":
        return outcome(state, {
          status: "paused",
          held: true,
          engine: "pause",
          // The clock and the highlight are read together, after the engine
          // has actually stopped, so the word on screen is the one the audio
          // stopped on.
          syncHighlight: true,
          accepted: true,
        });
      case "paused":
        return outcome(state, { held: true });
      case "error":
        // The read has already failed. Pause still has to silence whatever
        // audio the failure did not, or the highlight and the sound disagree
        // and nothing on the panel will stop them.
        return outcome(state, { engine: "pause", syncHighlight: true, accepted: true });
      default:
        return unexpected(state.status);
    }
  }

  function onResume(state) {
    switch (state.status) {
      case "idle":
      case "loading":
      case "playing":
      case "error":
        return reject(state);
      case "paused":
        if (state.audible) {
          return outcome(state, { status: "playing", held: false, engine: "play", accepted: true });
        }
        return outcome(state, { status: "loading", held: false, audible: false, accepted: true });
      default:
        return unexpected(state.status);
    }
  }

  /** Fetch a different place. In-chunk seeks never come through here. */
  function onJump(state) {
    switch (state.status) {
      case "idle":
      case "error":
        return reject(state);
      case "loading":
      case "playing":
      case "paused":
        return outcome(state, {
          status: "loading",
          generation: state.generation + 1,
          held: false,
          audible: false,
          accepted: true,
        });
      default:
        return unexpected(state.status);
    }
  }

  function onChunkReady(state, generation) {
    if (generation !== state.generation) return reject(state);
    switch (state.status) {
      case "loading":
        if (state.held) {
          return outcome(state, { status: "paused", held: true, audible: true, accepted: true });
        }
        return outcome(state, { status: "playing", held: false, audible: true, engine: "play", accepted: true });
      case "paused":
        return outcome(state, { held: true, audible: true, accepted: true });
      case "idle":
      case "playing":
      case "error":
        // Stopped, already speaking, or failed: this arrival must not start
        // audio. Leaving it unaccepted is what stops a load from returning
        // while the status is still loading.
        return reject(state);
      default:
        return unexpected(state.status);
    }
  }

  function onFail(state, generation) {
    if (generation !== state.generation) return reject(state);
    switch (state.status) {
      case "idle":
      case "loading":
      case "playing":
      case "paused":
      case "error":
        return outcome(state, {
          status: "error",
          held: false,
          audible: false,
          engine: "pause",
          syncHighlight: true,
          accepted: true,
        });
      default:
        return unexpected(state.status);
    }
  }

  function onFinish(state) {
    switch (state.status) {
      case "playing":
        return outcome(state, { status: "idle", held: false, audible: false, accepted: true });
      case "idle":
      case "loading":
      case "paused":
      case "error":
        return reject(state);
      default:
        return unexpected(state.status);
    }
  }

  /** Another tab started speaking. A read that has not made sound yet is left to claim it when it does. */
  function onYield(state) {
    switch (state.status) {
      case "playing":
        return onPause(state);
      case "idle":
      case "loading":
      case "paused":
      case "error":
        return reject(state);
      default:
        return unexpected(state.status);
    }
  }

  /** Voice and speed are settings. They never retarget the chunk in flight. */
  function onNoted(state) {
    switch (state.status) {
      case "idle":
      case "loading":
      case "playing":
      case "paused":
      case "error":
        return outcome(state, { accepted: true });
      default:
        return unexpected(state.status);
    }
  }

  function reduce(state, command) {
    const type = command?.type;
    switch (type) {
      case "reset":
      case "stop":
        return onReset(state);
      case "commit":
        return onCommit(state);
      case "load":
        return onLoad(state);
      case "pause":
        return onPause(state);
      case "resume":
        return onResume(state);
      case "jump":
        return onJump(state);
      case "chunkReady":
        return onChunkReady(state, command.generation);
      case "fail":
        return onFail(state, command.generation);
      case "finish":
        return onFinish(state);
      case "yield":
        return onYield(state);
      case "voice":
      case "rate":
        return onNoted(state);
      default: {
        const unexpectedType = type;
        throw new Error(`Unknown transport command ${unexpectedType}`);
      }
    }
  }

  function createTransport() {
    let status = "idle";
    let generation = 0;
    let held = false;
    let audible = false;

    function dispatch(command) {
      const next = reduce({ status, generation, held, audible }, command);
      if (!STATUSES.includes(next.status)) throw new Error(`Unhandled playback status ${next.status}`);
      status = next.status;
      generation = next.generation;
      held = next.held;
      audible = next.audible;
      return next;
    }

    return {
      get status() {
        return status;
      },
      get generation() {
        return generation;
      },
      get held() {
        return held;
      },
      get audible() {
        return audible;
      },
      dispatch,
    };
  }

  ns.transport = { createTransport, statuses: STATUSES };
})(globalThis.__readAloud);
