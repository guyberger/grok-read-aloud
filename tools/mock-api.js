/**
 * Development stand-in for the xAI TTS API and the OAuth server behind
 * "Sign in with xAI". It mirrors the real endpoints, CORS headers and response
 * envelope, but synthesises a placeholder tone instead of speech and issues
 * tokens that mean nothing anywhere else — so the extension can be exercised
 * end to end without spending a key or touching a real account.
 *
 *   node tools/mock-api.js --port 8443 --cert /tmp/cert.pem --key /tmp/key.pem
 *
 * Point a browser at it by mapping the hostnames, for example:
 *   --host-resolver-rules="MAP api.x.ai 127.0.0.1:8443,MAP auth.x.ai 127.0.0.1:8443,MAP accounts.x.ai 127.0.0.1:8443"
 *
 * It also stands in for `docs.google.com`, serving one Google Doc: a page whose
 * text is painted onto a canvas the way the real editor paints it, and the
 * `export?format=txt` endpoint the extension reads that text from.
 *
 *   --host-resolver-rules="…,MAP docs.google.com 127.0.0.1:8443"
 *
 * One process answers for all four because the paths do not collide: the TTS
 * API lives under /v1, the OAuth server under /oauth2 and /.well-known, the
 * approval page the user sees is the one HTML page at /oauth2/device, and the
 * document is under /document.
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

/**
 * How long an issued access token claims to live. Short on purpose: a test
 * that wants to see a refresh happen can ask for a token that is nearly spent
 * rather than waiting an hour for a real one.
 */
const TOKEN_TTL_SECONDS = Number(args.get("token-ttl") ?? 3600);
/** Approvals needed before the device-code poll stops saying `authorization_pending`. */
const AUTO_APPROVE = args.get("auto-approve") === "1";

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

/* ---------------------------------------------------------------- OAuth --- */

/**
 * The OAuth server's whole state: the device codes handed out and not yet
 * resolved, and the tokens issued from the ones that were approved.
 *
 * Tokens are opaque strings with a recognisable prefix rather than JWTs. The
 * extension reads `expires_in` from the response and only falls back to a JWT's
 * `exp`, so nothing here needs signing — and an opaque string cannot be
 * mistaken for a credential that works somewhere real.
 */
const oauth = {
  devices: new Map(), // device_code -> { userCode, approved, denied, slowDownsLeft, expiresAt }
  access: new Map(), // access token -> { refreshToken, issuedAt }
  refresh: new Map(), // refresh token -> { live, generation }
  issued: 0,
  /** Flipped by /debug/oauth/gate to reproduce xAI's subscription-tier 403. */
  gated: false,
  /** Every token request served, so a test can count refreshes. */
  log: [],
};

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const VERIFICATION_URI = "https://accounts.x.ai/oauth2/device";

function issueTokens(previousRefresh = "") {
  oauth.issued += 1;
  const accessToken = `mock-oauth-access-${oauth.issued}`;
  const refreshToken = `mock-oauth-refresh-${oauth.issued}`;
  // A refresh token is single use, as xAI's is: the old one dies with the
  // exchange, so a client that keeps replaying it gets `invalid_grant`.
  if (previousRefresh) oauth.refresh.delete(previousRefresh);
  oauth.refresh.set(refreshToken, { live: true, generation: oauth.issued });
  oauth.access.set(accessToken, { refreshToken, issuedAt: Date.now() });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    scope: "openid profile email offline_access grok-cli:access api:access",
  };
}

const isOAuthToken = (token) => oauth.access.has(token) || token.startsWith("mock-oauth-access-");

/** RFC 8414 discovery, so a client can check its hard-coded endpoints. */
const DISCOVERY = {
  issuer: "https://auth.x.ai",
  authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  token_endpoint: "https://auth.x.ai/oauth2/token",
  revocation_endpoint: "https://auth.x.ai/oauth2/revoke",
  grant_types_supported: ["authorization_code", "refresh_token", DEVICE_CODE_GRANT],
  scopes_supported: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
};

