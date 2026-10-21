/**
 * Sign in with xAI: the OAuth 2.0 device authorization grant (RFC 8628)
 * against `auth.x.ai`, and the token store it fills.
 *
 * The access token this produces goes to `api.x.ai` in exactly the same
 * `Authorization: Bearer …` header an API key goes in, including for TTS, so
 * nothing downstream of `getCredential()` has to know which one it was handed.
 *
 * Every value below is a public one, read from xAI's own discovery document
 * and from Hermes Agent's `xai-oauth` provider, which is the only published
 * client of this flow. See README for which is which.
 */
import { ext } from "./browser.js";

/** Where the tokens live in `storage.local`. Never leaves this module. */
const STORE_KEY = "xaiOAuth";
/** A sign-in in progress, kept out of the token record so a failure cannot strand it. */
const FLOW_KEY = "xaiOAuthFlow";

/**
 * xAI's OAuth endpoints, as `https://auth.x.ai/.well-known/openid-configuration`
 * publishes them. They are listed rather than discovered at runtime so the
 * extension declares one host permission instead of trusting whatever a
 * discovery response names, and so a sign-in costs one request fewer.
 * `verifyEndpoints()` checks them against the live document.
 */
export const XAI_OAUTH = {
  issuer: "https://auth.x.ai",
  discoveryUrl: "https://auth.x.ai/.well-known/openid-configuration",
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  revokeUrl: "https://auth.x.ai/oauth2/revoke",
  /**
   * The device-code grant has no client secret — xAI advertises `none` among
   * its `token_endpoint_auth_methods_supported`, so this is a public client.
   *
   * This is Hermes Agent's registered client id. xAI does not publish a way to
   * register one, and the device-code endpoint rejects an unknown id, so there
   * is no id of our own to use yet. Replace it the moment xAI offers
   * registration: it is the one value here that says who is asking.
   */
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  /**
   * `offline_access` is what buys the refresh token; `api:access` is what the
   * bearer needs to reach `api.x.ai`. The rest are the identity scopes the
   * same grant asks for.
   */
  scope: "openid profile email offline_access grok-cli:access api:access",
  grantType: "urn:ietf:params:oauth:grant-type:device_code",
};

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

/**
 * Refresh this far before `exp` rather than on the 401.
 *
 * A device-code login can hand back a token good for hours or for a quarter of
 * an hour, and an hour of lead time on a fifteen-minute token means refreshing
 * on every single call — which burns a single-use refresh token each time and
 * races concurrent callers into `invalid_grant`. So the lead time shrinks to
 * two minutes once a token is nearly spent. Same shape as Hermes.
 */
const MAX_REFRESH_SKEW_MS = 60 * 60 * 1000;
const SHORT_REFRESH_SKEW_MS = 2 * 60 * 1000;
const SHORT_TOKEN_MS = 45 * 60 * 1000;

export function refreshSkewMs(expiresAt, now = Date.now()) {
  const remaining = expiresAt - now;
  return remaining > 0 && remaining <= SHORT_TOKEN_MS ? SHORT_REFRESH_SKEW_MS : MAX_REFRESH_SKEW_MS;
}

export class AuthError extends Error {
  constructor(message, { code = "", status = 0, reauth = false } = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    // Whether signing in again could plausibly fix it. Tier gating cannot be.
    this.reauth = reauth;
  }
}

/** The `exp` claim of a JWT access token, in ms, or 0 when there is none. */
export function jwtExpiry(token) {
  if (typeof token !== "string" || !token.includes(".")) return 0;
  const [, payload] = token.split(".");
  if (!payload) return 0;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)));
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * When a token handed back by the token endpoint stops being usable.
 *
 * `expires_in` is what the response says; the JWT's own `exp` is the fallback,
 * and an hour is the fallback to that. Guessing short is the safe direction —
 * the worst an early refresh costs is one request.
 */
function expiryOf(payload, now) {
  const seconds = Number(payload?.expires_in);
  if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000;
  return jwtExpiry(payload?.access_token) || now + 60 * 60 * 1000;
}

/**
 * The stored token record, which is the whole of what "signed in" means.
 * No token ever leaves here as part of a status, a log line or an error.
 */
