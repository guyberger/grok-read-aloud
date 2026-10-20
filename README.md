# Read Aloud (Grok TTS)

A personal browser extension that reads the current page — or just the text you
selected — out loud using xAI's Grok text-to-speech API, highlighting each word
as it is spoken.

![The extension reading an article: the spoken word is highlighted in solid amber and the current sentence carries a lighter tint](docs/reading.png)

One source tree builds an unpacked extension for both Chrome (Manifest V3) and
Firefox (Manifest V3). There is no backend, no build toolchain, and no runtime
dependencies — just the files in `src/` and a ~40-line copy script.

## What it does

- Reads the readable body of a page, skipping navigation, sidebars, footers,
  forms, code blocks and anything hidden with CSS.
- Reads just the current selection instead, when you ask it to.
- Highlights the spoken word, tints the sentence around it, and scrolls to keep
  up — driven by the per-character timestamps the API returns, not by guesswork.
- Play, pause, resume and stop from the popup or a keyboard shortcut.
- Speed control from 0.5× to 3×, applied instantly without re-synthesising.
- Splits long pages into chunks at paragraph and sentence boundaries, and
  fetches the next chunk while the current one plays, so playback does not stall
  between parts.

## How it talks to the API

Requests go straight from the extension's background worker to
`https://api.x.ai/v1/tts`. **No proxy or local helper is needed.** The API
answers CORS preflights from any origin, including `chrome-extension://…`:

```
$ curl -i -X OPTIONS https://api.x.ai/v1/tts \
    -H "Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,content-type"

HTTP/2 200
access-control-allow-origin: *
access-control-allow-headers: *
access-control-allow-methods: *
```

Real responses carry `access-control-allow-origin: *` as well, and the preflight
explicitly permits the `Authorization` header, so a browser will not strip it.
The extension also declares `host_permissions` for `api.x.ai`, which lets the
background worker bypass CORS entirely — so the request path works for two
independent reasons.

Each chunk is one `POST /v1/tts` with `with_timestamps: true`, which changes the
response from raw audio bytes to a JSON envelope:

```json
{
  "audio": "<base64 audio>",
  "content_type": "audio/mpeg",
  "duration": 0.92,
  "audio_timestamps": {
    "graph_chars": ["H", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d", "."],
    "graph_times": [[0.0, 0.06], [0.06, 0.12], "…"]
  }
}
```

`graph_chars` mirrors the submitted text one character at a time and
`graph_times` is the parallel array of `[start, end]` spans in seconds. The
extension sends `text_normalization: false` so that mirroring stays exact, walks
the two arrays to get a time span per character, groups characters into words,
and maps each word back to a DOM range. That is what makes the highlight land on
the right word rather than drifting.

Audio is requested as MP3 at 24 kHz / 64 kbps — the bitrate the API documents as
good for speech — which keeps each chunk small enough to pass cheaply between
the worker and the page.

## Install

Build the two unpacked extensions first:

```bash
npm run build
```

This writes `dist/chrome/` and `dist/firefox/`. Nothing is downloaded; the
script only copies `src/` and swaps in the right `manifest.json`.

### Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist/chrome` folder.
4. The options page opens automatically on first install. If it does not, click
   the extension's **Details → Extension options**.
5. Optional but convenient: click the puzzle-piece icon in the toolbar and pin
   **Read Aloud** so its icon is always visible.

### Firefox

Firefox only keeps a manually loaded extension until the browser restarts, which
is fine for personal use.

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `dist/firefox/manifest.json` (the manifest file itself, not the
   folder).
4. Open the add-on's preferences from `about:addons` to reach the options page.

Firefox 128 or newer is required, because the background script is an ES module.

In Firefox, host permissions declared in a Manifest V3 extension are not granted
at install time. The options page has a **Grant access to api.x.ai** button that
asks for it in one click; you can also enable it from `about:addons` →
**Read Aloud** → **Permissions**. Requests generally work even without it,
because the API allows cross-origin calls, but granting it is the reliable path.

## Set your API key