/** The page the user lands on, standing in for xAI's approval screen. */
function approvalPage(userCode) {
  const code = String(userCode ?? "").replace(/[^A-Za-z0-9-]/g, "");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize — mock accounts.x.ai</title></head>
<body style="font:16px system-ui;max-width:28rem;margin:4rem auto">
  <h1>Authorize Read Aloud</h1>
  <p>Mock approval page. Code: <code id="code">${code || "none"}</code></p>
  <form method="POST" action="/oauth2/device/approve">
    <input type="hidden" name="user_code" value="${code}" />
    <button id="approve" type="submit" style="font:inherit;padding:.6rem 1.2rem">Approve</button>
  </form>
</body></html>`;
}

function approveUserCode(userCode) {
  for (const entry of oauth.devices.values()) {
    if (entry.userCode === userCode) {
      entry.approved = true;
      return true;
    }
  }
  return false;
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(),
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    ...corsHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  response.end(html);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const formOf = (body) => Object.fromEntries(new URLSearchParams(body));

/**
 * The OAuth server. Returns true when it answered, so the TTS handler below
 * only sees what is left — including the bearer check, which an OAuth request
 * must not be subject to.
 */
async function handleOAuth(request, response, url) {
  if (url.pathname === "/.well-known/openid-configuration") {
    send(response, 200, DISCOVERY);
    return true;
  }

  if (url.pathname === "/oauth2/device/code" && request.method === "POST") {
    const form = formOf(await readBody(request));
    if (!form.client_id) {
      send(response, 400, { error: "invalid_request", error_description: "client_id is required." });
      return true;
    }
    const deviceCode = `mock-device-${oauth.devices.size + 1}-${Date.now().toString(36)}`;
    const userCode = `MOCK-${String(oauth.devices.size + 1).padStart(4, "0")}`;
    oauth.devices.set(deviceCode, {
      userCode,
      approved: AUTO_APPROVE,
      denied: false,
      // The first poll gets one `slow_down`, so the client's handling of it is
      // on the normal path rather than something only a unit test ever sees.
      slowDownsLeft: 1,
      expiresAt: Date.now() + 1800_000,
    });
    console.log(`oauth: device code issued, user_code=${userCode}`);
    send(response, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: VERIFICATION_URI,
      verification_uri_complete: `${VERIFICATION_URI}?user_code=${userCode}`,
      expires_in: 1800,
      interval: 1,
    });
    return true;
  }

  // The approval screen, and the button on it. xAI's equivalent is a sign-in
  // page; all a test needs from it is that approving is something a user does
  // in a browser rather than something the driver fakes.
  if (url.pathname === "/oauth2/device" && request.method === "GET") {
    sendHtml(response, 200, approvalPage(url.searchParams.get("user_code")));
    return true;
  }
  if (url.pathname === "/oauth2/device/approve" && request.method === "POST") {
    const form = formOf(await readBody(request));
    const approved = approveUserCode(String(form.user_code ?? ""));
    console.log(`oauth: approval for ${form.user_code} ${approved ? "recorded" : "matched nothing"}`);
    sendHtml(response, approved ? 200 : 404, `<!DOCTYPE html><p>${approved ? "Approved." : "Unknown code."}</p>`);
    return true;
  }

  if (url.pathname === "/oauth2/token" && request.method === "POST") {
    const form = formOf(await readBody(request));
    oauth.log.push({ grantType: form.grant_type, at: Date.now() });

    // The tier gate xAI applies to OAuth accounts it will not let through.
    // It answers the token endpoint as well as the API, which is what makes it
    // distinguishable from an expired token.
    if (oauth.gated && form.grant_type === "refresh_token") {
      send(response, 403, {
        error: "access_denied",
        error_description: "The caller does not have permission to execute the specified operation.",
      });
      return true;
    }

    if (form.grant_type === DEVICE_CODE_GRANT) {
      const entry = oauth.devices.get(String(form.device_code ?? ""));
      if (!entry || Date.now() > entry.expiresAt) {
        send(response, 400, { error: "expired_token", error_description: "The device code has expired." });
        return true;
      }
      if (entry.denied) {
        send(response, 400, { error: "access_denied", error_description: "The sign-in was declined." });
        return true;
      }
      if (!entry.approved) {
        if (entry.slowDownsLeft > 0) {
          entry.slowDownsLeft -= 1;
          send(response, 400, { error: "slow_down", error_description: "Polling too fast." });
          return true;
        }
        send(response, 400, { error: "authorization_pending", error_description: "Waiting for approval." });
        return true;
      }
      oauth.devices.delete(String(form.device_code));
      console.log(`oauth: device code redeemed for ${entry.userCode}`);
      send(response, 200, issueTokens());
      return true;
    }

    if (form.grant_type === "refresh_token") {
      const presented = String(form.refresh_token ?? "");
      const known = oauth.refresh.get(presented);
      if (!known?.live) {
        send(response, 400, {
          error: "invalid_grant",
          error_description: "The refresh token is unknown, spent or revoked.",
        });
        return true;
      }
      console.log("oauth: refresh token exchanged");
      send(response, 200, issueTokens(presented));
      return true;
    }

    send(response, 400, { error: "unsupported_grant_type", error_description: String(form.grant_type ?? "") });
    return true;
  }

  if (url.pathname === "/oauth2/revoke" && request.method === "POST") {
    const form = formOf(await readBody(request));
    oauth.refresh.delete(String(form.token ?? ""));
    console.log("oauth: grant revoked");
    send(response, 200, {});
    return true;
  }

  // Test controls. The real server has nothing like these.
  if (url.pathname === "/debug/oauth" && request.method === "GET") {
    send(response, 200, {
      gated: oauth.gated,
      issued: oauth.issued,
      pendingDevices: [...oauth.devices.values()].map((entry) => entry.userCode),
      liveRefreshTokens: [...oauth.refresh.values()].filter((entry) => entry.live).length,
      tokenRequests: oauth.log,
    });
    return true;
  }
  if (url.pathname === "/debug/oauth/gate" && request.method === "POST") {
    oauth.gated = new URL(request.url, "https://auth.x.ai").searchParams.get("on") !== "0";
    console.log(`oauth: tier gate ${oauth.gated ? "on" : "off"}`);
    send(response, 200, { gated: oauth.gated });
    return true;
  }
  if (url.pathname === "/debug/oauth/approve" && request.method === "POST") {
    const code = url.searchParams.get("user_code");
    let approved = false;
    if (code) {
      approved = approveUserCode(code);
    } else {
      for (const entry of oauth.devices.values()) {
        entry.approved = true;
        approved = true;
      }
    }
    send(response, 200, { approved });
    return true;
  }

  return false;
}

/* ----------------------------------------------------------- Google Docs --- */

/**
 * A stand-in for a Google Doc, because the thing that makes Docs hard is not
 * something a fixture file can have: the document is painted onto a canvas, so
 * the only text in the page is the menus around it. This serves the same
 * shape — chrome in the DOM, a canvas where the words should be, an
 * accessibility layer over the part of it that is "on screen", and the
 * `export?format=txt` endpoint that File → Download → Plain text uses.
 *
 * Point a browser at it with `MAP docs.google.com 127.0.0.1:8443`.
 */
const DOC_ID = "1mockTideMillDocumentForEndToEndChecks";
const DOC_TITLE = "Keeping a tide mill in repair";

const DOC_PARAGRAPHS = [
  "The mill at Blackwater has run on the tide for four hundred years, and every part of it that still moves is made of wood. Twice a day the pond fills through the sluice and empties again through the wheel, so the frame is wet while it is working and drying while it is idle.",
  "A wheel left dry for a whole season opens at its joints, and a wheel that is never dry goes soft at the heart. Choosing between the two, morning after morning, is the whole of the keeper's art.",
  "Nothing in the frame is glued. Every joint is pegged, and every peg can be driven out with a mallet and a patient hour, which is why a mill of this age is mostly made of replacements.",
  "When a bucket splits, the wheelwright cuts a new one from elm that has lain under water since the spring. Elm kept wet is elm that will not shrink, and a bucket that shrinks will rattle itself to pieces within a winter.",
  "The ironwork is simpler and less forgiving. A gudgeon that has worn oval cannot be packed out; it has to be drawn, heated, upset and set true again, and until then the wheel must not be allowed to turn under load.",
  "The ledger in the office goes back to 1761, and nearly every page of it is somebody saying the same thing in different handwriting: grease the bearings, clear the sluice, watch the pegs, and never let a spring tide find a loose brake.",
  "What the ledger leaves out, because everyone who wrote in it already knew, is that none of this is restoration. The mill was never finished and never will be. Each keeper mends what the last one could not reach, and the mill is handed on in better repair than it was found.",
];

/**
 * How many paragraphs the accessibility layer covers. Docs only annotates the
 * tiles it has drawn, so a long document is partly annotated at best — which
 * is exactly why the export is tried first.
 */
const ANNOTATED_PARAGRAPHS = 2;

/** The document as it reads once an extension has tidied the export up. */
const docText = () => [DOC_TITLE, ...DOC_PARAGRAPHS].join("\n\n");

/** The part of it the accessibility layer covers: the tiles Docs has drawn. */
const annotatedDocText = () => DOC_PARAGRAPHS.slice(0, ANNOTATED_PARAGRAPHS).join("\n");

/** The plain-text export: the title, then the body, with CRLF and a BOM. */
const exportText = () => `\uFEFF${docText().replace(/\n/g, "\r\n")}\r\n`;

const docs = {
  /** Flipped by /debug/docs/export to stand in for a doc the session cannot see. */
  exportAllowed: true,
  exports: 0,
  pages: 0,
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

/**
 * The accessibility layer: one `<rect aria-label="…">` per line of text, the
 * way Docs annotates the canvas for assistive technology. The labels carry the
 * words; nothing in the layer is a text node.
 */
function annotationLayer() {
  const tiles = DOC_PARAGRAPHS.slice(0, ANNOTATED_PARAGRAPHS).map((paragraph, index) => {
    const lines = paragraph.match(/.{1,90}(\s|$)/g) ?? [paragraph];
    const rects = lines
      .map(
        (line, row) =>
          `<rect role="img" aria-label="${escapeHtml(line.trim())}" x="72" y="${
            96 + row * 24
          }" width="672" height="20" fill="none"></rect>`,
      )
      .join("");
    return `<g role="paragraph" aria-level="0">${rects}</g>`;
  });
  return `<svg class="kix-canvas-tile-content" width="816" height="1056" aria-hidden="false">${tiles.join(
    "",
  )}</svg>`;
}

