(function (ns) {
  "use strict";

  /**
   * Decides which clicks belong to the reader.
   *
   * The page's own clicks must keep working, so this only ever observes: it
   * listens in the bubble phase, never calls `preventDefault` or
   * `stopPropagation`, and hands back nothing for a click any part of the page
   * might reasonably want. A page that handles a click itself and stops it
   * before it reaches the document never reaches this at all, which is the
   * right answer too.
   */

  const INTERACTIVE = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "label",
    "summary",
    "[contenteditable]",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='menuitem']",
    "[role='menuitemcheckbox']",
    "[role='menuitemradio']",
    "[role='option']",
    "[role='slider']",
    "[role='spinbutton']",
    "[role='tab']",
    "[role='textbox']",
    "[role='combobox']",
  ].join(",");

  // A press that travels further than this was a drag, not a click.
  const DRAG_SLOP_PX = 5;

  let pressedAt = null;

  function elementOf(target) {
    if (target instanceof Element) return target;
    return target?.parentElement ?? null;
  }

  /**
   * Whether `event` is a plain left click on ordinary text: no modifier, no
   * second click of a double, nothing interactive under it, nothing editable
   * around it, no selection left behind and no drag before it.
   */
  function isPlainTextClick(event) {
    if (event.button !== 0) return false;
    // A keyboard-activated click reports 0; the second of a double reports 2.
    if (event.detail !== 1) return false;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    if (event.defaultPrevented) return false;

    const element = elementOf(event.target);
    if (!element) return false;
    if (element.isContentEditable) return false;
    if (element.closest(INTERACTIVE)) return false;

    const selection = element.ownerDocument?.defaultView?.getSelection?.();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return false;

    if (pressedAt) {
      const dx = event.clientX - pressedAt.x;
      const dy = event.clientY - pressedAt.y;
      if (Math.hypot(dx, dy) > DRAG_SLOP_PX) return false;
    }

    return true;
  }

  /**
   * Calls `handler(event)` for every plain text click on the document, until
   * the function it returns is called.
   *
   * Listening is tied to a read rather than to the page: with nothing being
   * read there is nothing for a click to move, so there is no reason for the
   * extension to be in the page's click path at all.
   *
   * `hover`, when given, is the cursor's half of the same promise:
   * `hover.test(x, y)` says whether a click at that viewport point would be
   * the reader's, and `hover.change(over)` hears each time the answer for the
   * point under the pointer flips. It is asked again when the pointer moves
   * and when the page scrolls under a pointer that is standing still, at most
   * once a frame, and told `false` when the watch ends.
   */
  function watch(handler, { hover = null } = {}) {
    // Capture, so a page that swallows its own pointer events still tells us
    // where the press began and a drag is not mistaken for a click.
    const onPointerDown = (event) => {
      pressedAt = { x: event.clientX, y: event.clientY };
    };
    const onClick = (event) => {
      if (isPlainTextClick(event)) handler(event);
    };

    let point = null;
    let over = false;
    let frame = 0;
    const settle = () => {
      frame = 0;
      const now = Boolean(point) && Boolean(hover.test(point.x, point.y));
      if (now === over) return;
      over = now;
      hover.change(over);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(settle);
    };
    const onPointerMove = (event) => {
      // A finger has no cursor to change.
      if (event.pointerType === "touch") return;
      point = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const onScroll = () => {
      if (point) schedule();
    };
    const onPointerOut = (event) => {
      // Leaving the window, rather than one element for another.
      if (event.relatedTarget) return;
      point = null;
      schedule();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick);
    if (hover) {
      document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
      document.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
      // Capture, so a scrolling box inside the page counts as well as the page.
      document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    }

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick);
      // The next read starts without a press behind it, so a first click must
      // not be measured against where a pointer went down during the last one.
      pressedAt = null;
      if (!hover) return;
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("scroll", onScroll, true);
      cancelAnimationFrame(frame);
      frame = 0;
      if (over) {
        over = false;
        hover.change(false);
      }
    };
  }

  ns.pointer = { isPlainTextClick, watch };
})(globalThis.__readAloud);
