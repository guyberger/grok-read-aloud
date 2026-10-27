(function (ns) {
  "use strict";

  if (ns.controls) return;

  /**
   * The read, on the browser's own media controls.
   *
   * A keyboard's play/pause key, the button on a pair of headphones, the
   * notification the operating system shows for whatever is making sound, the
   * media panel behind the toolbar — every one of them reaches a page through
   * one interface, `navigator.mediaSession`, and every one of them works with
   * the tab in the background and the popup closed. For something that talks
   * for twenty minutes that is the natural place to pause it from: the
   * extension's own shortcuts act on the focused tab, and the popup needs the
   * toolbar icon clicked first.
   *
   * Nothing here is touched until a read starts. The media session belongs to
   * the page, which may have a player of its own, so the extension takes it
   * over only while it is the thing actually speaking and hands it back on the
   * way out.
   *
   * This is half of it. The other half is in `player.js`: anything that
   * reaches the audio element *without* coming through a handler below — a
   * phone call taking audio focus, a headphone unplugged, the page's own
   * player starting — has to be noticed too, or the panel goes on saying
   * Playing over a highlight that stopped moving.
   */

  /**
   * The actions put on the controls, and what each means to the reader.
   *
   * Registered one at a time because a browser that does not know an action
   * throws on it, and an unsupported `stop` must not take `pause` down with
   * it. Seeking is deliberately absent: a seek bar would be measured against
   * the audio element, which holds one chunk of a page rather than the page,
   * so it would promise a position it cannot keep. Stepping a sentence is what
   * a listener wants from those buttons anyway.
   */
  const ACTIONS = [
    ["play", "play"],
    ["pause", "pause"],
    ["stop", "stop"],
    ["previoustrack", "previous"],
    ["nexttrack", "next"],
  ];

  /** A reader status, as the state the controls should show. */
  const PLAYBACK_STATE = {
    // A chunk still being fetched is a read in progress. The controls keep
    // offering pause rather than flipping to a play button at every join —
    // which matches the popup, whose own button is held still while loading.
    loading: "playing",
    playing: "playing",
    paused: "paused",
  };

  let attached = false;
  /** The label the metadata currently carries, so it is written once. */
  let described = "";

  const session = () => globalThis.navigator?.mediaSession ?? null;

  /**
   * Run a reader action without letting it escape into the page. These are
   * called by the browser, not by the extension, so there is nothing above
   * them to catch a rejection.
   */
  function run(action) {
    try {
      Promise.resolve(action?.()).catch(() => {});
    } catch {
      // A handler that throws synchronously is still just a control that did
      // nothing.
    }
  }

  /**
   * Put the read on the controls. `actions` names what each button does:
   * `play`, `pause`, `stop`, `previous`, `next`.
   *
   * @returns {boolean} whether this browser has a media session to attach to
   */
  function attach(actions = {}) {
    const media = session();
    if (!media) return false;
    for (const [action, name] of ACTIONS) {
      try {
        media.setActionHandler(action, () => run(actions[name]));
      } catch {
        // This browser has no such action. The others are still worth having.
      }
    }
    attached = true;
    return true;
  }

  /**
   * Follow the read: which button the controls offer, and what they say is
   * being read. Called with the same snapshot the popup renders, on the same
   * transitions, so the two never disagree.
   */
  function update({ status, title = "", scope = "page" } = {}) {
    const media = session();
    if (!media || !attached) return;

    const state = PLAYBACK_STATE[status] ?? "none";
    media.playbackState = state;
    // Nothing is being read, so there is nothing for the controls to name.
    if (state === "none") {
      clearMetadata(media);
      return;
    }

    const label = describe(title, scope);
    if (label === described) return;
    if (typeof globalThis.MediaMetadata !== "function") return;
    described = label;
    media.metadata = new globalThis.MediaMetadata({
      title: label,
      // Which site is talking, which is the question a control that appeared
      // from a background tab actually raises.
      artist: globalThis.location?.hostname ?? "",
    });
  }

  /**
   * What the controls call this read. A selection read says so: it is the
   * explanation for a page that stops talking after two paragraphs.
   */
  function describe(title, scope) {
    const name = title.trim() || globalThis.location?.hostname || "This page";
    return scope === "selection" ? `${name} (selection)` : name;
  }

  function clearMetadata(media) {
    if (!described) return;
    described = "";
    media.metadata = null;
  }

  /** Hand the media session back to the page. */
  function detach() {
    const media = session();
    if (!media) return;
    for (const [action] of ACTIONS) {
      try {
        media.setActionHandler(action, null);
      } catch {
        // Never registered in the first place.
      }
    }
    media.playbackState = "none";
    clearMetadata(media);
    attached = false;
  }

  ns.controls = { attach, update, detach, actions: ACTIONS.map(([action]) => action) };
})(globalThis.__readAloud);
