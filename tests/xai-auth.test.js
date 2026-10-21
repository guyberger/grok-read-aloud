import assert from "node:assert/strict";
import test from "node:test";

/**
 * `common/browser.js` reads `globalThis.chrome` as the module loads, so the
 * stub has to exist before the import does. Hence the dynamic import below
 * rather than a static one at the top.
 */
const store = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
      },
      async set(patch) {
        for (const [key, value] of Object.entries(patch)) store.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
    },
  },
};

const auth = await import("../src/common/xai-auth.js");

const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  store.clear();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Replaces `fetch` with canned responses, one per call, and records the calls. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError("not json");
        return next.body;
      },
    };
  };
  return calls;
}

const DEVICE_RESPONSE = {
  device_code: "device-abc",
  user_code: "MOCK-0001",
  verification_uri: "https://accounts.x.ai/oauth2/device",
  verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=MOCK-0001",
  expires_in: 1800,
  interval: 5,
};

const TOKEN_RESPONSE = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "Bearer",
  expires_in: 3600,
};

/* ------------------------------------------------------- the constants --- */

test("the endpoints and client are the ones xAI publishes", () => {
  assert.equal(auth.XAI_OAUTH.issuer, "https://auth.x.ai");
  assert.equal(auth.XAI_OAUTH.deviceCodeUrl, "https://auth.x.ai/oauth2/device/code");
  assert.equal(auth.XAI_OAUTH.tokenUrl, "https://auth.x.ai/oauth2/token");
  assert.equal(auth.XAI_OAUTH.grantType, "urn:ietf:params:oauth:grant-type:device_code");
  // A refresh token only exists because of `offline_access`, and the bearer
  // only reaches api.x.ai because of `api:access`. Losing either silently
  // breaks a different half of the feature.
  const scopes = auth.XAI_OAUTH.scope.split(" ");
  assert.ok(scopes.includes("offline_access"));
  assert.ok(scopes.includes("api:access"));
});

/* ------------------------------------------------------ the device code --- */

test("a device code request asks for the client and scope, and nothing else", async () => {
  const calls = stubFetch([{ status: 200, body: DEVICE_RESPONSE }]);
  const device = await auth.requestDeviceCode();

  assert.equal(calls[0].url, auth.XAI_OAUTH.deviceCodeUrl);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["client_id", "scope"]);
  assert.equal(calls[0].body.client_id, auth.XAI_OAUTH.clientId);
  assert.equal(device.userCode, "MOCK-0001");
  assert.equal(device.verificationUrlComplete, DEVICE_RESPONSE.verification_uri_complete);
  assert.equal(device.interval, 5);
});

test("a device code response missing a field is rejected rather than half-used", async () => {
  stubFetch([{ status: 200, body: { device_code: "d", expires_in: 600, interval: 5 } }]);
  await assert.rejects(auth.requestDeviceCode(), (error) => {
    assert.equal(error.code, "device_code_invalid");
    assert.match(error.message, /user_code, verification_uri/);
    return true;
  });
});

test("a refused device code request carries xAI's own explanation", async () => {
  stubFetch([{ status: 400, body: { error: "invalid_client", error_description: "Unknown client." } }]);
  await assert.rejects(auth.requestDeviceCode(), (error) => {
    assert.equal(error.message, "Unknown client.");
    assert.equal(error.status, 400);
    return true;
  });
});

/* ---------------------------------------------------------- the polling --- */

test("polling waits through authorization_pending and slow_down", async () => {
  const calls = stubFetch([
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 200, body: TOKEN_RESPONSE },
  ]);
  const waits = [];

  const payload = await auth.pollForToken({
    deviceCode: "device-abc",
    interval: 5,
    expiresIn: 600,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(payload.access_token, "access-1");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].body.grant_type, auth.XAI_OAUTH.grantType);
  assert.equal(calls[0].body.device_code, "device-abc");
  // slow_down costs the one extra second RFC 8628 asks for, and keeps it.
  assert.deepEqual(waits, [5000, 6000, 6000]);
});