async function readStore() {
  const stored = await ext.storage.local.get(STORE_KEY);
  const record = stored?.[STORE_KEY];
  return record && typeof record === "object" ? record : null;
}

async function writeStore(record) {
  await ext.storage.local.set({ [STORE_KEY]: record });
}

export async function clearTokens() {
  await ext.storage.local.remove([STORE_KEY, FLOW_KEY]);
}

function recordFrom(payload, previous = null, now = Date.now()) {
  const accessToken = String(payload?.access_token || "").trim();
  // xAI rotates the refresh token on most refreshes, but not all; keeping the
  // old one when none comes back is what stops a signed-in session from
  // silently becoming unrefreshable.
  const refreshToken = String(payload?.refresh_token || previous?.refreshToken || "").trim();
  return {
    accessToken,
    refreshToken,
    tokenType: String(payload?.token_type || "Bearer").trim() || "Bearer",
    scope: String(payload?.scope || previous?.scope || XAI_OAUTH.scope),
    expiresAt: expiryOf(payload, now),
    obtainedAt: now,
    signedInAt: previous?.signedInAt ?? now,
    // Set when xAI answers 403 to a token this grant produced: the grant is
    // real, the account is simply not allowed through. Re-signing in does not
    // clear it, so it is sticky until the next successful call.
    tierDenied: false,
  };
}

/**
 * Public view of the session. Deliberately has no token in it, so a popup, an
 * options page or a log line can hold it safely.
 */
export function statusOf(record, now = Date.now()) {
  if (!record?.accessToken) return { signedIn: false };
  return {
    signedIn: true,
    expiresAt: record.expiresAt,
    expiresInSeconds: Math.max(0, Math.round((record.expiresAt - now) / 1000)),
    signedInAt: record.signedInAt,
    scope: record.scope,
    canRefresh: Boolean(record.refreshToken),
    tierDenied: Boolean(record.tierDenied),
  };
}

export async function getStatus() {
  return statusOf(await readStore());
}

