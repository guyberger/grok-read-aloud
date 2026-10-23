import assert from "node:assert/strict";
import test from "node:test";
import { loadContentNamespace } from "./load-content.js";

/**
 * Each test gets its own namespace: a claim belongs to one reader, and the
 * module is that reader, so sharing one between tests would share a holder.
 */
function reader(initial = {}) {
  const ns = loadContentNamespace(["util.js", "handoff.js"]);
  const data = { ...initial };
  ns.ext = {
    storage: {
      local: {
        async get(key) {
          return key in data ? { [key]: data[key] } : {};
        },
        async set(patch) {
          Object.assign(data, patch);
        },
      },
    },
  };
  return { handoff: ns.handoff, data };
}

/** What `storage.onChanged` hands a listener when `claim` is written. */
const written = (claim) => ({ readingClaim: { newValue: claim } });

// ---------------------------------------------------------------------------
// Taking the read.
// ---------------------------------------------------------------------------

test("taking the read writes this reader's claim", async () => {
  const { handoff, data } = reader();
  assert.equal(handoff.holds(), false);
  assert.equal(await handoff.take(), true);

  assert.equal(data[handoff.CLAIM_KEY].id, handoff.id);
  assert.ok(data[handoff.CLAIM_KEY].at > 0);
  assert.equal(handoff.holds(), true);
});

test("two readers do not produce the same id", () => {
  assert.notEqual(reader().handoff.id, reader().handoff.id);
});

test("a read that crosses chunk boundaries claims once, not once a chunk", async () => {
  const { handoff, data } = reader();
  await handoff.take();
  const first = data[handoff.CLAIM_KEY];

  assert.equal(await handoff.take(), false, "already held");
  assert.equal(await handoff.take(), false);
  assert.equal(data[handoff.CLAIM_KEY], first, "no second write");
});

test("the claim lives under its own key, so settings are untouched", async () => {
  const { handoff, data } = reader({ apiKey: "untouched", rate: 2 });
  await handoff.take();

  assert.equal(data.apiKey, "untouched");
  assert.equal(data.rate, 2);
  assert.deepEqual(Object.keys(data).sort(), ["apiKey", "rate", handoff.CLAIM_KEY].sort());
});

test("storage that will not answer costs a claim, not a read", async () => {
  const ns = loadContentNamespace(["util.js", "handoff.js"]);
  ns.ext = {
    storage: {
      local: {
        set: async () => {
          throw new Error("storage is gone");
        },
      },
    },
  };

  assert.equal(await ns.handoff.take(), true, "the read carries on regardless");
  assert.equal(ns.handoff.holds(), true);
});

// ---------------------------------------------------------------------------
// Hearing another tab take it.
// ---------------------------------------------------------------------------

test("a reader does not yield to its own claim", async () => {
  const { handoff } = reader();
  await handoff.take();

  assert.equal(handoff.taken(written({ id: handoff.id })), false);
  assert.equal(handoff.holds(), true, "still ours");
});

test("another tab's claim is a handoff", async () => {
  const { handoff } = reader();
  await handoff.take();

  assert.equal(handoff.taken(written({ id: "another-tab", at: Date.now() })), true);
  assert.equal(handoff.holds(), false);
});

test("writes to anything else are not a handoff", async () => {
  const { handoff } = reader();
  await handoff.take();

  assert.equal(handoff.taken({ rate: { newValue: 2 } }), false);
  assert.equal(handoff.taken({ readingPositions: { newValue: {} } }), false);
  assert.equal(handoff.taken({}), false);
  assert.equal(handoff.taken(undefined), false);
  assert.equal(handoff.taken({ readingClaim: { oldValue: { id: "gone" } } }), false, "a cleared key claims nothing");
  assert.equal(handoff.holds(), true);
});

test("taking the read back writes again, which hands it back", async () => {
  const { handoff, data } = reader();
  await handoff.take();
  const first = data[handoff.CLAIM_KEY];

  handoff.taken(written({ id: "another-tab" }));
  assert.equal(await handoff.take(), true, "no longer held, so claiming it again writes");
  assert.notEqual(data[handoff.CLAIM_KEY], first);
  assert.equal(data[handoff.CLAIM_KEY].id, handoff.id);
});

test("the tab that spoke last is the one holding the read", async () => {
  const a = reader();
  const b = reader();

  // A starts reading, then B does: B's write is what A hears.
  await a.handoff.take();
  await b.handoff.take();
  assert.equal(a.handoff.taken(written({ id: b.handoff.id })), true);
  assert.equal(b.handoff.taken(written({ id: b.handoff.id })), false);
  assert.equal(a.handoff.holds(), false);
  assert.equal(b.handoff.holds(), true);

  // A is resumed, and now B is the one that has to go quiet.
  await a.handoff.take();
  assert.equal(b.handoff.taken(written({ id: a.handoff.id })), true);
  assert.equal(a.handoff.holds(), true);
  assert.equal(b.handoff.holds(), false);
});
