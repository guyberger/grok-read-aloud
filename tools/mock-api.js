/**
 * Development stand-in for the xAI TTS API. It mirrors the real endpoints,
 * CORS headers and response envelope, but synthesises a placeholder tone
 * instead of speech, so the extension can be exercised end to end without
 * spending a key.
 *
 *   node tools/mock-api.js --port 8443 --cert /tmp/cert.pem --key /tmp/key.pem
 *
 * Point a browser at it by mapping the hostname, for example:
 *   --host-resolver-rules="MAP api.x.ai 127.0.0.1:8443"
 *
 * A synthesis request can be made to take as long as a real one would, so
 * time-to-first-audio means something:
 *
 *   --latency-base 400 --latency-per-char 1.5 --latency-timestamps 150
 *
 * The real API publishes no latency figures. What it does say is that
 * synthesis is per-character work and that `with_timestamps` "adds latency for
 * the post-synthesis alignment pass", so the model here is a fixed cost, a
 * per-character cost, and a surcharge for timestamps. The per-character rate is
 * the one to argue about; the shape is not.
 */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const PORT = Number(args.get("port") ?? 8443);
const SAMPLE_RATE = 24000;
const SECONDS_PER_CHAR = 0.055;

const LATENCY = {
  base: Number(args.get("latency-base") ?? 0),
  perChar: Number(args.get("latency-per-char") ?? 0),
  timestamps: Number(args.get("latency-timestamps") ?? 0),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function synthesisDelay(text, withTimestamps) {
  return (
    LATENCY.base + text.length * LATENCY.perChar + (withTimestamps ? LATENCY.timestamps : 0)
  );
}

const VOICES = [
  "eve", "ara", "rex", "carina", "orion", "luna", "iris", "altair",
].map((id) => ({ voice_id: id, name: id[0].toUpperCase() + id.slice(1), language: "en" }));

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
    "access-control-expose-headers": "*",
  };
}

/** 16-bit mono WAV whose envelope follows the text, so timing is audible. */
function renderWav(text, durationSeconds) {
  const frames = Math.max(1, Math.round(durationSeconds * SAMPLE_RATE));
  const data = Buffer.alloc(frames * 2);
  let wordIndex = 0;
  let previousWasSpace = true;

  for (let frame = 0; frame < frames; frame += 1) {
    const position = (frame / frames) * text.length;
    const char = text[Math.min(text.length - 1, Math.floor(position))] ?? " ";
    const isSpace = /\s/.test(char);
    if (isSpace !== previousWasSpace && !isSpace) wordIndex += 1;
    previousWasSpace = isSpace;

    let sample = 0;
    if (!isSpace) {
      const t = frame / SAMPLE_RATE;
      const base = 120 + (wordIndex % 5) * 18;
      const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.5 * t);
      sample =
        0.22 * envelope * (Math.sin(2 * Math.PI * base * t) + 0.4 * Math.sin(2 * Math.PI * base * 2.4 * t));
    }
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), frame * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function timestampsFor(text) {
  const graphChars = [...text];
  const graphTimes = graphChars.map((_, index) => [
    Number((index * SECONDS_PER_CHAR).toFixed(4)),
    Number(((index + 1) * SECONDS_PER_CHAR).toFixed(4)),
  ]);
  return { graph_chars: graphChars, graph_times: graphTimes };
}

/**
 * Every synthesis request this process has served, so a test can assert what
 * was actually asked for — how many requests a jump cost, which word the audio
 * starts on, and when each request arrived and was answered. Not something the
 * real API offers.
 */
const served = [];

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function handle(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(200, { ...corsHeaders(), "content-length": 0 });
    response.end();
    return;
  }

  const url = new URL(request.url, "https://api.x.ai");
  if (url.pathname === "/debug/requests") {
    send(response, 200, { requests: served });
    return;
  }

  if (!request.headers.authorization?.startsWith("Bearer ")) {
    send(response, 400, {
      code: "Client specified an invalid argument",
      error: "Incorrect API key provided. You can obtain an API key from https://console.x.ai.",
    });
    return;
  }

  if (url.pathname === "/v1/tts/voices") {
    send(response, 200, { voices: VOICES });
    return;
  }

  if (url.pathname === "/v1/tts" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      send(response, 400, { error: "Malformed JSON body." });
      return;
    }
    const text = String(body.text ?? "");
    const duration = Number((text.length * SECONDS_PER_CHAR).toFixed(3));
    const entry = {
      chars: text.length,
      head: text.slice(0, 60),
      tail: text.slice(-30),
      receivedAt: Date.now(),
    };
    served.push(entry);

    const delay = synthesisDelay(text, body.with_timestamps);
    if (delay > 0) await sleep(delay);
    entry.respondedAt = Date.now();

    console.log(
      `tts: voice=${body.voice_id} lang=${body.language} chars=${text.length} ${duration}s` +
        (delay > 0 ? ` after ${Math.round(delay)}ms` : ""),
    );
    send(response, 200, {
      audio: renderWav(text, duration).toString("base64"),
      content_type: "audio/wav",
      duration,
      ...(body.with_timestamps ? { audio_timestamps: timestampsFor(text) } : {}),
    });
    return;
  }

  send(response, 404, { error: `No such endpoint: ${url.pathname}` });
}

const certPath = args.get("cert");
const keyPath = args.get("key");
const server = certPath
  ? createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, handle)
  : createHttpServer(handle);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock xAI TTS API on ${certPath ? "https" : "http"}://127.0.0.1:${PORT}`);
});
