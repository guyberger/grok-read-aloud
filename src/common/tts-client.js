export const API_BASE = "https://api.x.ai/v1";
export const MAX_REQUEST_CHARS = 60000;

/**
 * The API accepts cross-origin calls from any origin (it answers preflights
 * with `access-control-allow-origin: *` and allows the `authorization`
 * header), so the extension talks to it directly. No proxy involved.
 */

class TtsError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "TtsError";
    this.status = status;
    this.retryable = retryable;
  }
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/**
 * A 429 is normally worth retrying, but the API also uses it to say the
 * account has nothing left to spend. Retrying that is pointless: it cannot
 * succeed until someone adds credit, and three attempts only delay telling
 * the user why nothing is happening.
 */
const EXHAUSTED = /\b(credit|credits|quota|balance|billing|spend|spending limit|payment|insufficient)\b/i;

/** The message text out of any of the shapes the API uses for errors. */
function errorDetail(body) {
  if (!body) return "";
  if (typeof body === "string") return body.trim();
  for (const value of [body.error, body.message, body.detail, body.code]) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = errorDetail(value);
      if (nested) return nested;
    }
  }
  return "";
}

async function readError(response) {
  let detail = "";
  try {
    detail = errorDetail(await response.json());
  } catch {
    detail = "";
  }
  if (response.status === 401 || response.status === 403) {
    return new TtsError(detail || "API key was rejected. Check it in the extension options.", {
      status: response.status,
    });
  }
  if (response.status === 400 && /api key/i.test(detail)) {
    return new TtsError("API key was rejected. Check it in the extension options.", { status: 400 });
  }
  if (response.status === 429) {
    // The API explains itself better than a generic label can — it names the
    // limit that was hit, and whether it resets on its own.
    return new TtsError(detail || "Rate limited by the API. Slowing down and retrying.", {
      status: 429,
      retryable: !EXHAUSTED.test(detail),
    });
  }
  if (response.status >= 500) {
    return new TtsError(detail || `API error ${response.status}.`, {
      status: response.status,
      retryable: true,
    });
  }
  return new TtsError(detail || `API error ${response.status}.`, { status: response.status });
}

export async function listVoices(apiKey) {
  const response = await fetch(`${API_BASE}/tts/voices`, { headers: authHeaders(apiKey) });
  if (!response.ok) throw await readError(response);
  const body = await response.json();
  return Array.isArray(body?.voices) ? body.voices : [];
}

/**
 * Synthesise one chunk and return the audio plus per-character timings.
 *
 * `text_normalization` stays off so `graph_chars` mirrors the submitted text
 * one-for-one, which is what keeps the alignment to on-page characters exact.
 */
export async function synthesize({
  apiKey,
  text,
  voiceId,
  language,
  signal,
  bitRate = 64000,
  sampleRate = 24000,
}) {
  if (!apiKey) throw new TtsError("No API key set. Open the extension options and paste your xAI key.");
  if (!text?.trim()) throw new TtsError("Nothing to read.");
  if (text.length > MAX_REQUEST_CHARS) {
    throw new TtsError(`Chunk of ${text.length} characters exceeds the ${MAX_REQUEST_CHARS} character limit.`);
  }

  const response = await fetch(`${API_BASE}/tts`, {
    method: "POST",
    headers: authHeaders(apiKey),
    signal,
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      language: language || "en",
      with_timestamps: true,
      text_normalization: false,
      output_format: { codec: "mp3", sample_rate: sampleRate, bit_rate: bitRate },
    }),
  });

  if (!response.ok) throw await readError(response);

  const body = await response.json();
  if (!body?.audio) throw new TtsError("API response contained no audio.");

  return {
    audio: body.audio,
    contentType: body.content_type || "audio/mpeg",
    duration: typeof body.duration === "number" ? body.duration : 0,
    graphChars: body.audio_timestamps?.graph_chars ?? null,
    graphTimes: body.audio_timestamps?.graph_times ?? null,
  };
}

export async function synthesizeWithRetry(options, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await synthesize(options);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
      const retryable = error instanceof TtsError ? error.retryable : true;
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
    }
  }
  throw lastError;
}

export { TtsError };
