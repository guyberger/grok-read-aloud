(function (ns) {
  "use strict";

  /**
   * Who the view belongs to while a page is being read.
   *
   * Scrolling to keep up with the voice is most of what makes a read
   * hands-free: the page moves itself and the spoken word stays in front of
   * you. It is also, the moment you reach for the wheel, the one thing between
   * you and the rest of the page — the figure being described, the footnote,
   * the paragraph you want to see again — because the next word lands a
   * fraction of a second later and takes the view straight back. A reader that
   * cannot be scrolled away from is a reader you have to pause to look at
   * anything.
   *
   * So the view is the listener's from the moment they scroll it themselves,
   * and the read carries on without it: the highlight still walks the words,
   * the audio still plays, nothing moves under their hands. It is the read's
   * again when the spoken word is back in the band a following read keeps it
   * in — scrolling back to where the voice is can only be a request to follow
   * it again — or when the listener names a place in the text themselves, by
   * starting a read, clicking or stepping to a sentence, or pressing play.
   *
   * Nothing here touches the view. The decision belongs here and the scrolling
   * stays in `highlight.js`, which is also where the band is measured.
   */

  /** The keys that scroll a document, so a press of one is a listener doing it. */
  const SCROLL_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " ",
    "Spacebar",
  ]);

  /** Where those keys move a caret or a value instead of the page. */
  const TYPED_INTO = new Set(["INPUT", "TEXTAREA", "SELECT"]);

  /** Whether this key press was aimed at the document rather than at a field. */
  function scrollsTheDocument(event) {
    if (!SCROLL_KEYS.has(event?.key)) return false;
    const target = event.target ?? null;
    if (target?.isContentEditable) return false;
    return !TYPED_INTO.has(String(target?.tagName ?? "").toUpperCase());
  }

  function createFollow() {
    let following = true;

    const follow = {
      /** Whether the read is the one moving the view at the moment. */
      get following() {
        return following;
      },

      /** The listener has taken the view; the read stops moving it. */
      release() {
        following = false;
      },

      /**
       * The read is given the view back. Every caller is a listener naming a
       * place in the text — a read started, a sentence clicked or stepped to,
       * a read resumed — and being shown it is the point of asking.
       */
      claim() {
        following = true;
      },

      /**
       * Whether the view should be moved to keep the spoken word in sight,
       * given whether that word is in the band a following read keeps it in.
       *
       * The word arriving back in the band on its own is how a release ends.
       * It takes the listener scrolling to where the voice is, which is the
       * same gesture they left with and needs no control of its own.
       */
      wants(inBand) {
        if (!following && inBand) following = true;
        return following;
      },

      /**
       * Watch for the listener scrolling, until the returned function is
       * called.
       *
       * The gestures rather than the `scroll` event: a smooth scroll of the
       * read's own fires a stream of those and nothing in one says who asked
       * for it, so a reader listening to them would hear itself scroll and let
       * go of the view it had just taken.
       */
      watch(target = document) {
        const release = () => follow.release();
        const onKeyDown = (event) => {
          if (scrollsTheDocument(event)) follow.release();
        };
        // Capture and passive: a page that handles its own wheel and touch
        // still tells us, and this can never be why one of them was slow.
        target.addEventListener("wheel", release, { passive: true, capture: true });
        target.addEventListener("touchmove", release, { passive: true, capture: true });
        target.addEventListener("keydown", onKeyDown, true);
        return () => {
          target.removeEventListener("wheel", release, true);
          target.removeEventListener("touchmove", release, true);
          target.removeEventListener("keydown", onKeyDown, true);
        };
      },
    };

    return follow;
  }

  ns.follow = { createFollow, scrollsTheDocument };
})(globalThis.__readAloud);
