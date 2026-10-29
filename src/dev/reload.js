/**
 * Dev-only: notice a rebuild and reload the extension into it.
 *
 * Only `node tools/build.js --dev` copies this file into an extension at all,
 * and only that build's manifest points the background at the generated shim
 * that imports it. A production build has neither, holds no `build-id.json`
 * and asks for no extra permission — `tools/check.js` asserts all of that by
 * asking the build for both manifests.
 *
 * The decision itself is `build-id.js`. This is the wiring:
 *
 * - An alarm, because the thing that has to notice a rebuild is a worker Chrome
 *   has already stopped. Thirty seconds is the floor Chrome clamps an alarm to,
 *   so that is the worst case between a build landing and Chrome running it.
 * - A plain interval as well, so that while the worker happens to be awake —
 *   which is whenever the extension is being used — a rebuild shows up in about
 *   two seconds instead of thirty.
 *
 * Nothing here is on the path a message travels: the worker's own listener is
 * registered by `background.js`, which the shim imports first, and everything
 * below only ever schedules work. Opening the popup neither waits for a check
 * nor triggers one, and a check that lands while the panel is up postpones
 * itself rather than closing it.
 */
import { ext } from "../common/browser.js";
import { BUILD_ID_FILE, buildIdFromVersionName, decideReload, parseBuildId } from "./build-id.js";

const ALARM_NAME = "read-aloud-dev-build";
const ALARM_PERIOD_MINUTES = 0.5;
const POLL_MS = 2000;

/** The build whose code this worker is running. Fixed until the extension reloads. */
const RUNNING_BUILD_ID = buildIdFromVersionName(ext.runtime.getManifest().version_name);

/** One reload is enough; the interval must not stack a second one behind it. */
let reloading = false;

/**
 * `work`, or `fallback` if it takes too long.
 *
 * A page whose main thread is tied up answers a message when it frees up and
 * not before, which can be seconds — see [Why the popup paints before it knows
 * anything](#why-the-popup-paints-before-it-knows-anything). Tidying the tab up
 * is worth a moment's wait and no more; the reload itself must not be held
 * behind a wedged page.
 */
function within(ms, work, fallback) {
  return Promise.race([work, new Promise((done) => setTimeout(() => done(fallback), ms))]);
}

async function buildIdOnDisk() {
  try {
    const response = await fetch(ext.runtime.getURL(BUILD_ID_FILE), { cache: "no-store" });
    if (!response.ok) return null;
    return parseBuildId(await response.text());
  } catch {
    return null;
  }
}

/** Whether the panel is on screen, and so whether reloading would close it. */
async function popupIsOpen() {
  try {
    const contexts = await ext.runtime.getContexts({ contextTypes: ["POPUP"] });
    return contexts.length > 0;
  } catch {
    // Older Chrome, or no answer. Reloading is the lesser risk of the two.
    return false;
  }
}

/**
 * The active tab, if the content scripts are in it.
 *
 * A reload orphans them: they go on running in the page with no extension left
 * to talk to, so the first thing the listener does afterwards fails silently.
 * Reloading that tab first is what makes the new build's scripts the only ones
 * in it. Only the active tab, because that is the one being worked on, and
 * reloading a background tab would throw away a read nobody asked to end.
 */
async function injectedActiveTabId() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const pong = await within(2000, ext.tabs.sendMessage(tab.id, { type: "ping" }), null);
    return pong?.ok ? tab.id : null;
  } catch {
    // Nothing injected there, or a page that cannot be messaged at all.
    return null;
  }
}

async function check() {
  if (reloading) return;
  const [onDisk, popupOpen] = await Promise.all([buildIdOnDisk(), popupIsOpen()]);
  const decision = decideReload({ running: RUNNING_BUILD_ID, onDisk, popupOpen });
  if (!decision.reload) return;

  reloading = true;
  console.log(`[dev] reloading the extension for build ${decision.buildId} (was ${RUNNING_BUILD_ID})`);

  const tabId = await injectedActiveTabId();
  if (tabId !== null) {
    console.log(`[dev] reloading tab ${tabId}, which holds content scripts from the old build`);
    await within(2000, ext.tabs.reload(tabId).catch(() => {}), undefined);
  }

  // Everything above this line is gone a moment after it.
  ext.runtime.reload();
}

if (RUNNING_BUILD_ID) {
  ext.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) check();
  });
  setInterval(check, POLL_MS);
  // A rebuild that landed while the worker was stopped is already waiting.
  check();
} else {
  console.warn("[dev] no build id in version_name, so there is nothing to watch for");
}