1. Create a key at [console.x.ai](https://console.x.ai).
2. Open the extension's options page.
3. Paste the key and click **Save key**.
4. Click **Test & load voices** — it should report how many voices are
   available, and fill the voice picker with the live list from
   `GET /v1/tts/voices`.
5. Pick a voice and click **Preview voice** to hear it.

The key is written to `browser.storage.local`, which is scoped to that browser
profile. It is sent only to `api.x.ai`, is never logged, and never leaves the
background worker — the page-side code is handed everything *except* the key.
Nothing in this repository contains a key, and `npm run check` fails the build if
anything that looks like one is ever committed.

## Use it

- **Popup** — click the toolbar icon, choose **Whole page** or **Selection**,
  then click the read button. The same button becomes Pause and Resume.
- **Alt+Shift+R** — start reading, or pause/resume if already reading. With text
  selected it reads the selection; otherwise it reads the page.
- **Alt+Shift+S** — stop.

Rebind either shortcut at `chrome://extensions/shortcuts`, or in Firefox under
`about:addons` → the gear menu → **Manage Extension Shortcuts**.

By default the extension can only touch a page at the moment you invoke it, via
`activeTab`. That means the keyboard shortcut works, but only on the tab that is
focused when you press it. If you would rather it be able to act on any page
without that handshake, the options page has an **Allow on all sites** button
that requests the broader permission; **Revoke** takes it back.

### Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Voice | `eve` | Live list from the API, with a built-in fallback list |
| Language | `en` | 20 languages plus `auto` detection |
| Default speed | 1.0× | Applied to the audio element, so pitch is preserved |
| Characters per request | 1200 | Lower starts sooner, higher sounds smoother across joins |
| Follow the spoken word | on | Scrolls only when the word leaves a comfortable band |
| Tint the current sentence | on | |
| Highlight colour | amber | Text colour adapts for contrast automatically |

## Manual test checklist

With a key saved and the article at `tests/fixtures/article.html` open (or any
article you like):

**Setup**
- [ ] Options page opens by itself the first time the extension is installed.
- [ ] **Test & load voices** reports a voice count and fills the picker.
- [ ] **Preview voice** plays audio and reports a duration.
- [ ] Changing the voice and reloading the options page keeps the new choice.

**Reading a page**
- [ ] Clicking **Read page** starts audio within a few seconds.
- [ ] Exactly one word is highlighted at a time, and it matches what you hear.
- [ ] The sentence around the spoken word carries a lighter tint.
- [ ] The page scrolls to follow the highlight, without fighting you when you
      scroll manually.
- [ ] Navigation, sidebar and footer text is never read or highlighted.
- [ ] Hidden (`display: none`) text is never read.
- [ ] Audio continues smoothly across a chunk boundary — watch the "Part *n* of
      *m*" label in the popup tick over without a long gap.

**Transport**
- [ ] **Pause** stops the audio and freezes the highlight.
- [ ] Resuming continues from the same word.
- [ ] **Stop** clears the highlight completely and resets the popup to Ready.
- [ ] Moving the speed slider changes the pace immediately, mid-sentence.
- [ ] `Alt+Shift+R` and `Alt+Shift+S` do the same as the popup buttons.

**Selection**
- [ ] Select two sentences, choose **Selection**, read: only the selected text is
      spoken and highlighted.
- [ ] Reading stops at the end of the selection instead of running on.

**Failure handling**
- [ ] With no key saved, the popup says to add one rather than failing silently.
- [ ] With a deliberately wrong key, the popup shows that the key was rejected.
- [ ] On a page you have not clicked yet, if audio is blocked, both the page and
      the popup say to click the page once — and clicking it starts playback.
- [ ] On `chrome://extensions` or another internal page, the popup explains that
      the page cannot be read instead of appearing to hang.

## Development

```bash
npm run build     # write dist/chrome, dist/firefox and dist/chrome-test
npm run check     # parse every script, validate manifests, scan for secrets
npm test          # unit tests for chunking and timestamp alignment
npm run verify    # all three
npm run icons     # regenerate the PNG icons from tools/make-icons.js
```

### Layout

```
src/
  manifest.chrome.json    Chrome MV3: service_worker background
  manifest.firefox.json   Firefox MV3: background.scripts + gecko id
  common/                 Settings and the API client (ES modules)
  background/             Holds the key, makes every network call, injects content scripts
  content/                Injected on demand; extraction, alignment, playback, highlighting
  popup/  options/        Extension UI
tools/                    Build, icons, static checks, mock API, end-to-end driver
tests/                    Unit tests and a fixture article
```

The background worker is the only place the API key exists. Content scripts are
injected on demand rather than declared for every URL, so the extension never
runs on a page you did not point it at.

### Highlighting without touching the page

Highlights use the CSS Custom Highlight API, which paints ranges without
inserting a single node into the page. The rules come from
`content/highlight.css`, injected with `scripting.insertCSS` so a strict page
Content-Security-Policy cannot suppress them. Where the Highlight API is
unavailable, the extension falls back to absolutely positioned overlay boxes
derived from the range's client rects — still without mutating the article.

### Running the end-to-end check

`tools/e2e.js` drives a real Chrome over the DevTools Protocol and asserts that
the highlight walks the article in order, in time with the audio. It uses
`tools/mock-api.js`, a stand-in for the xAI API that mirrors the real endpoints,
CORS headers and response envelope but synthesises a placeholder tone — so the
whole pipeline can be exercised without spending a key.

```bash
# 1. a certificate the mock can serve as api.x.ai
openssl req -x509 -newkey rsa:2048 -keyout /tmp/key.pem -out /tmp/cert.pem \
  -days 2 -nodes -subj "/CN=api.x.ai" -addext "subjectAltName=DNS:api.x.ai"
SPKI=$(openssl x509 -in /tmp/cert.pem -pubkey -noout \
  | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64)

# 2. the mock API and the fixture article
node tools/mock-api.js --port 8443 --cert /tmp/cert.pem --key /tmp/key.pem &
(cd tests/fixtures && python3 -m http.server 8777 --bind 127.0.0.1) &

# 3. Chrome, with api.x.ai pointed at the mock
google-chrome --user-data-dir=/tmp/ra-profile --enable-unsafe-extension-debugging \
  --host-resolver-rules="MAP api.x.ai 127.0.0.1:8443" \
  --ignore-certificate-errors-spki-list="$SPKI" \
  --remote-debugging-port=9333 --autoplay-policy=no-user-gesture-required \
  http://127.0.0.1:8777/article.html &

# 4. the checks
npm run build && node tools/e2e.js --extension "$PWD/dist/chrome-test"
```

The driver loads `dist/chrome-test`, which is the Chrome build with `<all_urls>`
held outright. That is only so the driver can work: `activeTab` is granted by a
real user gesture, which the DevTools Protocol cannot produce. Everything else
about the build is identical, and the `activeTab` path is covered by the manual
checklist above.

Recent Chrome removed the `--load-extension` command-line switch, which is why
the driver loads the extension over the protocol instead.

## Known limits

- **Audio can need one click.** Browsers block audio that was not started by a
  gesture *on the page itself*, and clicking the toolbar popup does not count.
  When that happens the extension says so in both the page and the popup, and
  starts as soon as you click anywhere on the page. Chrome stops blocking a site
  once you have played audio there a few times. Routing playback through a
  Chrome offscreen document would remove the click on Chrome, but Firefox has no
  equivalent, so v1 keeps one shared path.
- **Readable-content detection is heuristic.** It looks for `<article>`,
  `[role=main]` and `<main>` first, then falls back to scoring text density. On
  an unusual layout it may read too much or too little; selecting the text you
  want and reading the selection always works.
- **Code blocks are skipped** (`<pre>` and `<code>`), on the grounds that they
  rarely read well aloud. There is no setting for this yet.
- **No streaming.** Each chunk is one request that must finish before it can
  play, so the first chunk has a few seconds of latency. The API also offers a
  WebSocket endpoint that streams audio as it is generated; that would cut the
  initial wait and is the obvious next step.
- **Speed above 1.5× is a playback-rate change**, not a re-synthesis. The API's
  own `speed` parameter tops out at 1.5× and would require re-fetching on every
  change, so the extension uses the audio element's rate, which preserves pitch.
  The Web Audio fallback path does *not* preserve pitch.
- **Shortcuts are tab-scoped by default.** With only `activeTab`, the keyboard
  shortcut acts on the focused tab at the moment you press it. Use **Allow on
  all sites** in the options if you want it unconditional.
- **One tab at a time, by design.** Each tab keeps its own reader, but nothing
  stops two tabs reading at once if you start both.
- **Pages the browser protects** — `chrome://`, `about:`, the Web Store, other
  extensions' pages — cannot be read, and the popup says so.
- **Long pages cost real money.** Billing is per input character, and the whole
  page is sent in chunks. The API caps a single request at 60,000 characters;
  the extension stays far below that, but a very long article is still a lot of
  characters.

## License

MIT