test("a declined sign-in stops the poll instead of waiting it out", async () => {
  const calls = stubFetch([{ status: 400, body: { error: "access_denied", error_description: "Declined." } }]);
  await assert.rejects(
    auth.pollForToken({ deviceCode: "d", interval: 1, expiresIn: 600, wait: async () => {} }),
    (error) => {
      assert.equal(error.message, "Declined.");
      assert.equal(error.code, "access_denied");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("polling gives up when the code expires", async () => {
  let clock = 0;
  stubFetch([{ status: 400, body: { error: "authorization_pending" } }]);
  await assert.rejects(
    auth.pollForToken({
      deviceCode: "d",
      interval: 5,
      expiresIn: 10,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    }),
    (error) => {
      assert.equal(error.code, "expired");
      return true;
    },
  );
});

test("a cancelled sign-in stops polling", async () => {
  const controller = new AbortController();
  controller.abort();
  stubFetch([{ status: 200, body: TOKEN_RESPONSE }]);
  await assert.rejects(
    auth.pollForToken({ deviceCode: "d", expiresIn: 600, signal: controller.signal, wait: async () => {} }),
    (error) => {
      assert.equal(error.code, "cancelled");
      return true;
    },
  );
});

/* ------------------------------------------------------- the whole flow --- */

test("signing in shows the prompt before it has a token, and stores one after", async () => {
  stubFetch([
    { status: 200, body: DEVICE_RESPONSE },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 200, body: TOKEN_RESPONSE },
  ]);

  let prompted = null;
  const status = await auth.signIn({
    onPrompt: (details) => {
      prompted = details;
      // The prompt arrives while there is still nothing stored, which is the
      // point: the user is looking at it during the wait, not after it.
      assert.equal(store.has("xaiOAuth"), false);
    },
    wait: async () => {},
  });

  assert.equal(prompted.userCode, "MOCK-0001");
  assert.equal(status.signedIn, true);
  assert.equal(status.canRefresh, true);
  assert.equal(store.get("xaiOAuth").accessToken, "access-1");
  // The status a popup or an options page is handed has no token in it.
  assert.deepEqual(
    Object.keys(status).filter((key) => /token/i.test(key)),
    [],
  );
});

test("signing out forgets the tokens and asks xAI to revoke the grant", async () => {
  store.set("xaiOAuth", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 1e6 });
  const calls = stubFetch([{ status: 200, body: {} }]);

  const status = await auth.signOut();

  assert.equal(status.signedIn, false);
  assert.equal(store.has("xaiOAuth"), false);
  assert.equal(calls[0].url, auth.XAI_OAUTH.revokeUrl);
  assert.equal(calls[0].body.token, "refresh-1");
  assert.equal(calls[0].body.token_type_hint, "refresh_token");
});

test("signing out forgets the tokens even when revocation fails", async () => {
  store.set("xaiOAuth", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 1e6 });
  globalThis.fetch = async () => {
    throw new Error("network down");
  };

  await auth.signOut();
  assert.equal(store.has("xaiOAuth"), false);
});

/* ---------------------------------------------------------- the refresh --- */

test("a token well short of expiry is used as it is", async () => {
  store.set("xaiOAuth", {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 6 * 60 * 60 * 1000,
  });
  const calls = stubFetch([{ status: 200, body: TOKEN_RESPONSE }]);

  assert.equal(await auth.getAccessToken(), "access-1");
  assert.equal(calls.length, 0, "nothing to refresh yet");
});

test("a token close to expiry is refreshed before it is handed out", async () => {
  store.set("xaiOAuth", {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 60 * 1000,
    signedInAt: 1000,
  });
  const calls = stubFetch([
    { status: 200, body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 } },
  ]);

  assert.equal(await auth.getAccessToken(), "access-2");
  assert.equal(calls[0].url, auth.XAI_OAUTH.tokenUrl);
  assert.equal(calls[0].body.grant_type, "refresh_token");
  assert.equal(calls[0].body.refresh_token, "refresh-1");
  // The rotated refresh token replaces the spent one, or the next refresh
  // fails with invalid_grant.
  assert.equal(store.get("xaiOAuth").refreshToken, "refresh-2");
  // Signing in again is not what happened, so the original sign-in date stays.
  assert.equal(store.get("xaiOAuth").signedInAt, 1000);
});

test("a refresh that returns no new refresh token keeps the old one", async () => {
  store.set("xaiOAuth", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 60 * 1000 });
  stubFetch([{ status: 200, body: { access_token: "access-2", expires_in: 3600 } }]);

  await auth.getAccessToken();
  assert.equal(store.get("xaiOAuth").refreshToken, "refresh-1");
});

test("a short-lived token gets a short refresh lead, so it is not refreshed on every call", () => {
  const now = Date.now();
  // Six hours out: refresh an hour before, as usual.
  assert.equal(auth.refreshSkewMs(now + 6 * 60 * 60 * 1000, now), 60 * 60 * 1000);
  // Fifteen minutes out: an hour of lead would mean refreshing on every single
  // call, burning a single-use refresh token each time.
  assert.equal(auth.refreshSkewMs(now + 15 * 60 * 1000, now), 2 * 60 * 1000);
});

