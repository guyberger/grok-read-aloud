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
- Reads the code written into a sentence — a setting name, a flag, a file path
  — because a sentence without it says something else. Whole snippets are
  skipped by default, and there is a setting for those.
- Highlights the spoken word, tints the sentence around it, and scrolls to keep
  up — driven by the per-character timestamps the API returns, not by guesswork.
- Jumps to any word you click while it is reading, and carries on from there.
- Steps back and forward a sentence at a time, so a few words you missed take
  one key press to hear again.
- Remembers where you left off on a page, so coming back to it carries on from
  there instead of from the top — and asks for the audio from there, so the
  part you already heard is not paid for twice.
- Reads in one tab at a time: starting a read somewhere else pauses the tab that
  was reading, rather than two voices talking over each other.
- Play, pause, resume and stop from the popup or a keyboard shortcut.
- Speed control from 0.5× to 3×, applied instantly without re-synthesising.
- Splits long pages into chunks at paragraph and sentence boundaries, and
  fetches the next chunk while the current one plays, so playback does not stall
  between parts.
- Opens with one short request — a sentence or two — so it starts speaking in
  about a second, and grows the chunks from there.
- Authenticates either by signing in with your xAI account or with an API key,
  and falls back from the first to the second when xAI turns the sign-in away.

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

The `Authorization: Bearer …` header is the same either way: an API key and an
OAuth access token from a sign-in go in the same place, so nothing below the
choice between them has to know which one it was handed. That includes TTS,
which is the only thing this extension asks for.

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

The extension declares exactly two hosts — `api.x.ai` for the API and
`auth.x.ai` for the sign-in — and `npm run check` fails if a manifest ever
declares a third. `accounts.x.ai`, where a sign-in is approved, is only ever
opened in a tab, which needs no permission at all.

## Sign in

There are two ways to authenticate, and the extension works with either one.
Both end up as the same `Authorization: Bearer …` header on the same requests
to `api.x.ai`.

### Sign in with xAI

1. Open the extension's options page.
2. Click **Sign in with xAI**. A tab opens on `accounts.x.ai` with the sign-in
   already identified by a code; the options page shows the same code in case
   the page asks for it.
3. Approve it there. The options page switches to **Signed in with xAI** on its
   own — you do not have to come back to it first.
4. Pick a voice and click **Preview voice** to hear it.