/** The lines of the document as real text, the way the old renderer drew it. */
function domLines() {
  return [DOC_TITLE, ...DOC_PARAGRAPHS]
    .map((paragraph) => `<div class="kix-lineview"><span class="kix-wordhtmlgenerator-word-node">${escapeHtml(
      paragraph,
    )}</span></div>`)
    .join("");
}

/**
 * The editor page. `render=dom` serves the old renderer, whose text really is
 * in the page; `annotated=0` takes the accessibility layer away, leaving a
 * canvas with nothing readable near it at all.
 */
function docPage({ render = "canvas", annotated = true } = {}) {
  const body =
    render === "dom"
      ? `<div class="kix-page">${domLines()}</div>`
      : `<div class="kix-page"><canvas width="816" height="1056"></canvas>${
          annotated ? annotationLayer() : ""
        }</div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(DOC_TITLE)} - Google Docs</title>
<style>
  body { font: 14px system-ui; margin: 0; background: #f9fbfd; }
  .docs-chrome { padding: 8px 16px; background: #fff; border-bottom: 1px solid #dadce0; }
  .docs-title { font-size: 18px; }
  .docs-menubar span { margin-right: 12px; }
  .kix-appview-editor { padding: 40px; display: flex; justify-content: center; }
  .kix-page { position: relative; width: 816px; background: #fff; box-shadow: 0 0 4px rgba(0,0,0,.2); }
  .kix-page svg { position: absolute; inset: 0; }
  .kix-lineview { padding: 0 72px; line-height: 1.6; }
</style></head>
<body>
  <header class="docs-chrome">
    <div class="docs-title">${escapeHtml(DOC_TITLE)}</div>
    <nav class="docs-menubar">
      <span>File</span><span>Edit</span><span>View</span><span>Insert</span><span>Format</span>
      <span>Tools</span><span>Extensions</span><span>Help</span>
    </nav>
    <div class="docs-sharebar"><button>Share</button><span>Last edit was seconds ago</span></div>
  </header>
  <div class="kix-appview-editor" role="region" aria-label="Document content">${body}</div>
</body></html>`;
}

