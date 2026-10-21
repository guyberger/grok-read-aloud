/**
 * Which credential a request to `api.x.ai` goes out with.
 *
 * Two can be in play: an xAI sign-in (an OAuth access token) and an API key.
 * When both exist the sign-in is tried first and the key is what catches it,
 * because xAI gates OAuth access by subscription tier and answers 403 to
 * accounts it will not let through — a state no amount of signing in again
 * fixes. A 401 is the other case, and is first assumed to be a token this
 * extension let go stale, so it costs one forced refresh before it counts as a
 * rejection.
 *
 * The API-key-only path through here is the one that existed before sign-in
 * did: one call, one key, the same errors.
 */
import { getSettings } from "./settings.js";
import * as xaiAuth from "./xai-auth.js";

/** The statuses that mean "this credential", rather than "this request". */
const AUTH_STATUSES = new Set([401, 403]);

export const MESSAGES = {
  none: "No xAI credentials. Sign in with xAI or add an API key in the extension options.",
  gatedNoKey:
    "Signed in to xAI, but this account is not allowed through to the API — xAI gates it by " +
    "subscription tier. Add an API key in the extension options to carry on.",
  gatedWithKey: "xAI would not let the signed-in account through, so the API key was used instead.",
  staleWithKey: "The xAI sign-in was rejected, so the API key was used instead. Sign in again to use it.",
};

function statusOf(error) {
  const status = Number(error?.status);
  return Number.isFinite(status) ? status : 0;
}

const isAuthFailure = (error) => AUTH_STATUSES.has(statusOf(error));

/**
 * Run `attempt(token, source)` with whichever credential applies, falling back
 * from the sign-in to the API key when xAI rejects the sign-in itself.
 *
 * Resolves to `{ result, source, notice }`. `notice` is empty on the ordinary
 * paths and carries the explanation when something had to be worked around —
 * the caller passes it on so the user is told rather than left guessing why a
 * read still worked.
 */
export async function withCredential(attempt, { auth = xaiAuth, settings = null } = {}) {
  const current = settings ?? (await getSettings());
  const apiKey = String(current.apiKey || "").trim();

  if (!(await auth.hasUsableSession())) {
    if (!apiKey) {
      const status = await auth.getStatus();
      throw new Error(status.tierDenied ? MESSAGES.gatedNoKey : MESSAGES.none);
    }
    return { result: await attempt(apiKey, "apiKey"), source: "apiKey", notice: "" };
  }

  /** One go with the sign-in, including getting a token for it. */
  const viaSignIn = async (options) => {
    const result = await attempt(await auth.getAccessToken(options), "oauth");
    // Getting through clears any gate recorded earlier: the account is allowed
    // now, whatever it was before.
    await auth.clearTierDenied();
    return { result, source: "oauth", notice: "" };
  };

  let failure;
  try {
    return await viaSignIn();
  } catch (error) {
    // A 401 is usually a token that went stale between the check and the call.
    // One forced refresh settles whether it was that or a real rejection.
    if (statusOf(error) === 401) {
      try {
        return await viaSignIn({ forceRefresh: true });
      } catch (retryError) {
        failure = retryError;
      }
    } else {
      failure = error;
    }
  }

  // Something other than the credential went wrong — a 500, a bad request, an
  // abort. The API key would fare no better, so let it through as it is.
  const gated = statusOf(failure) === 403 || failure?.code === "tier_denied";
  if (!gated && !isAuthFailure(failure) && failure?.name !== "AuthError") throw failure;

  // Stop leading with a sign-in xAI has gated until a call succeeds again.
  if (gated) await auth.markTierDenied();

  if (!apiKey) throw new Error(gated ? MESSAGES.gatedNoKey : failure.message);

  return {
    result: await attempt(apiKey, "apiKey"),
    source: "apiKey",
    notice: gated ? MESSAGES.gatedWithKey : MESSAGES.staleWithKey,
  };
}
