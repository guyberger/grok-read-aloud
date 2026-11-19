import assert from "node:assert/strict";
import test from "node:test";
import { synthesize, synthesizeWithRetry } from "../src/common/tts-client.js";

const OPTIONS = { apiKey: "test-key", text: "Hello world.", voiceId: "eve", language: "en" };

/** Replaces `fetch` with canned responses, one per call. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
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

const original = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = original;
});

test("a 429 surfaces the message the API sent", async () => {
  stubFetch([{ status: 429, body: { error: "Rate limit reached for grok-tts: 12 requests per minute." } }]);

  await assert.rejects(synthesize(OPTIONS), (error) => {
    assert.equal(error.name, "TtsError");
    assert.equal(error.status, 429);
    assert.equal(error.message, "Rate limit reached for grok-tts: 12 requests per minute.");
    return true;
  });
});

test("a 429 the API cannot explain still reads as rate limiting", async () => {
  stubFetch([{ status: 429 }]);

  await assert.rejects(synthesize(OPTIONS), (error) => {
    assert.match(error.message, /rate limited/i);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("a plain rate limit is retried until it succeeds", async () => {
  const calls = stubFetch([
    { status: 429, body: { error: "Rate limit reached. Try again in 1s." } },
    { status: 200, body: { audio: "AAA", duration: 1 } },
  ]);

  const result = await synthesizeWithRetry(OPTIONS, { attempts: 3 });
  assert.equal(result.audio, "AAA");
  assert.equal(calls.length, 2);
});

test("an exhausted balance is not retried", async () => {
  const message =
    "Your team has either used all available credits or reached its monthly spending limit. " +
    "Please purchase more credits to continue.";
  const calls = stubFetch([{ status: 429, body: { error: message } }]);

  await assert.rejects(synthesizeWithRetry(OPTIONS, { attempts: 3 }), (error) => {
    assert.equal(error.message, message);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls.length, 1, "a spent balance must not be retried");
});

test("a spending limit is not retried either", async () => {
  const calls = stubFetch([
    { status: 429, body: { error: { message: "You have reached your monthly spending limit." } } },
  ]);

  await assert.rejects(synthesizeWithRetry(OPTIONS, { attempts: 3 }), (error) => {
    assert.equal(error.message, "You have reached your monthly spending limit.");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("a server error is still retried", async () => {
  const calls = stubFetch([
    { status: 503, body: { error: "upstream unavailable" } },
    { status: 200, body: { audio: "BBB", duration: 2 } },
  ]);

  const result = await synthesizeWithRetry(OPTIONS, { attempts: 3 });
  assert.equal(result.audio, "BBB");
  assert.equal(calls.length, 2);
});

test("every request in a read uses the same voice and speech settings", async () => {
  const calls = stubFetch([{ status: 200, body: { audio: "AAA", duration: 1, content_type: "audio/mpeg" } }]);

  await synthesize({ ...OPTIONS, text: "The pond fills slowly." });
  await synthesize({ ...OPTIONS, text: "The wheel begins to turn.", speed: 2 });

  const bodies = calls.map((call) => JSON.parse(call.init.body));
  const settingsOf = ({ text, ...settings }) => settings;
  assert.notEqual(bodies[0].text, bodies[1].text);
  assert.deepEqual(settingsOf(bodies[0]), settingsOf(bodies[1]));
  assert.equal(bodies[0].voice_id, "eve");
  assert.equal(bodies[0].language, "en");
  // A speed handed in by a caller is the page's playback rate. It must not
  // reach the API, where it would change the delivery of one chunk only.
  assert.equal(bodies[0].speed, 1);
  assert.equal(bodies[1].speed, 1);
  assert.equal(bodies[0].text_normalization, false);
  assert.equal(bodies[0].with_timestamps, true);
  assert.deepEqual(bodies[0].output_format, { codec: "mp3", sample_rate: 24000, bit_rate: 64000 });
  assert.deepEqual(bodies[1].output_format, bodies[0].output_format);
});

test("a rejected key is reported as such and never retried", async () => {
  const calls = stubFetch([{ status: 401, body: { error: "Incorrect API key provided." } }]);

  await assert.rejects(synthesizeWithRetry(OPTIONS, { attempts: 3 }), (error) => {
    assert.equal(error.message, "Incorrect API key provided.");
    return true;
  });
  assert.equal(calls.length, 1);
});
