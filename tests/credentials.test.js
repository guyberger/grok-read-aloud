import assert from "node:assert/strict";
import test from "node:test";

// `common/browser.js` reads the extension globals as it loads, and
// `credentials.js` pulls it in through `settings.js`.
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };

const { MESSAGES, withCredential } = await import("../src/common/credentials.js");

/** An error shaped like the one `tts-client.js` throws for an HTTP status. */
function apiError(status, message = `API error ${status}.`) {
  const error = new Error(message);
  error.name = "TtsError";
  error.status = status;
  return error;
}

/**
 * A stand-in for the sign-in module, recording what was asked of it.
 *
 * `tokens` is the sequence of access tokens `getAccessToken` hands out, so a
 * test can tell a forced refresh apart from the call before it.
 */
function fakeAuth({ signedIn = true, tierDenied = false, tokens = ["oauth-1", "oauth-2"], throws = null } = {}) {
  const calls = { tokens: [], markTierDenied: 0, clearTierDenied: 0 };
  let index = 0;
  let gated = tierDenied;
  return {
    calls,
    async hasUsableSession() {
      return signedIn && !gated;
    },
    async getStatus() {
      return { signedIn, tierDenied: gated };
    },
    async getAccessToken(options = {}) {
      calls.tokens.push(options);
      if (throws) throw throws;
      return tokens[Math.min(index++, tokens.length - 1)];
    },
    async markTierDenied() {
      gated = true;
      calls.markTierDenied += 1;
    },
    async clearTierDenied() {
      gated = false;
      calls.clearTierDenied += 1;
    },
  };
}

/* ----------------------------------------------- the API key on its own --- */

test("with only an API key, the key is used and nothing else is consulted", async () => {
  const auth = fakeAuth({ signedIn: false });
  const seen = [];

  const outcome = await withCredential(
    async (token, source) => {
      seen.push([token, source]);
      return "audio";
    },
    { auth, settings: { apiKey: "test-key" } },
  );

  assert.deepEqual(outcome, { result: "audio", source: "apiKey", notice: "" });
  assert.deepEqual(seen, [["test-key", "apiKey"]]);
  assert.equal(auth.calls.tokens.length, 0);
});

test("with only an API key, its errors come through untouched", async () => {
  const auth = fakeAuth({ signedIn: false });
  const rejection = apiError(401, "Incorrect API key provided.");

  await assert.rejects(
    withCredential(
      async () => {
        throw rejection;
      },
      { auth, settings: { apiKey: "test-key" } },
    ),
    (error) => {
      assert.equal(error, rejection, "the existing key path must behave exactly as it did");
      return true;
    },
  );
});

test("with no credentials at all, the message says so before any request", async () => {
  const auth = fakeAuth({ signedIn: false });
  let attempted = false;

  await assert.rejects(
    withCredential(
      async () => {
        attempted = true;
      },
      { auth, settings: { apiKey: "" } },
    ),
    (error) => {
      assert.equal(error.message, MESSAGES.none);
      return true;
    },
  );
  assert.equal(attempted, false);
});

/* ------------------------------------------------------- the sign-in ----- */

test("a sign-in is preferred over a key that is also set", async () => {
  const auth = fakeAuth();
  const seen = [];

  const outcome = await withCredential(
    async (token, source) => {
      seen.push([token, source]);
      return "audio";
    },
    { auth, settings: { apiKey: "test-key" } },
  );

  assert.equal(outcome.source, "oauth");
  assert.equal(outcome.notice, "");
  assert.deepEqual(seen, [["oauth-1", "oauth"]]);
});

test("a successful call clears a tier gate recorded earlier", async () => {
  const auth = fakeAuth();
  await withCredential(async () => "audio", { auth, settings: { apiKey: "" } });
  assert.equal(auth.calls.clearTierDenied, 1);
});

/* ------------------------------------------------- 401: refresh, retry --- */