**xAI gates this by subscription tier.** Signing in can succeed and the API can
still answer 403 to the token it produced; see
[Known limits](#known-limits). When that happens the extension falls back to
the API key if one is set, and says in the popup that it did.

**Sign out** removes the tokens from this browser and asks xAI to revoke the
grant.

### Use an API key instead

1. Create a key at [console.x.ai](https://console.x.ai).
2. Open the extension's options page.
3. Paste the key and click **Save key**.
4. Click **Test & load voices** — it should report how many voices are
   available, and fill the voice picker with the live list from
   `GET /v1/tts/voices`.
5. Pick a voice and click **Preview voice** to hear it.

A key on its own is the whole of how the extension authenticates, exactly as it
was before sign-in existed. Alongside a sign-in it is the fallback.

### Where the credentials live

Both the key and the OAuth tokens are written to `browser.storage.local`, which
is scoped to that browser profile. Neither is logged — `npm run check` fails if
anything in `common/xai-auth.js` or `common/credentials.js` so much as calls
`console`, which is the only reliable way to keep a token out of the worker's
devtools. The key never leaves the background worker: page-side code is handed
everything *except* it, and the status the popup and options page read has no
token in it at all. Nothing in this repository contains a credential, and
`npm run check` fails the build if anything shaped like a key or a signed JWT is
ever committed.

### Which one a request uses

| State | What a request to `api.x.ai` carries |
| --- | --- |
| Signed in, no key | The OAuth access token |
| Key, not signed in | The key, unchanged from before sign-in existed |
| Both | The OAuth token; the key catches it if xAI turns it away |
| Signed in but gated, with a key | The key, with a notice in the popup saying why |
| Signed in but gated, no key | Nothing — the popup explains the gate |
| Neither | Nothing — the popup says what is missing |

A **401** is read as a token this extension let go stale: it costs one forced
refresh and one more attempt before it counts as a rejection. A **403** is the
tier gate, which refreshing cannot lift, so it falls straight through to the
key — and the extension stops leading with the sign-in until some later request
succeeds, rather than paying for a 403 on every chunk of a long page.

## How the sign-in works

The device authorization grant, [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628),
against `auth.x.ai`. Approval happens in a browser tab rather than on a
redirect back into the extension, which is what makes it usable here: an
extension has no stable loopback port to be redirected to.

1. `POST https://auth.x.ai/oauth2/device/code` with the client id and scopes
   returns a `device_code`, a `user_code`, and the URL to approve at.
2. The worker opens that URL in a tab and polls
   `POST https://auth.x.ai/oauth2/token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
   `authorization_pending` means wait; `slow_down` means wait a second longer.
3. Approval turns the next poll into an access token and a refresh token.
4. From then on the token is refreshed five minutes before it expires.

The polling lives in the background worker, not in the page that started it:
the popup closes the moment the approval tab takes focus, and the sign-in has
to survive that. Each poll is a `fetch`, which is what keeps the worker from
being shut down mid-flow. Signing in again while one is already in flight shows
the code that flow already has rather than stranding it.

### The values, and where they came from

Every value is hard-coded from a public source rather than discovered at
runtime, so the extension declares one extra host permission instead of
trusting whatever a discovery response names.

| Value | Source |
| --- | --- |
| `https://auth.x.ai` issuer | `auth.x.ai/.well-known/openid-configuration` |
| `/oauth2/device/code`, `/oauth2/token`, `/oauth2/revoke` | the same document's `device_authorization_endpoint`, `token_endpoint`, `revocation_endpoint` |
| `urn:ietf:params:oauth:grant-type:device_code` | listed in its `grant_types_supported` |
| Scopes `openid profile email offline_access grok-cli:access api:access` | all listed in its `scopes_supported`; this exact set is what Hermes Agent's `xai-oauth` provider sends |
| No client secret | `token_endpoint_auth_methods_supported` includes `none` |
| Client id `b1a00492-073a-47ea-816f-4c329264a828` | **Hermes Agent's**, not ours — see below |

`common/xai-auth.js` has a `verifyEndpoints()` that re-checks the first five
against the live document, for when the question is whether they have drifted.

The client id is the one value that is not ours to have. xAI publishes no way
to register an OAuth client, and the device-code endpoint rejects an
unregistered one, so there is no id of our own to use yet — this is the one
[Hermes Agent](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth)
registered, which is the only published client of this flow. It means xAI sees
this extension as Hermes. It is a single named constant in `common/xai-auth.js`
and should be replaced the moment xAI offers registration.

`offline_access` is the scope that buys the refresh token and `api:access` is
the one the bearer needs to reach `api.x.ai`; losing either silently breaks a
different half of this, so `npm test` asserts both are still asked for.

## Use it

- **Popup** — click the toolbar icon, choose **Whole page** or **Selection**,
  then click the read button. The same button becomes Pause and Resume.
- **Alt+Shift+R** — start reading, or pause/resume if already reading. With text
  selected it reads the selection; otherwise it reads the page.
- **Alt+Shift+S** — stop.
- **Alt+Shift+←** / **Alt+Shift+→** — back a sentence, or on to the next one.
  The same two steps are the ◀ and ▶ buttons either side of the read button in
  the popup.
- **Click any word** while it is reading to carry on from that word. It works
  while paused too, and starts playing again from there.
- **Continue page** — when a page was left part-read, the popup says how far in
  it got and the read button continues from there. **Start over** next to it
  goes back to the top.

Pressing back part-way through a sentence reads *that* sentence again, since
that is where the words you missed are. Press it again at the start of one and
it goes to the sentence before it.

Only one tab reads at a time. Start a read in a second tab and the first one
pauses, keeping its place and saying why; resuming it takes the read back and
quietens the second.

**Stop** is the control that finishes with a page: it resets the popup to Ready
and forgets the position. Pausing, closing the tab and a failed request all keep
it — those are reads that were interrupted rather than ended.

Rebind any of these at `chrome://extensions/shortcuts`, or in Firefox under
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
| Characters per request | 1200 | The size chunks settle at; the first one or two are smaller regardless, so a read starts quickly |
| Click a word to read from there | on | Only plain clicks on the text being read |
| Read code blocks aloud | off | Whole snippets. Code inside a sentence is read either way |
| Follow the spoken word | on | Scrolls only when the word leaves a comfortable band |
| Tint the current sentence | on | |
| Highlight colour | amber | Text colour adapts for contrast automatically |

## Manual test checklist

With a credential saved and the article at `tests/fixtures/article.html` open
(or any article you like):

**Setup**
- [ ] Options page opens by itself the first time the extension is installed.
- [ ] **Test & load voices** reports a voice count and fills the picker.
- [ ] **Preview voice** plays audio and reports a duration.
- [ ] Changing the voice and reloading the options page keeps the new choice.

**Signing in with xAI** — against the real `auth.x.ai`, which the end-to-end
checks cannot do
- [ ] **Sign in with xAI** opens `accounts.x.ai` in a tab and shows a user code.
- [ ] Approving there flips the options page to **Signed in with xAI** without
      you touching it, and the popup's credential row agrees.
- [ ] Closing the options page mid-flow and reopening it shows the same code
      still waiting, and approving still completes.
- [ ] Reading a page works with no API key saved at all.
- [ ] If xAI answers 403, the popup says the account is gated rather than
      looping on a retry — and with a key saved, the read still works and the
      popup says the key was used instead.
- [ ] **Sign out** returns the options page to **Sign in with xAI**, and a read
      falls back to the key with nothing to explain.
- [ ] With both signed out and no key, the popup says what is missing.

**Reading a page**
- [ ] Clicking **Read page** starts audio in about a second.
- [ ] The first sentence or two run into the rest without a gap.
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

**Stepping a sentence**
- [ ] ▶ moves to the first word of the next sentence without a gap.
- [ ] ◀ part-way through a sentence starts that sentence again.
- [ ] ◀ at the start of a sentence goes back to the one before it.
- [ ] Both work while paused, and start playing again from the new position.
- [ ] Both buttons are greyed out with nothing being read.
- [ ] ▶ on the last sentence of the page does nothing rather than erroring.
- [ ] `Alt+Shift+←` and `Alt+Shift+→` do the same as the two buttons.

**Picking up where you left off**
- [ ] Read a few paragraphs of a long page, pause, close the tab, reopen the
      page: the popup says how far in it got and the button reads **Continue
      page**.
- [ ] Clicking it carries on from about where it stopped, not from the top.
- [ ] **Start over** reads from the top, and the offer to continue is gone.
- [ ] **Stop** clears the offer; the next read starts from the top.
- [ ] Hearing a page to the end clears it too.
- [ ] A page only a sentence or two in is not offered — it reads from the top.
- [ ] Reading a **Selection** leaves the page's own position alone.

**One read at a time**
- [ ] Start a read, open a second article in another tab and read that: the
      first tab goes quiet, and its popup says a read started in another tab.
- [ ] Resuming the first tab carries on where it paused, and the second tab
      pauses with the same explanation.
- [ ] Neither tab loses its place in the handover, and neither re-reads from
      the top.
- [ ] A read that fails on its credentials in a second tab does not silence the
      tab that is reading.

**Code on the page** — with `tests/fixtures/inline-code.html` open
- [ ] The first sentence is read as "set autoCommit to false", with the
      highlight landing on `autoCommit` itself.
- [ ] Neither the `{ "scheduleCron": … }` block nor the `rotateSecrets` line is
      read or highlighted.
- [ ] Turning **Read code blocks aloud** on and reading again speaks both, and
      the "Part *n* of *m*" count goes up.
- [ ] With the setting off, selecting the snippet alone and reading
      **Selection** reads it.
- [ ] Selecting two paragraphs with the snippet between them reads the prose
      and skips the snippet.

**Selection**
- [ ] Select two sentences, choose **Selection**, read: only the selected text is
      spoken and highlighted.
- [ ] Reading stops at the end of the selection instead of running on.
- [ ] While a selection is being read, clicking outside it does nothing.

**Clicking to jump**
- [ ] While reading, click a word further down the same paragraph: playback
      continues from that word, with no pause.
- [ ] Click a word near the end of a long article: it starts there within a
      second or two and carries on.
- [ ] Click a word behind the playhead: it goes back to it.
- [ ] Pause, then click a word: it jumps there and starts playing again.
- [ ] Click a link in the article: the link opens, and playback does not move.
- [ ] Select some text by dragging: playback does not move.
- [ ] Clicking navigation, the sidebar or the footer does nothing.
- [ ] With nothing being read, clicking the page does nothing.
- [ ] Turn **Click a word to read from there** off: clicks stop moving playback.

**Failure handling**
- [ ] With no credential at all, the popup says what is missing rather than
      failing silently.
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

There is nothing to install: the committed `package-lock.json` describes an
empty dependency tree, and exists only so that `npm ci` succeeds as a no-op
instead of failing for want of a lockfile.

`npm test` covers chunking, timestamp alignment, the API client's error
handling, content extraction, the mapping from a click to a word, a chunk and a
time, the device-code sign-in, the rule for which credential a request goes
out with, finding a remembered position again in a page that has changed under
it, the claim that keeps one tab reading at a time, and the line between code
written into a sentence and a snippet. The extraction and click tests drive a headless Chrome, because
what counts as rendered — and what is under a given pixel — is the browser's
answer, and testing it against a DOM stub would only test the stub. They skip
themselves where there is no Chrome; set `CHROME_PATH` to point at one.

```bash
node tools/popup-paint.js --runs 20           # popup paint and load timings
node tools/popup-paint.js --runs 10 --cold 1  # with the worker stopped first
```

`tools/first-audio.js` measures the wait between pressing read and hearing
something. It needs the same Chrome and mock API as the end-to-end driver — see
[Running the end-to-end check](#running-the-end-to-end-check) — with the mock
started so that a request takes as long as a real one would:

```bash
node tools/mock-api.js --port 8443 --cert /tmp/cert.pem --key /tmp/key.pem \
  --latency-base 400 --latency-per-char 1.5 --latency-timestamps 150 &

node tools/first-audio.js --extension "$PWD/dist/chrome-test" --runs 5
```

### Layout

```
src/
  manifest.chrome.json    Chrome MV3: service_worker background
  manifest.firefox.json   Firefox MV3: background.scripts + gecko id
  common/                 Settings, the API client, the xAI sign-in and the choice between credentials
  background/             Holds the credentials, makes every network call, injects content scripts
  content/                Injected on demand; extraction, alignment, clicks, playback, highlighting, the cross-tab handoff
  popup/  options/        Extension UI
tools/                    Build, icons, static checks, mock API, end-to-end and timing drivers
tests/                    Unit tests and the fixture pages they read
```

The background worker is the only place the API key and the OAuth tokens exist.
Content scripts are injected on demand rather than declared for every URL, so
the extension never runs on a page you did not point it at.

### Picking the text to read

Only candidates the browser is actually rendering are scored. That matters on
sites that route in the client: those leave the previous page mounted and
hidden, and an index of every post holds more text than the one post on screen,
so an unfiltered score picks the stale copy and then finds nothing in it but
hidden nodes.

"Rendered" is decided by walking the ancestors and reading computed styles
rather than by `Element.checkVisibility`, which reports anything without a
layout box as invisible — including `display: contents` wrappers, whose
children render perfectly well and which component frameworks emit freely.

### Code in a page

![A documentation page being read: the spoken word is `autoCommit`, highlighted inside the code element in the middle of the sentence, while the JSON snippet below is passed over](docs/code-in-a-page.png)

`<code>` holds two different things, and reading them the same way is wrong
either way round.

A snippet is punctuation, indentation and symbols. Spoken aloud it is noise,
and it is billed by the character like everything else, so it is skipped —
which is what the extension always did.

Code written into a sentence is the opposite. `autoCommit` in *set `autoCommit`
to false before the first run* is the subject of the sentence. Dropping it
leaves "set to false", which is still a sentence, still reads fluently, and
says something else entirely. Nothing in the audio hints that a word went
missing. On a page of documentation — which is much of what this extension is
pointed at — that happened in most paragraphs.

So which one a `<code>` is gets decided by the page, not by the tag. A `<pre>`
is a snippet. Any other `<code>` is a snippet if the page lays it out as a
block and a phrase if it sits in the run of the text, which is the same
question, asked of the same computed styles, as whether an element is rendered
at all. That catches the `<code class="…">` block a site emits without a
`<pre>` around it, and it costs one style resolve per code element per read.

Two smaller rules round it off:

- **Read code blocks aloud** in the options brings the snippets back, for
  anyone who wants them. It is off by default.
- **A selection of nothing but a snippet is read regardless of that setting.**
  It is text the user picked out and pressed read on, and silence — or worse,
  falling back to reading the whole page — is not an answer to that. A
  selection that merely *contains* a snippet still skips it, like any other
  read.

### Why the popup paints before it knows anything

`popup.html` carries a complete default state, so the panel is whole on the
first paint without running a line of script. Stored settings, the cached voice
list and the reader's state are fetched afterwards and written into the panel
as each arrives. Reaching the reader is the slow part — it can mean starting
the background worker, injecting the content scripts, and waiting for a page
whose main thread is busy — and none of that is allowed between the click and
the panel. `tools/popup-paint.js` measures it.

### Highlighting without touching the page

Highlights use the CSS Custom Highlight API, which paints ranges without
inserting a single node into the page. The rules come from
`content/highlight.css`, injected with `scripting.insertCSS` so a strict page
Content-Security-Policy cannot suppress them. Where the Highlight API is
unavailable, the extension falls back to absolutely positioned overlay boxes
derived from the range's client rects — still without mutating the article.

### Time to first audio

Synthesis is per-character work, so the wait between pressing read and hearing
anything is set almost entirely by how much text the first request carries.
Everything the extension does locally — waking the worker, injecting the content
scripts, reading settings, extracting the article, cutting it into chunks —
measures **8–11 ms** together, on a page the content scripts have not been
injected into yet. There was never anything to win there.

So the first request is small: at most `FIRST_CHUNK_CHARS` (240) characters,
cut at a sentence boundary like any other chunk, which on real prose lands on
one or two sentences. From there each chunk doubles until it reaches the
**Characters per request** setting — 240, 480, 960, 1200 — so the opening is
quick and the body of the read still arrives in the large, smooth-sounding
pieces that setting asks for. The ramp restarts at every forced chunk boundary,
which means [jumping to a clicked word](#jumping-to-a-clicked-word) into text
that has not been fetched starts quickly for the same reason.

Two other things keep that opening from simply moving the wait to the first
join:

- The request for the chunk *after* the one being started goes out alongside
  it, rather than once it is playing. It then has the whole of the first
  chunk's synthesis time to arrive in.
- Opening the popup tells the worker a read is probably coming: it wakes, puts
  the settings in memory so the first synthesis does not wait on extension
  storage, and sends a keyless `OPTIONS` to `api.x.ai` so the first real
  request is a request rather than a TLS handshake.

`tools/first-audio.js` measures the result against the same Chrome and mock API
that the end-to-end driver uses, splitting the wait into the part before the API
sees anything, the API itself, and the part after. The API's real latency is not
published, so the mock models it as a fixed cost plus a per-character cost plus
a surcharge for `with_timestamps` — which the API documents as "adds latency for
the post-synthesis alignment pass". Measured over 4–5 runs per cell, median:

| First request | API model | Before | After |
| --- | --- | ---: | ---: |
| 1045 → 135 chars (`article.html`) | 400 ms + 1.5 ms/char + 150 ms | 2326 ms | **796 ms** |
| 1060 → 213 chars (`app-router-changelog.html`) | 400 ms + 1.5 ms/char + 150 ms | 2364 ms | **929 ms** |
| 1045 → 135 chars (`article.html`) | 400 ms + 4 ms/char + 150 ms | 4937 ms | **1132 ms** |
| 1060 → 213 chars (`app-router-changelog.html`) | 400 ms + 4 ms/char + 150 ms | 5002 ms | **1458 ms** |
| 1045 → 135 chars (`article.html`) | instant | 208 ms | 209 ms |

The last row is the point: with an API that answers instantly nothing changes,
because nothing was ever slow on this side. The win is whatever the API charges
per character, and it scales with that rate — which is why the per-character
figure is a parameter of the measurement rather than a number baked into it.

One caveat on the local half: the mock serves 24 kHz 16-bit WAV, about 48 KB per
second of speech, where the extension asks the real API for 64 kbps MP3, about
8 KB. The "response → audible" phase — moving the audio from the worker into the
page and decoding it — is therefore roughly six times pessimistic here. It fell
from 197 ms to 35 ms on the article anyway, since it scales with the same
number.

`optimize_streaming_latency` is deliberately not sent. It shrinks the first
*streamed* audio chunk at some cost to quality at chunk boundaries, and a unary
request is waited on whole, so it would buy nothing here.

### Jumping to a clicked word

A click is a pixel; playback is a time offset into one request's audio. Getting
from one to the other reuses the map extraction already built: the point becomes
a text node and offset (`caretPositionFromPoint`, falling back to
`caretRangeFromPoint`), the node and offset become an index into the extracted
string, the index snaps back to the start of its word, and the word's character
index finds the chunk holding it and, through that chunk's timestamps, the
moment it starts being spoken.

What happens next depends on what audio is already in hand.

| Where the word is | What it costs |
| --- | --- |
| In the chunk playing now | A seek. No request, no wait. |
| In a chunk already fetched — the one just left, or the one prefetched ahead | Load it and start at that word's own timestamp. No request. |
| Anywhere else | One request, for a chunk that *begins* at the clicked word. |

That last row is the interesting one, because the obvious alternative is to
fetch the chunk the word happens to fall inside and then seek within it. That
costs more on both counts that matter: the request carries the text before the
clicked word, which is billed and then skipped, and the audio takes longer to
synthesise and transfer for the same reason. So the chunk list is re-cut with a
forced boundary at the clicked word first. Cutting is greedy from the start of
each piece, so everything more than one chunk ahead of the click comes out
exactly as it would have anyway — including the chunk being played, whose audio
survives the re-cut because the cache is keyed by character range rather than by
chunk number. Jumping into the end of a 1200-character chunk therefore asks for
the tail it is about to speak, not the 1100 characters it would have thrown
away.

Requests the jump has made pointless are cancelled rather than left to land.
The page can only ask: the worker holds the key and therefore the `fetch`, so it
holds the `AbortController` too, and the page names the request it no longer
wants.

Only plain clicks on read text count. Clicks on links, buttons, inputs,
editable regions, anything with an interactive ARIA role, clicks carrying a
modifier, the second click of a double, right clicks, the click that ends a drag
and the click that leaves a selection behind are all left entirely alone — and
nothing in that path ever calls `preventDefault`, so a page that wants a click
keeps it. A click outside the text being read resolves to no character at all,
which is also what makes a selection read click only within its selection.

### Stepping a sentence at a time

Stepping is the same move as clicking a word, aimed by the text instead of by
the pointer: the step resolves to a character index, and from there it is a seek
when the sentence is inside the audio already in hand, and a chunk that *begins*
at that sentence when it is not. So everything the jump path already does —
cancelling requests the step made pointless, re-cutting so the new request
starts on the first word rather than opening with text it would skip, resuming a
paused read — applies unchanged.

Two details are worth stating:

- **The sentences come from the whole extracted text, not from the chunk being
  played.** A chunk's timeline only knows the sentences inside it, and a
  sentence that straddles a chunk join is cut in two there. Stepping over
  document-wide sentence ranges means a join is invisible to it, which is the
  point: the chunk boundaries are a billing and latency decision, and the
  listener should never meet them.
- **Back from the middle of a sentence re-reads that sentence.** Pressing back
  is how someone recovers a few words they missed, and those words are almost
  always in the sentence still being spoken — so only a sentence that has barely
  begun (under 1.5 s of audio, which is playback position rather than wall
  clock, so it holds at any speed) steps to the one before it. Pressing back
  twice therefore always reaches the previous sentence.

Stepping back over a chunk join can cost one request, for the same reason
clicking far ahead can: the audio for the text behind the playhead may already
have been dropped. Stepping within a chunk — which is most steps, since a chunk
is several sentences — costs nothing at all.

### Picking up where you left off

A long page is rarely heard in one sitting, and starting it again from the top
costs the listener their place and the account the characters a second time. So
a whole-page read writes down where its playhead is — every five seconds, at
each chunk boundary, when it is paused, when the tab goes away, and when a
request fails — and the next read of that page continues from there.

Continuing is the same move as [clicking a word](#jumping-to-a-clicked-word):
the position is a character index, a chunk boundary is forced at it, and the
first request comes back *beginning* on the word about to be spoken rather than
carrying the part of the page already heard.

**What a position is remembered by is the text, not the index.** An index is
only true of the page as it was. A comment thread that grew, an advert that
expanded, a sentence the author fixed — and the same number now points into the
middle of a different word. So a position carries the 80 characters that were
about to be spoken, and finding it again is: trust the stored index if the text
there still matches, otherwise look for those characters and take the
occurrence nearest to where they used to be. A page edited above the position
therefore resumes exactly; a page edited *at* the position falls back to the
first 40 then 24 characters of the anchor; a page with none of it left starts
from the top, which is also what happens below 16 characters of match, where a
hit says too little to trust.

| What happens | The position |
| --- | --- |
| Pause, or close the tab, or follow a link | Kept |
| A request fails part-way through | Kept, so **Try again** carries on from the chunk that failed |
| **Stop** | Forgotten — the popup is back to Ready, and the page is done with |
| **Start over** | Forgotten, then read from the top |
| The page is heard to the end | Forgotten |

Two thresholds keep the offer from being noise. A position in the first 400
characters is not offered, because the opening of a page is quicker to hear
again than to decide about, and one in the last 3% is treated as a page that
was finished. A selection read leaves no position at all: it is about text the
user picked out, which may not be selected — or even be there — next time.

The store is one key in `browser.storage.local`, holding the 40 most recently
read pages and nothing older than a month, keyed by URL with the fragment
dropped so that a footnote link and the page it jumps back from are one page.
A position is a convenience, so every read and write of it swallows its own
failures: nothing about a read should break because storage would not answer.

That store is written several times a minute, which is why both the worker and
the reader now check *what* changed in storage before reacting. Treating a
position as a settings change would have dropped the worker's warm settings
copy — the one that keeps extension storage off the path of the next
synthesis — and sent the reader on a round trip to the worker for a value that
had not changed.

### One read at a time

![Two popups side by side: the tab that was reading is paused and says a read started in another tab, while the tab that started reading is playing](docs/one-read-at-a-time.png)

Two tabs reading different pages over each other is not a feature anyone wants,
and the one nobody is listening to is still being billed by the character — so a
tab left reading behind a window you have moved on from is worse than useless.
When a read starts speaking, every other reader goes quiet.

The tabs arrange that between themselves. No tab can see another, and the
background worker cannot reliably message a tab that is not the active one —
`activeTab` is granted per gesture, and this extension asks for nothing broader
by default. What every injected content script *does* already have is the
extension's own storage area, and a listener on it. So the reader about to speak
writes its own id under one key, and every other reader hears that write and
pauses itself. A write also reaches *every* reader at once, including one left
over from a worker that has since been shut down and restarted.

Three details make it behave the way a listener would expect:

- **The claim is taken as the audio starts, not when read was pressed.** A read
  that never gets as far as a sound — no credential, a request that failed —
  silences nothing, so the tab that is working carries on.
- **The tab that spoke last keeps the read.** A read still fetching its first
  chunk is not interrupted by another tab starting, because it will claim the
  read for itself the moment it has audio. Whichever one that is, exactly one
  tab ends up speaking.
- **The other tab pauses rather than stops**, so it keeps its place and says
  why in the popup: *Paused — a read started in another tab*. Resuming it takes
  the read straight back, which silences the tab that had taken it. The
  explanation goes with the resume.

A claim is written once per handoff, not once per chunk: a reader that already
holds it writes nothing, so reading a long page is one write however many
requests it takes. Like a remembered position, a claim is a convenience — a
storage area that will not answer costs the handoff, never the read.

### Running the end-to-end check

`tools/e2e.js` drives a real Chrome over the DevTools Protocol and asserts that
the highlight walks the article in order, in time with the audio, and that
clicking a word moves playback to it — with the clicks dispatched through the
input pipeline, so the reader resolves real coordinates against real layout
rather than being handed an answer. It uses `tools/mock-api.js`, a stand-in for
the xAI API that mirrors the real endpoints, CORS headers and response envelope
but synthesises a placeholder tone — so the whole pipeline can be exercised
without spending a key. The mock also keeps a log of what it was asked to
synthesise, at `GET /debug/requests`, which is how the jump checks assert that a
jump cost one request starting on the clicked word rather than several, or one
beginning earlier.

The checks for [picking up where you left off](#picking-up-where-you-left-off)
reload the page between the two reads, so the content scripts, the chunk list
and every byte of audio are gone and the second read has nothing to go on but
what the first one wrote down.

The checks for [code in a page](#code-in-a-page) read
`tests/fixtures/inline-code.html` from top to bottom and collect every word the
highlight lands on, which is the only way to assert a negative: no word of
either snippet is ever spoken, while `autoCommit` is — and the highlight on it
really is inside the `<code>` element rather than near it.

The checks for [one read at a time](#one-read-at-a-time) open the article in a
second tab and drive both readers, which is the only way to see a handoff at
all: each assertion is about what the *other* tab did in response to this one
starting, and with the claim removed from the reader three of them fail with
both tabs reporting that they are playing.

The sign-in checks run against the same mock, which also stands in for the
OAuth server and for the approval page on `accounts.x.ai` — approval in those
checks is a real click on a real button in a real tab, not something the driver
fakes. One process answers for all three hosts because the paths do not
collide: the API under `/v1`, the OAuth server under `/oauth2` and
`/.well-known`, and the approval page at `/oauth2/device`. Its tokens are
opaque strings prefixed `mock-oauth-`, which cannot be mistaken for anything
that works against the real API, and `GET /debug/oauth` reports what it has
issued so a check can assert a refresh happened without reading a token.

```bash
# 1. one certificate for all three hostnames the mock answers as
openssl req -x509 -newkey rsa:2048 -keyout /tmp/key.pem -out /tmp/cert.pem \
  -days 2 -nodes -subj "/CN=api.x.ai" \
  -addext "subjectAltName=DNS:api.x.ai,DNS:auth.x.ai,DNS:accounts.x.ai"
SPKI=$(openssl x509 -in /tmp/cert.pem -pubkey -noout \
  | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64)

# 2. the mock API and the fixture article
node tools/mock-api.js --port 8443 --cert /tmp/cert.pem --key /tmp/key.pem &
(cd tests/fixtures && python3 -m http.server 8777 --bind 127.0.0.1) &

# 3. Chrome, with all three xAI hosts pointed at the mock. Drop --headless=new
#    to watch.
google-chrome --headless=new --window-size=1000,800 \
  --user-data-dir=/tmp/ra-profile --enable-unsafe-extension-debugging \
  --host-resolver-rules="MAP api.x.ai 127.0.0.1:8443,MAP auth.x.ai 127.0.0.1:8443,MAP accounts.x.ai 127.0.0.1:8443" \
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

- **Signing in with xAI may not get you through to the API.** xAI gates OAuth
  access to its API by subscription tier, and has been seen to answer `403 The
  caller does not have permission to execute the specified operation` to
  accounts whose in-app subscription is perfectly active
  ([Hermes Agent #26847](https://github.com/NousResearch/hermes-agent/issues/26847)).
  The sign-in itself succeeds, the tokens are real, and the API refuses them
  anyway. Nothing about this is fixable from here: signing in again changes
  nothing, which is why the extension does not suggest it. What it does instead
  is fall back to the API key when one is set, say so in the popup, and stop
  leading with the gated sign-in until a later request gets through. With no key
  set it fails with that explanation rather than a bare 403.

  So the API key is not legacy. For an account xAI gates, it is the only path
  that works, and it stays the documented one.
- **The sign-in borrows Hermes Agent's client id.** xAI publishes no client
  registration, so the extension identifies itself to `auth.x.ai` as the one
  published client of this flow. See
  [The values, and where they came from](#the-values-and-where-they-came-from).
  Practically this means the approval page names Hermes rather than Read Aloud,
  and that whatever rate limits or allowlists xAI applies per client are shared
  with every other Hermes user.
- **A sign-in in progress does not survive a browser restart.** Approval can
  take minutes, and the polling that waits for it lives in the background
  worker. Each poll is a `fetch`, which keeps Chrome from shutting an idle
  worker down, so an ordinary sign-in completes even with every extension page
  closed. A restart in the middle is the exception: the device code is still
  good at xAI, but nothing here is waiting on it any more, so the options page
  clears the stale prompt and the sign-in has to be started again.
- **Audio can need one click.** Browsers block audio that was not started by a
  gesture *on the page itself*, and clicking the toolbar popup does not count.
  When that happens the extension says so in both the page and the popup, and
  starts as soon as you click anywhere on the page. Chrome stops blocking a site
  once you have played audio there a few times. Routing playback through a
  Chrome offscreen document would remove the click on Chrome, but Firefox has no
  equivalent, so v1 keeps one shared path.
- **Readable-content detection is heuristic.** It looks for `<article>`,
  `[role=main]` and `<main>` first, then falls back to scoring text density,
  and if the winner yields almost nothing it reads the visible body instead,
  minus navigation, headers, sidebars and footers. On an unusual layout it may
  read too much or too little; selecting the text you want and reading the
  selection always works.
- **Whole code snippets are skipped by default**, on the grounds that
  punctuation and indentation rarely read well aloud. Code written into a
  sentence is always read — see [Code in a page](#code-in-a-page) — and
  **Read code blocks aloud** in the options turns the snippets on. Which of
  the two a `<code>` is comes from how the page lays it out, so a snippet in a
  `<code>` the page styles as inline is read as if it were a phrase.
- **No streaming.** Each chunk is one request that must finish before it can
  play. A short opening chunk cuts that wait to about a second (see
  [Time to first audio](#time-to-first-audio)), but it is still a wait, and it
  is still the largest thing between pressing read and hearing something.

  The API's bidirectional WebSocket endpoint (`wss://api.x.ai/v1/tts`) would
  remove it: audio comes back as `audio.delta` frames while the text is still
  being read, and — the part that decides whether it is usable here — each
  frame carries its own `audio_timestamps` and `audio_duration` when the
  connection is opened with `with_timestamps=true`. So the highlight could stay
  exactly as accurate as it is now, which is the one thing that cannot be
  traded away. It would also end chunk joins and the 60,000-character cap
  altogether.

  It is not implemented because it cannot be tested here. The protocol is
  documented precisely, but a client written to a document and checked only
  against a mock of that same document proves nothing about the real endpoint,
  and this repository has no key to check it against. Two further questions
  need answering first: whether `audio/mpeg` in MediaSource is dependable in
  both Chrome and Firefox, since a single shared playback path is the point of
  the current design, and whether WebSocket activity keeps a Firefox MV3
  background script alive the way it keeps a Chrome service worker alive. With a
  key and answers to those, this is the next change to make, and the transport
  is already behind one message in the worker.
- **Jumping far ahead can need a new request.** Clicking a word inside the audio
  already fetched is instant. Clicking well beyond it costs one synthesis
  request — the same few seconds the first chunk costs — and re-cuts the chunks
  from that word, so the "Part *n* of *m*" label in the popup renumbers. The
  same is true of stepping back over a chunk join, though a step within the
  chunk being read — most of them — costs nothing.
- **Speed above 1.5× is a playback-rate change**, not a re-synthesis. The API's
  own `speed` parameter tops out at 1.5× and would require re-fetching on every
  change, so the extension uses the audio element's rate, which preserves pitch.
  The Web Audio fallback path does *not* preserve pitch.
- **Shortcuts are tab-scoped by default.** With only `activeTab`, the keyboard
  shortcut acts on the focused tab at the moment you press it. Use **Allow on
  all sites** in the options if you want it unconditional.
- **One tab at a time.** Starting a read in a second tab pauses the first one
  rather than talking over it — see [One read at a time](#one-read-at-a-time).
  Two tabs can still be paused mid-read at once, each holding its own place.
- **Pages the browser protects** — `chrome://`, `about:`, the Web Store, other
  extensions' pages — cannot be read, and the popup says so.
- **Long pages cost real money.** Billing is per input character, and the whole
  page is sent in chunks. The API caps a single request at 60,000 characters;
  the extension stays far below that, but a very long article is still a lot of
  characters.

## License

MIT