test("expiry falls back to the JWT's own exp when the response omits expires_in", async () => {
  const exp = Math.floor(Date.now() / 1000) + 900;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const jwt = `header.${payload}.signature`;
  store.set("xaiOAuth", { accessToken: "old", refreshToken: "refresh-1", expiresAt: Date.now() + 60 * 1000 });
  stubFetch([{ status: 200, body: { access_token: jwt, refresh_token: "refresh-2" } }]);

  assert.equal(auth.jwtExpiry(jwt), exp * 1000);
  await auth.getAccessToken();
  assert.equal(store.get("xaiOAuth").expiresAt, exp * 1000);
});

test("a refresh that fails on the network leaves the token in place", async () => {
  store.set("xaiOAuth", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 60 * 1000 });
  globalThis.fetch = async () => {
    throw new Error("network down");
  };

  // The stored token may well still work; throwing here would turn a blip into
  // a sign-out.
  assert.equal(await auth.getAccessToken(), "access-1");
  assert.equal(store.get("xaiOAuth").accessToken, "access-1");
});

test("a revoked grant is reported as needing a new sign-in", async () => {
  store.set("xaiOAuth", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 60 * 1000 });
  stubFetch([{ status: 400, body: { error: "invalid_grant", error_description: "Refresh token revoked." } }]);

  await assert.rejects(auth.getAccessToken(), (error) => {
    assert.equal(error.message, "Refresh token revoked.");
    assert.equal(error.reauth, true);
    return true;
  });
});

/* ------------------------------------------------------- the tier gate ---- */

test("a 403 from the token endpoint is the tier gate, not a stale token", async () => {
  store.set("xaiOAuth", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 60 * 1000 });
  stubFetch([{ status: 403, body: { error: "access_denied" } }]);

  await assert.rejects(auth.getAccessToken(), (error) => {
    assert.equal(error.code, "tier_denied");
    assert.equal(error.reauth, false, "signing in again cannot lift a tier gate");
    assert.match(error.message, /subscription tier/);
    return true;
  });
  assert.equal(store.get("xaiOAuth").tierDenied, true);
});

test("a gated session is signed in but not worth trying", async () => {
  store.set("xaiOAuth", { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 1e6 });
  assert.equal(await auth.hasUsableSession(), true);

  await auth.markTierDenied();
  assert.equal(await auth.hasUsableSession(), false);
  assert.equal((await auth.getStatus()).signedIn, true);
  assert.equal((await auth.getStatus()).tierDenied, true);

  await auth.clearTierDenied();
  assert.equal(await auth.hasUsableSession(), true);
});

/* --------------------------------------------------------- the quiet bit -- */

test("nothing in a sign-in, a refresh or a sign-out is ever logged", async () => {
  const written = [];
  const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"];
  const originals = Object.fromEntries(consoleMethods.map((name) => [name, console[name]]));
  for (const name of consoleMethods) {
    console[name] = (...parts) => written.push(parts.map(String).join(" "));
  }

  try {
    stubFetch([
      { status: 200, body: DEVICE_RESPONSE },
      { status: 200, body: { access_token: "secret-access", refresh_token: "secret-refresh", expires_in: 1 } },
    ]);
    await auth.signIn({ wait: async () => {} });
    // expires_in of 1 second means the very next call has to refresh.
    stubFetch([
      { status: 200, body: { access_token: "secret-access-2", refresh_token: "secret-refresh-2", expires_in: 3600 } },
    ]);
    await auth.getAccessToken();
    stubFetch([{ status: 200, body: {} }]);
    await auth.signOut();
  } finally {
    for (const name of consoleMethods) console[name] = originals[name];
  }

  const leaked = ["secret-access", "secret-refresh", "secret-access-2", "secret-refresh-2", "device-abc"].filter(
    (token) => written.some((line) => line.includes(token)),
  );
  assert.deepEqual(leaked, [], `these reached the console: ${leaked.join(", ")}`);
  assert.deepEqual(written, [], "the auth module should write nothing at all");
});

/* ------------------------------------------------- the pending sign-in ---- */

test("a sign-in in progress survives the UI that started it", async () => {
  assert.equal(await auth.readPendingFlow(), null);
  await auth.savePendingFlow({ userCode: "MOCK-0001", verificationUrl: "https://accounts.x.ai/oauth2/device" });
  assert.equal((await auth.readPendingFlow()).userCode, "MOCK-0001");
  await auth.clearPendingFlow();
  assert.equal(await auth.readPendingFlow(), null);
});
