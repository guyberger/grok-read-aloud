/**
 * The two names a dev build has for itself, and the rule that compares them.
 *
 * Nothing in here touches an extension API, because the whole of the reload
 * decision is this file and the whole of `tests/dev-reload.test.js` is this
 * file. `reload.js` is the wiring that feeds it.
 *
 * **The running build** is `version_name` from `chrome.runtime.getManifest()`.
 * Chrome reads the manifest once, when the extension is loaded, and keeps that
 * copy until the extension is reloaded — so it names the build whose code is
 * actually running, which is the question being asked.
 *
 * **The build on disk** is `buildId` from `build-id.json`, fetched through
 * `chrome.runtime.getURL`. An unpacked extension's fetch of its own file does
 * reach the disk rather than a snapshot taken at load time, which is the one
 * browser fact this mechanism rests on; see the README.
 *
 * The two agree the moment the extension is loaded, and disagree only after a
 * rebuild. That is what makes a reload loop impossible: the extension comes
 * back running the build it just read off disk, so the next comparison is
 * equal again.
 */

/** The file a dev build writes its id into, relative to the extension root. */
export const BUILD_ID_FILE = "build-id.json";

/** What `version_name` puts between the version and the build id. */
export const DEV_VERSION_MARK = "-dev+";

/**
 * The build id out of a `version_name`, or null for a manifest that has none —
 * which is every production manifest, so this doubles as "is this a dev build".
 */
export function buildIdFromVersionName(versionName) {
  if (typeof versionName !== "string") return null;
  const at = versionName.indexOf(DEV_VERSION_MARK);
  if (at < 0) return null;
  const id = versionName.slice(at + DEV_VERSION_MARK.length).trim();
  return id || null;
}

/**
 * The build id out of the body of `build-id.json`. A half-written file is the
 * normal case rather than the exotic one — the watcher can read it in the
 * middle of a rebuild — so anything unparsable is "no answer", not an error.
 */
export function parseBuildId(payload) {
  if (typeof payload !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const id = parsed?.buildId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Whether to reload, given what is running and what is on disk.
 *
 * `popupOpen` holds a reload back rather than cancelling it: the panel is on
 * screen for a second or two and the next poll is along in a moment, and
 * reloading under it would close it mid-click. It is also the reason none of
 * this is on the path a popup opens through — the worker decides on its own
 * schedule, never in answer to a message.
 */
export function decideReload({ running, onDisk, popupOpen = false }) {
  if (!running) return { reload: false, reason: "not-a-dev-build", buildId: null };
  if (!onDisk) return { reload: false, reason: "unreadable", buildId: null };
  if (onDisk === running) return { reload: false, reason: "unchanged", buildId: onDisk };
  if (popupOpen) return { reload: false, reason: "popup-open", buildId: onDisk };
  return { reload: true, reason: "new-build", buildId: onDisk };
}