/** The message body of an OAuth error response, whatever shape it arrived in. */
function oauthErrorDetail(body, fallback) {
  if (!body || typeof body !== "object") return fallback;
  const description = String(body.error_description || "").trim();
  const code = String(body.error || "").trim();
  return description || code || fallback;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function postForm(url, fields) {
  return fetch(url, {
    method: "POST",
    headers: FORM_HEADERS,
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * Step one: ask xAI for a device code, and with it the URL and user code the
 * person has to approve.
 */
export async function requestDeviceCode({ scope = XAI_OAUTH.scope } = {}) {
  let response;
  try {
    response = await postForm(XAI_OAUTH.deviceCodeUrl, { client_id: XAI_OAUTH.clientId, scope });
  } catch (error) {
    throw new AuthError(`Could not reach ${XAI_OAUTH.issuer}: ${error.message}`, {
      code: "device_code_unreachable",
    });
  }

  const body = await readJson(response);
  if (!response.ok) {
    throw new AuthError(
      oauthErrorDetail(body, `xAI refused the sign-in request (HTTP ${response.status}).`),
      { code: "device_code_request_failed", status: response.status },
    );
  }

  const missing = ["device_code", "user_code", "verification_uri", "expires_in", "interval"].filter(
    (field) => !body?.[field],
  );
  if (missing.length) {
    throw new AuthError(`xAI's sign-in response was missing ${missing.join(", ")}.`, {
      code: "device_code_invalid",
    });
  }

  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUrl: String(body.verification_uri),
    // Carries the user code already, so approving usually needs no typing.
    verificationUrlComplete: String(body.verification_uri_complete || body.verification_uri),
    expiresIn: Number(body.expires_in),
    interval: Math.max(1, Number(body.interval) || 5),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Step two: poll the token endpoint until the person approves, declines, or
 * the code runs out.
 *
 * `authorization_pending` is the normal answer and means wait. `slow_down`
 * means wait longer, by the one second RFC 8628 asks for. Everything else is
 * an answer, including the ones that end the flow.
 */
export async function pollForToken({
  deviceCode,
  interval = 5,
  expiresIn = 600,
  now = () => Date.now(),
  wait = sleep,
  signal = null,
} = {}) {
  const deadline = now() + expiresIn * 1000;
  let currentInterval = interval;

  while (now() < deadline) {
    if (signal?.aborted) throw new AuthError("Sign-in cancelled.", { code: "cancelled" });

    let response;
    try {
      response = await postForm(XAI_OAUTH.tokenUrl, {
        grant_type: XAI_OAUTH.grantType,
        client_id: XAI_OAUTH.clientId,
        device_code: deviceCode,
      });
    } catch (error) {
      throw new AuthError(`Could not reach ${XAI_OAUTH.issuer}: ${error.message}`, {
        code: "token_unreachable",
      });
    }

    const body = await readJson(response);
    if (response.ok && body?.access_token) return body;

    const code = String(body?.error || "").trim();
    if (code === "authorization_pending") {
      await wait(currentInterval * 1000);
      continue;
    }
    if (code === "slow_down") {
      currentInterval = Math.min(currentInterval + 1, 30);
      await wait(currentInterval * 1000);
      continue;
    }
    if (response.ok) {
      throw new AuthError("xAI approved the sign-in but sent no access token.", {
        code: "token_invalid",
      });
    }
    throw new AuthError(
      oauthErrorDetail(body, `xAI rejected the sign-in (HTTP ${response.status}).`),
      { code: code || "token_failed", status: response.status },
    );
  }

  throw new AuthError("The sign-in code expired before it was approved.", { code: "expired" });
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * A 403 here is the tier gate rather than a stale grant: the account holds a
 * valid grant that xAI will not let through to the API. Signing in again
 * cannot change that, which is why it carries its own code.
 */
export async function refreshTokens(refreshToken) {
  if (!refreshToken) {
    throw new AuthError("Signed in, but with nothing to refresh. Sign in again.", {
      code: "missing_refresh_token",
      reauth: true,
    });
  }

  let response;
  try {
    response = await postForm(XAI_OAUTH.tokenUrl, {
      grant_type: "refresh_token",
      client_id: XAI_OAUTH.clientId,
      refresh_token: refreshToken,
    });
  } catch (error) {
    throw new AuthError(`Could not reach ${XAI_OAUTH.issuer}: ${error.message}`, {
      code: "refresh_unreachable",
    });
  }

  const body = await readJson(response);
  if (response.status === 403) {
    throw new AuthError(
      "This xAI account is not allowed through to the API. xAI gates OAuth access by " +
        "subscription tier, so signing in again will not change it — use an API key instead.",
      { code: "tier_denied", status: 403 },
    );
  }
  if (!response.ok || !body?.access_token) {
    throw new AuthError(
      oauthErrorDetail(body, `Refreshing the xAI sign-in failed (HTTP ${response.status}).`),
      {
        code: String(body?.error || "refresh_failed"),
        status: response.status,
        reauth: response.status === 400 || response.status === 401,
      },
    );
  }
  return body;
}

/**
 * The whole sign-in, from device code to stored tokens.
 *
 * `onPrompt` is handed the verification URL and user code as soon as they
 * exist, which is well before this resolves — showing them is the point, and
 * the wait after that is however long approval takes.
 */
export async function signIn({ onPrompt, signal = null, wait = sleep } = {}) {
  const device = await requestDeviceCode();
  onPrompt?.({
    verificationUrl: device.verificationUrl,
    verificationUrlComplete: device.verificationUrlComplete,
    userCode: device.userCode,
    expiresIn: device.expiresIn,
    interval: device.interval,
  });

  const payload = await pollForToken({
    deviceCode: device.deviceCode,
    interval: device.interval,
    expiresIn: device.expiresIn,
    signal,
    wait,
  });

  const record = recordFrom(payload);
  if (!record.accessToken) {
    throw new AuthError("xAI approved the sign-in but sent no access token.", { code: "token_invalid" });
  }
  await writeStore(record);
  return statusOf(record);
}

/**
 * Sign out: forget the tokens here, and ask xAI to forget the grant.
 *
 * Revocation is best effort on purpose. If it fails the local tokens still go,
 * and leaving them behind because a network call failed would be the worse of
 * the two outcomes.
 */
export async function signOut() {
  const record = await readStore();
  const refreshToken = record?.refreshToken;
  await clearTokens();
  if (!refreshToken) return { signedIn: false };
  try {
    await postForm(XAI_OAUTH.revokeUrl, {
      client_id: XAI_OAUTH.clientId,
      token: refreshToken,
      token_type_hint: "refresh_token",
    });
  } catch {
    // The grant stays live at xAI until it expires. Nothing else to do.
  }
  return { signedIn: false };
}

/**
 * The access token to use right now, refreshed first if it is close enough to
 * expiry to be worth not finding out the hard way.
 */
export async function getAccessToken({ forceRefresh = false } = {}) {
  const record = await readStore();
  if (!record?.accessToken) {
    throw new AuthError("Not signed in to xAI.", { code: "signed_out", reauth: true });
  }

  const now = Date.now();
  const expiring = record.expiresAt - refreshSkewMs(record.expiresAt, now) <= now;
  if (!forceRefresh && !expiring) return record.accessToken;

  try {
    const payload = await refreshTokens(record.refreshToken);
    const refreshed = recordFrom(payload, record);
    await writeStore(refreshed);
    return refreshed.accessToken;
  } catch (error) {
    if (error.code === "tier_denied") await markTierDenied();
    // A refresh that failed on the network leaves a token that may still work;
    // a grant xAI has rejected outright does not.
    if (error.reauth || error.code === "tier_denied" || !record.accessToken) throw error;
    return record.accessToken;
  }
}

/** Remember that xAI gated this account, so the next call does not try first. */
export async function markTierDenied() {
  const record = await readStore();
  if (!record || record.tierDenied) return;
  await writeStore({ ...record, tierDenied: true });
}

/** Any successful call clears the gate flag — the account got through. */
export async function clearTierDenied() {
  const record = await readStore();
  if (!record?.tierDenied) return;
  await writeStore({ ...record, tierDenied: false });
}

/**
 * Whether the stored sign-in is worth trying for the next request. A gated
 * account is signed in and useless, which is exactly the case the API key is
 * the fallback for.
 */
export async function hasUsableSession() {
  const record = await readStore();
  return Boolean(record?.accessToken) && !record.tierDenied;
}

/**
 * A sign-in in progress, so that closing the popup mid-flow does not lose it:
 * the worker keeps polling, and whatever opens next reads the prompt from here.
 */
export async function savePendingFlow(flow) {
  await ext.storage.local.set({ [FLOW_KEY]: flow });
}

export async function readPendingFlow() {
  const stored = await ext.storage.local.get(FLOW_KEY);
  const flow = stored?.[FLOW_KEY];
  return flow && typeof flow === "object" ? flow : null;
}

export async function clearPendingFlow() {
  await ext.storage.local.remove(FLOW_KEY);
}

/**
 * Check the hard-coded endpoints against xAI's published discovery document.
 *
 * Not on any request path — this is for `npm run check` and for a human asking
 * whether the constants above have drifted.
 */
export async function verifyEndpoints() {
  const response = await fetch(XAI_OAUTH.discoveryUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new AuthError(`Discovery returned HTTP ${response.status}.`, { code: "discovery" });
  const body = await response.json();
  const expected = {
    device_authorization_endpoint: XAI_OAUTH.deviceCodeUrl,
    token_endpoint: XAI_OAUTH.tokenUrl,
    revocation_endpoint: XAI_OAUTH.revokeUrl,
  };
  const drifted = Object.entries(expected)
    .filter(([field, url]) => body?.[field] !== url)
    .map(([field, url]) => `${field}: expected ${url}, discovery says ${body?.[field] ?? "nothing"}`);
  const scopes = new Set(Array.isArray(body?.scopes_supported) ? body.scopes_supported : []);
  const unsupported = XAI_OAUTH.scope.split(" ").filter((scope) => scopes.size && !scopes.has(scope));
  return { drifted, unsupported, grantTypes: body?.grant_types_supported ?? [] };
}
