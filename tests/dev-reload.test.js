import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_ID_FILE,
  buildIdFromVersionName,
  decideReload,
  parseBuildId,
} from "../src/dev/build-id.js";
import { DEV_PERMISSIONS, TARGETS, isDevOnlySource, manifestFor, newBuildId } from "../tools/build.js";

const chrome = TARGETS.find((target) => target.name === "chrome");

// ---------------------------------------------------------------------------
// Naming the build that is running

test("a dev build's version_name names the build it was built from", () => {
  assert.equal(buildIdFromVersionName("1.0.0-dev+20261029T120000Z.abc123"), "20261029T120000Z.abc123");
});

test("a production version_name names no build, which is how it is told apart", () => {
  assert.equal(buildIdFromVersionName("1.0.0"), null);
  assert.equal(buildIdFromVersionName(undefined), null);
  assert.equal(buildIdFromVersionName(null), null);
  assert.equal(buildIdFromVersionName("1.0.0-dev+"), null);
  assert.equal(buildIdFromVersionName("1.0.0-dev+   "), null);
});

test("the build and the extension agree on how the build is named", () => {
  const manifest = manifestFor(chrome, { dev: true, buildId: "a-build" });
  assert.equal(buildIdFromVersionName(manifest.version_name), "a-build");
});

test("every build gets a name of its own", () => {
  const names = new Set(Array.from({ length: 200 }, () => newBuildId()));
  assert.equal(names.size, 200);
});

// ---------------------------------------------------------------------------
// Reading the build that is on disk

test("the build on disk is the buildId in build-id.json", () => {
  assert.equal(parseBuildId(JSON.stringify({ buildId: "on-disk", builtAt: "now" })), "on-disk");
});

test("a build-id.json caught half-written is no answer rather than an error", () => {
  assert.equal(parseBuildId(`{"buildId": "half`), null);
  assert.equal(parseBuildId(""), null);
  assert.equal(parseBuildId("null"), null);
  assert.equal(parseBuildId(undefined), null);
});

test("a build-id.json with nothing useful in it is no answer either", () => {
  assert.equal(parseBuildId(JSON.stringify({})), null);
  assert.equal(parseBuildId(JSON.stringify({ buildId: "" })), null);
  assert.equal(parseBuildId(JSON.stringify({ buildId: "   " })), null);
  assert.equal(parseBuildId(JSON.stringify({ buildId: 17 })), null);
});

// ---------------------------------------------------------------------------
// The decision

test("a build on disk that is not the one running is a reload", () => {
  const decision = decideReload({ running: "old", onDisk: "new" });
  assert.equal(decision.reload, true);
  assert.equal(decision.reason, "new-build");
  assert.equal(decision.buildId, "new");
});

test("the build it is already running is not", () => {
  assert.deepEqual(decideReload({ running: "same", onDisk: "same" }), {
    reload: false,
    reason: "unchanged",
    buildId: "same",
  });
});

/**
 * The reload loop this rules out: after reloading, the extension is running the
 * build it read off disk, so the very next comparison has to come out equal.
 */
test("a reload cannot chase its own tail", () => {
  const first = decideReload({ running: "one", onDisk: "two" });
  assert.equal(first.reload, true);
  const afterItComesBack = decideReload({ running: first.buildId, onDisk: "two" });
  assert.equal(afterItComesBack.reload, false);
});

test("a build-id.json that cannot be read holds everything where it is", () => {
  assert.deepEqual(decideReload({ running: "old", onDisk: null }), {
    reload: false,
    reason: "unreadable",
    buildId: null,
  });
});

test("a production build decides nothing at all", () => {
  assert.deepEqual(decideReload({ running: null, onDisk: "whatever" }), {
    reload: false,
    reason: "not-a-dev-build",
    buildId: null,
  });
});

test("an open popup postpones a reload rather than cancelling it", () => {
  const held = decideReload({ running: "old", onDisk: "new", popupOpen: true });
  assert.equal(held.reload, false);
  assert.equal(held.reason, "popup-open");
  // Still the build it will reload for, once the panel is gone.
  assert.equal(held.buildId, "new");
  assert.equal(decideReload({ running: "old", onDisk: "new", popupOpen: false }).reload, true);
});

// ---------------------------------------------------------------------------
// What a production build is not allowed to hold

test("the production manifest is the one it always was", () => {
  const manifest = manifestFor(chrome, { dev: false });
  assert.equal(manifest.version_name, undefined);
  assert.deepEqual(manifest.permissions, ["storage", "scripting", "activeTab"]);
  assert.equal(manifest.background.service_worker, "background/background.js");
});

test("a dev manifest differs from it by the worker, the alarm and the build name", () => {
  const production = manifestFor(chrome, { dev: false });
  const development = manifestFor(chrome, { dev: true, buildId: "a-build" });
  assert.deepEqual(development, {
    ...production,
    background: { ...production.background, service_worker: "dev/service-worker.js" },
    permissions: [...production.permissions, ...DEV_PERMISSIONS],
    version_name: `${production.version}-dev+a-build`,
  });
});

test("a dev build of the Firefox target is refused rather than guessed at", () => {
  const firefox = TARGETS.find((target) => target.name === "firefox");
  assert.throws(() => manifestFor(firefox, { dev: true, buildId: "a-build" }), /Chrome affordance/);
  // And the production Firefox build is untouched by any of it.
  const manifest = manifestFor(firefox, { dev: false });
  assert.equal(manifest.version_name, undefined);
  assert.deepEqual(manifest.permissions, ["storage", "scripting", "activeTab"]);
});

test("only src/dev is left out of a production build", () => {
  assert.equal(isDevOnlySource("dev/reload.js"), true);
  assert.equal(isDevOnlySource("dev/build-id.js"), true);
  assert.equal(isDevOnlySource("background/background.js"), false);
  assert.equal(isDevOnlySource("content/reader.js"), false);
  assert.equal(isDevOnlySource("manifest.chrome.json"), false);
  // Not a prefix match: a `devices/` directory would still ship.
  assert.equal(isDevOnlySource("devices/thing.js"), false);
});

test("the build writes the file the extension reads", () => {
  assert.equal(BUILD_ID_FILE, "build-id.json");
});
