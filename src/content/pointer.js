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
   */
  function watch(handler) {
    // Capture, so a page that swallows its own pointer events still tells us
    // where the press began and a drag is not mistaken for a click.
    const onPointerDown = (event) => {
      pressedAt = { x: event.clientX, y: event.clientY };
    };
    const onClick = (event) => {
      if (isPlainTextClick(event)) handler(event);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick);
      // The next read starts without a press behind it, so a first click must
      // not be measured against where a pointer went down during the last one.
      pressedAt = null;
    };
  }

  ns.pointer = { isPlainTextClick, watch };
})(globalThis.__readAloud);