test("a 401 costs one forced refresh before it counts as a rejection", async () => {
  const auth = fakeAuth({ tokens: ["oauth-stale", "oauth-fresh"] });
  const seen = [];

  const outcome = await withCredential(
    async (token, source) => {
      seen.push([token, source]);
      if (token === "oauth-stale") throw apiError(401);
      return "audio";
    },
    { auth, settings: { apiKey: "test-key" } },
  );

  assert.equal(outcome.source, "oauth", "a stale token is not a reason to fall back");
  assert.deepEqual(seen, [
    ["oauth-stale", "oauth"],
    ["oauth-fresh", "oauth"],
  ]);
  assert.deepEqual(auth.calls.tokens, [{}, { forceRefresh: true }]);
});

test("a 401 that survives the refresh falls back to the key, and says why", async () => {
  const auth = fakeAuth();
  const seen = [];

  const outcome = await withCredential(
    async (token, source) => {
      seen.push(source);
      if (source === "oauth") throw apiError(401);
      return "audio";
    },
    { auth, settings: { apiKey: "test-key" } },
  );

  assert.equal(outcome.source, "apiKey");
  assert.equal(outcome.notice, MESSAGES.staleWithKey);
  assert.deepEqual(seen, ["oauth", "oauth", "apiKey"]);
});

/* ------------------------------------------------------ 403: tier gate --- */

test("a 403 falls back to the key without trying a refresh", async () => {
  const auth = fakeAuth();
  const seen = [];

  const outcome = await withCredential(
    async (token, source) => {
      seen.push(source);
      if (source === "oauth") throw apiError(403, "The caller does not have permission.");
      return "audio";
    },
    { auth, settings: { apiKey: "test-key" } },
  );

  assert.equal(outcome.source, "apiKey");
  assert.equal(outcome.notice, MESSAGES.gatedWithKey);
  // No second OAuth attempt: a tier gate is not a stale token, and refreshing
  // against it only spends a refresh token to be told the same thing.
  assert.deepEqual(seen, ["oauth", "apiKey"]);
  assert.equal(auth.calls.markTierDenied, 1);
});

test("a 403 with no key to fall back on explains the gate", async () => {
  const auth = fakeAuth();

  await assert.rejects(
    withCredential(
      async () => {
        throw apiError(403);
      },
      { auth, settings: { apiKey: "" } },
    ),
    (error) => {
      assert.equal(error.message, MESSAGES.gatedNoKey);
      return true;
    },
  );
});

test("once gated, the next request leads with the key", async () => {
  const auth = fakeAuth();
  const settings = { apiKey: "test-key" };
  const attempt = async (token, source) => {
    if (source === "oauth") throw apiError(403);
    return "audio";
  };

  await withCredential(attempt, { auth, settings });
  const second = await withCredential(attempt, { auth, settings });

  assert.equal(second.source, "apiKey");
  assert.equal(second.notice, "", "nothing was worked around the second time");
  assert.equal(auth.calls.tokens.length, 1, "the gated sign-in is not tried again");
});

/* --------------------------------------------- everything else: no swap --- */

test("a server error is not a reason to switch credentials", async () => {
  const auth = fakeAuth();
  const sources = [];

  await assert.rejects(
    withCredential(
      async (token, source) => {
        sources.push(source);
        throw apiError(503, "upstream unavailable");
      },
      { auth, settings: { apiKey: "test-key" } },
    ),
    (error) => {
      assert.equal(error.message, "upstream unavailable");
      return true;
    },
  );
  assert.deepEqual(sources, ["oauth"], "the key would fare no better against a 503");
});

test("an aborted request is not a credential problem", async () => {
  const auth = fakeAuth();
  const abort = new Error("aborted");
  abort.name = "AbortError";

  await assert.rejects(
    withCredential(
      async () => {
        throw abort;
      },
      { auth, settings: { apiKey: "test-key" } },
    ),
    (error) => {
      assert.equal(error.name, "AbortError");
      return true;
    },
  );
});

test("a sign-in that cannot produce a token at all falls back to the key", async () => {
  const broken = new Error("Signed in, but with nothing to refresh. Sign in again.");
  broken.name = "AuthError";
  broken.reauth = true;
  const auth = fakeAuth({ throws: broken });

  const outcome = await withCredential(async (token, source) => source, {
    auth,
    settings: { apiKey: "test-key" },
  });

  assert.equal(outcome.result, "apiKey");
  assert.equal(outcome.notice, MESSAGES.staleWithKey);
});