/**
 * The Docs surface. Returns true when it answered, like the OAuth handler:
 * none of it is subject to the bearer check below.
 */
function handleDocs(request, response, url) {
  const match = /^\/document\/(?:u\/\d+\/)?d\/([^/]+)\/(edit|export)$/.exec(url.pathname);
  if (!match) {
    if (url.pathname === "/debug/docs" && request.method === "GET") {
      send(response, 200, {
        ...docs,
        id: DOC_ID,
        // What the whole document is worth, and what the part the
        // accessibility layer covers is worth, so a check can tell which of
        // the two was read without reading it back character by character.
        chars: docText().length,
        annotatedChars: annotatedDocText().length,
      });
      return true;
    }
    if (url.pathname === "/debug/docs/export" && request.method === "POST") {
      docs.exportAllowed = url.searchParams.get("on") !== "0";
      console.log(`docs: export ${docs.exportAllowed ? "allowed" : "refused"}`);
      send(response, 200, { exportAllowed: docs.exportAllowed });
      return true;
    }
    return false;
  }

  const [, , action] = match;
  if (action === "edit") {
    docs.pages += 1;
    sendHtml(
      response,
      200,
      docPage({
        render: url.searchParams.get("render") ?? "canvas",
        annotated: url.searchParams.get("annotated") !== "0",
      }),
    );
    return true;
  }

  docs.exports += 1;
  // A document the session cannot see is answered with the sign-in page, not
  // with an error — which is why the extension looks at what came back.
  if (!docs.exportAllowed) {
    console.log("docs: export refused, serving the sign-in page");
    sendHtml(response, 200, "<!DOCTYPE html><html><body><h1>Sign in</h1><p>to continue to Google Docs</p></body></html>");
    return true;
  }
  const text = exportText();
  console.log(`docs: exported ${text.length} characters as ${url.searchParams.get("format")}`);
  response.writeHead(200, {
    ...corsHeaders(),
    "content-type": "text/plain; charset=UTF-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
  return true;
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

  if (await handleOAuth(request, response, url)) return;
  if (handleDocs(request, response, url)) return;

  if (!request.headers.authorization?.startsWith("Bearer ")) {
    send(response, 400, {
      code: "Client specified an invalid argument",
      error: "Incorrect API key provided. You can obtain an API key from https://console.x.ai.",
    });
    return;
  }

  // Tier gating: an OAuth bearer from a gated account is refused, while the
  // same account's API key sails through. That asymmetry is the whole of what
  // the fallback has to cope with, so it is the whole of what this mocks.
  const bearer = request.headers.authorization.slice("Bearer ".length).trim();
  if (oauth.gated && isOAuthToken(bearer)) {
    console.log("tts: refused a gated OAuth bearer (403)");
    send(response, 403, {
      code: "Permission denied",
      error: "The caller does not have permission to execute the specified operation.",
    });
    return;
  }

  // A token this server never issued, or one spent by a later refresh, is a
  // 401 — the case where the right answer is to refresh and try once more.
  if (bearer.startsWith("mock-oauth-access-") && !oauth.access.has(bearer)) {
    console.log("tts: refused a stale OAuth bearer (401)");
    send(response, 401, { code: "Unauthenticated", error: "The access token is expired or revoked." });
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
      // Which voice it was asked in, so a test can tell audio that had to be
      // fetched again from audio that was merely replayed.
      voiceId: String(body.voice_id ?? ""),
      // Which credential carried it, so a test can assert the fallback
      // actually fell back rather than merely not erroring.
      auth: isOAuthToken(bearer) ? "oauth" : "apiKey",
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
  const scheme = certPath ? "https" : "http";
  console.log(`mock xAI TTS API and OAuth server on ${scheme}://127.0.0.1:${PORT}`);
  console.log(`  tokens live ${TOKEN_TTL_SECONDS}s${AUTO_APPROVE ? ", device codes self-approve" : ""}`);
});
