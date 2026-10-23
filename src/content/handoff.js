(function (ns) {
  "use strict";

  if (ns.handoff) return;

  /**
   * One read at a time, across every tab.
   *
   * Two voices reading different pages over each other are useless, and the
   * one nobody is listening to is still being billed by the character — so a
   * tab left reading in a background window is worse than useless. When a
   * read starts speaking, every other reader has to go quiet.
   *
   * No tab can see another, so the readers agree through the one thing they
   * share: a key in extension storage, which every injected content script is
   * already listening to. The tab about to speak writes its own id there, and
   * each other reader hears that write and pauses itself.
   *
   * Storage rather than a message from the background worker, for two
   * reasons. Messaging a tab that is not the active one is not something
   * `activeTab` alone reliably allows, and this extension holds nothing
   * broader on purpose. And a write reaches *every* reader at once, so a tab
   * the worker has lost track of — one left over from a worker that was
   * shut down and restarted — still hears it.
   */

  /** Not a settings key, so the worker's warm settings copy survives it. */
  const CLAIM_KEY = "readingClaim";

  /**
   * This reader. The same page can be open in two tabs and both can claim;
   * all that matters is that no two readers produce the same value.
   */
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  let held = false;

  const area = () => ns.ext?.storage?.local;

  /**
   * Take the read for this tab, which pauses whichever other tab had it.
   *
   * Nothing is written while this tab already holds the claim: a read that
   * crosses twenty chunk boundaries is one claim, not twenty writes.
   */
  async function take() {
    if (held) return false;
    held = true;
    try {
      await area().set({ [CLAIM_KEY]: { id, at: Date.now() } });
    } catch {
      // A claim is a convenience, like a remembered position: a storage area
      // that will not answer is no reason for the read to fail.
    }
    return true;
  }

  /**
   * Whether `changes`, as handed to `storage.onChanged`, is another tab taking
   * the read. Our own write comes back through the same listener, which is
   * what the id is for.
   */
  function taken(changes) {
    const claim = changes?.[CLAIM_KEY]?.newValue;
    if (!claim || claim.id === id) return false;
    held = false;
    return true;
  }

  ns.handoff = { CLAIM_KEY, id, take, taken, holds: () => held };
})(globalThis.__readAloud);
