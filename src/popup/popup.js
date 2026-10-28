/**
 * The popup paints before it knows anything.
 *
 * Everything this panel needs — stored settings, the cached voice list, the
 * reader's state — costs at least one round trip, and reaching the reader can
 * cost much more: the background worker may have to start, then inject the
 * content scripts, then wait for a page whose main thread is busy. None of
 * that may stand between the user clicking the toolbar icon and seeing a
 * panel, so `popup.html` ships a complete default state that needs no script
 * at all, nothing here is awaited before that state is on screen, and the
 * settings module is pulled in dynamically rather than widening the module
 * graph the browser must finish before the document loads.
 *
 * What the panel shows in the meantime is the last thing anyone was told about
 * this tab, read out of `storage.session` — see `common/panel-cache.js`. It
 * arrives in a millisecond or two where the reader can take a second and a
 * half, so a popup opened on a page already being read shows the read rather
 * than "Checking…" over a dead transport. The live answer replaces it either
 * way, and `#status` says which of the two is on screen.
 *
 * `tools/popup-paint.js` measures all of it, and splits what this code costs
 * from what the browser spends opening a popup window at all.
 */
const ext = globalThis.browser ?? globalThis.chrome;

/**
 * The settings module, fetched on first use rather than imported at the top.
 * A static import would put it, and everything it imports, in the graph the
 * browser has to finish before the document loads — which is the moment the
 * popup window is put on screen.
 */
let settingsModule = null;
const settingsApi = () => (settingsModule ??= import("../common/settings.js"));

let cacheModule = null;
const cacheApi = () => (cacheModule ??= import("../common/panel-cache.js"));

const el = {
  status: document.getElementById("status"),
  pageTitle: document.getElementById("page-title"),
  progressBar: document.getElementById("progress-bar"),
  chunkLabel: document.getElementById("chunk-label"),
  timeLeft: document.getElementById("time-left"),
  toggle: document.getElementById("toggle"),
  toggleLabel: document.getElementById("toggle-label"),
  previous: document.getElementById("previous"),
  next: document.getElementById("next"),
  stop: document.getElementById("stop"),
  resume: document.getElementById("resume"),
  resumeLabel: document.getElementById("resume-label"),
  startOver: document.getElementById("start-over"),
  rate: document.getElementById("rate"),
  rateValue: document.getElementById("rate-value"),
  voice: document.getElementById("voice"),
  message: document.getElementById("message"),
  auth: document.getElementById("auth"),
  authLabel: document.getElementById("auth-label"),
  signIn: document.getElementById("sign-in"),
  openOptions: document.getElementById("open-options"),
  scopeButtons: [...document.querySelectorAll("[data-scope]")],
  presets: [...document.querySelectorAll("[data-rate]")],
};

let scope = "page";
// Matches what the markup already shows, so the first render is a no-op
// rather than a flash of different text.
let current = { status: "pending" };

/**
 * Where what is on screen came from: the markup's own default, the state
 * remembered for this tab, or the reader itself. Once the reader has answered
 * nothing remembered may paint over it, however late the read arrives.
 */
let stateSource = "markup";
let authSource = "markup";

function show(state, source) {
  if (source === "cache" && stateSource === "live") return;
  stateSource = source;
  render(state);
}

const LABELS = {
  pending: { status: "Checking…", action: "Read" },
  idle: { status: "Ready", action: "Read" },
  loading: { status: "Loading", action: "Loading…" },
  playing: { status: "Playing", action: "Pause" },
  paused: { status: "Paused", action: "Resume" },
  error: { status: "Error", action: "Try again" },
};

/** Statuses with something to stop, step through or resume. */
const ACTIVE = new Set(["loading", "playing", "paused"]);

/**
 * How long there is left to listen, in the words someone would use.
 *
 * Rounded to the minute, and never to a precision the estimate does not have:
 * the reader knows the chunk in hand exactly and multiplies out the rest, so
 * "about 14 min" is the honest form of 13 minutes and 52 seconds. Under a
 * minute it stops counting down altogether — a number ticking 50, 49, 48 is
 * the part of a progress display nobody wanted.
 */
function timeLeft(seconds) {
  if (!(seconds > 0)) return "";
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `about ${hours} h ${rest} min left` : `about ${hours} h left`;
}

function renderTimeLeft() {
  const remaining = timeLeft(current.remainingSeconds);
  el.timeLeft.textContent = remaining;
  el.timeLeft.hidden = !remaining;
}

/**
 * Keep the estimate current in a panel left open.
 *
 * The reader announces its state when something happens to it — a chunk
 * boundary, a pause, a jump — not on a timer, because a message a second from
 * every reading tab is exactly the traffic that keeps a background worker from
 * ever being allowed to sleep. So the panel counts the seconds down itself,
 * from the number the reader gave it, and the next announcement puts it right.
 */
let ticking = 0;

function countDown() {
  clearInterval(ticking);
  if (current.status !== "playing" || !(current.remainingSeconds > 0)) return;
  ticking = setInterval(() => {
    current.remainingSeconds = Math.max(0, current.remainingSeconds - 1);
    renderTimeLeft();
  }, 1000);
}

function render(state) {
  current = state ?? { status: "idle" };
  const label = LABELS[current.status] ?? LABELS.idle;

  el.status.textContent = label.status;
  el.status.dataset.state = current.status;
  el.status.dataset.source = stateSource;

  // Where this page was left off, when the reader found one worth continuing
  // from. Only a whole-page read has one, and only with nothing playing is
  // there a choice to make about it.
  const left = scope === "page" && !ACTIVE.has(current.status) ? current.resume : null;
  el.resume.hidden = !left;
  if (left) el.resumeLabel.textContent = `Left off ${Math.round(left.percent * 100)}% through`;

  el.toggleLabel.textContent =
    current.status === "idle" || current.status === "error" || current.status === "pending"
      ? left
        ? "Continue page"
        : `${label.action} ${scope === "selection" ? "selection" : "page"}`
      : label.action;

  const active = ACTIVE.has(current.status);
  el.toggle.disabled = current.status === "loading";
  el.previous.disabled = !active;
  el.next.disabled = !active;
  el.stop.disabled = !active;
  el.pageTitle.textContent = current.title ?? "";
  el.progressBar.style.width = `${Math.round((current.progress ?? 0) * 100)}%`;

  if (current.chunkCount) {
    const scopeWord = current.scope === "selection" ? "selection" : "page";
    el.chunkLabel.textContent = `Part ${(current.chunkIndex ?? 0) + 1} of ${current.chunkCount} · ${scopeWord}`;
  } else {
    el.chunkLabel.textContent = "No audio loaded";
  }

  renderTimeLeft();
  countDown();

  const problem = current.status === "error" ? current.error : "";
  const missingCredential =
    current.hasCredential === false ? "Sign in with xAI, or add an API key in Settings, to start." : "";
  const text = problem || current.notice || missingCredential;
  el.message.textContent = text;
  el.message.hidden = !text;
  el.message.classList.toggle("message--notice", !problem && Boolean(current.notice));
}

/**
 * The credential row: which of the two the extension would use for the next
 * read, and a way to sign in when there is no sign-in yet.
 *
 * The flow itself belongs to the worker. This panel closes the moment the
 * approval tab takes focus, and the sign-in has to survive that.
 */
function renderAuth({ signedIn, tierDenied, hasApiKey, pending }, source = "live") {
  if (source === "cache" && authSource === "live") return;
  authSource = source;
  el.auth.dataset.source = source;
  if (pending) {
    el.auth.dataset.state = "pending";
    el.authLabel.textContent = "Waiting for xAI approval — see Settings";
    el.signIn.hidden = true;
    return;
  }
  if (signedIn && tierDenied) {
    el.auth.dataset.state = "tierDenied";
    el.authLabel.textContent = hasApiKey
      ? "xAI sign-in gated — using the API key"
      : "xAI sign-in gated — add an API key";
    el.signIn.hidden = true;
    return;
  }
  if (signedIn) {
    el.auth.dataset.state = "signedIn";
    el.authLabel.textContent = "Signed in with xAI";
    el.signIn.hidden = true;
    return;
  }
  el.auth.dataset.state = hasApiKey ? "apiKey" : "none";
  el.authLabel.textContent = hasApiKey ? "Using your xAI API key" : "No xAI credentials";
  el.signIn.hidden = false;
}

async function loadAuth() {
  try {
    const [auth, stored] = await Promise.all([
      ext.runtime.sendMessage({ type: "xaiAuthState" }),
      ext.storage.local.get("apiKey"),
    ]);
    if (!auth?.ok) return;
    renderAuth({
      signedIn: auth.status.signedIn,
      tierDenied: auth.status.tierDenied,
      hasApiKey: Boolean(stored?.apiKey),
      pending: auth.pending,
    });
  } catch {
    // Leave the row hidden rather than claim something about credentials.
  }
}

el.signIn.addEventListener("click", async () => {
  authSource = "live";
  el.signIn.disabled = true;
  el.authLabel.textContent = "Asking xAI for a sign-in code…";
  try {
    const response = await ext.runtime.sendMessage({ type: "xaiSignIn" });
    if (!response?.ok) throw new Error(response?.error || "Could not start the sign-in.");
    el.auth.dataset.state = "pending";
    el.authLabel.textContent = `Approve with code ${response.flow.userCode}`;
    el.signIn.hidden = true;
  } catch (error) {
    el.auth.dataset.state = "none";
    el.authLabel.textContent = error.message;
  } finally {
    el.signIn.disabled = false;
  }
});

function setScope(next) {
  scope = next;
  for (const button of el.scopeButtons) {
    const active = button.dataset.scope === next;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
  }
  render(current);
}

function setRateUi(rate) {
  el.rate.value = String(rate);
  el.rateValue.textContent = `${Number(rate).toFixed(2).replace(/0$/, "").replace(/\.$/, ".0")}×`;
  for (const chip of el.presets) {
    chip.classList.toggle("is-active", Number(chip.dataset.rate) === Number(rate));
  }
}

async function control(action, args = {}) {
  try {
    const response = await ext.runtime.sendMessage({ type: "control", action, args });
    if (!response?.ok) throw new Error(response?.error || "Something went wrong.");
    show(response.state, "live");
  } catch (error) {
    show({ status: "error", error: error.message, chunkCount: current.chunkCount ?? 0 }, "live");
  }
}

async function saveSettings(patch) {
  const { setSettings } = await settingsApi();
  await setSettings(patch);
}

async function loadVoices(selected) {
  const [{ FALLBACK_VOICES }, { cachedVoices }] = await Promise.all([
    settingsApi(),
    ext.storage.local.get("cachedVoices"),
  ]);

  let voices = Array.isArray(cachedVoices) && cachedVoices.length ? cachedVoices : FALLBACK_VOICES;
  if (!voices.some((voice) => voice.voice_id === selected)) {
    voices = [{ voice_id: selected, name: selected }, ...voices];
  }
  el.voice.replaceChildren(
    ...voices.map((voice) => {
      const option = document.createElement("option");
      option.value = voice.voice_id;
      option.textContent = voice.name || voice.voice_id;
      option.selected = voice.voice_id === selected;
      return option;
    }),
  );
}

el.toggle.addEventListener("click", () => control("toggle", { scope }));
// The one way to ask for the top of a page that was left part-read.
el.startOver.addEventListener("click", () => control("start", { scope: "page", from: "start" }));
el.previous.addEventListener("click", () => control("skipSentence", { delta: -1 }));
el.next.addEventListener("click", () => control("skipSentence", { delta: 1 }));
el.stop.addEventListener("click", () => control("stop"));

for (const button of el.scopeButtons) {
  button.addEventListener("click", () => setScope(button.dataset.scope));
}

el.rate.addEventListener("input", () => setRateUi(el.rate.value));
el.rate.addEventListener("change", async () => {
  const rate = Number(el.rate.value);
  await saveSettings({ rate });
  await control("setRate", { rate });
});

for (const chip of el.presets) {
  chip.addEventListener("click", async () => {
    const rate = Number(chip.dataset.rate);
    setRateUi(rate);
    await saveSettings({ rate });
    await control("setRate", { rate });
  });
}

el.voice.addEventListener("change", async () => {
  if (!el.voice.value) return;
  await saveSettings({ voiceId: el.voice.value });
  await ext.runtime.sendMessage({ type: "control", action: "settingsChanged" }).catch(() => {});
});

el.openOptions.addEventListener("click", () => {
  ext.runtime.openOptionsPage();
  window.close();
});

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "tabStateChanged") show(message.state, "live");
  if (message?.type === "xaiAuthChanged") loadAuth();
});

/**
 * The last thing anyone knew about this tab, painted into the panel if the
 * reader has not answered yet.
 *
 * Two reads, both cheap: which tab the panel is acting on, and what was
 * remembered about it. Neither touches the background worker — `tabs.query`
 * is answered by the browser itself and `storage.session` is held in memory —
 * so this lands in a millisecond or two where the reader can take a second and
 * a half. Nothing is awaited before the panel is on screen either way.
 */
async function loadRemembered() {
  try {
    const [{ readAuth, readTabState }, [tab]] = await Promise.all([
      cacheApi(),
      ext.tabs.query({ active: true, currentWindow: true }),
    ]);
    const [state, auth] = await Promise.all([readTabState(tab?.id), readAuth()]);
    if (state) {
      show(state, "cache");
      if (state.scope) setScope(state.scope);
    }
    if (auth) renderAuth(auth, "cache");
  } catch {
    // Nothing remembered, or no session storage to remember it in. The markup's
    // own default state is already on screen.
  }
}

/**
 * Reader state and stored settings are fetched side by side, and each is
 * rendered as it lands rather than waiting for the other. The reader is the
 * slow half, since reaching it can mean starting the worker and injecting the
 * content scripts.
 *
 * Nothing here is awaited before the panel exists: the document is already
 * parsed and painted from its own markup, and every call below only replaces
 * text in place when it answers.
 */
function load() {
  // Pure message passing, so starting it now costs the renderer nothing, and
  // it is much the slowest answer to come back.
  const reader = ext.runtime
    .sendMessage({ type: "getTabState" })
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Something went wrong.");
      show(response.state, "live");
      if (response.state?.scope) setScope(response.state.scope);
      return response.state;
    })
    .catch((error) => {
      show({ status: "error", error: error.message }, "live");
      return null;
    });

  // Started alongside it, and much the quicker of the two.
  loadRemembered();

  // Fetching and compiling the settings module is work for this thread, so it
  // waits until a frame has been handed over. The speed and voice controls
  // show their defaults in the meantime.
  requestAnimationFrame(() =>
    setTimeout(async () => {
      let stored = null;
      try {
        const { getSettings } = await settingsApi();
        stored = await getSettings();
        setRateUi(stored.rate);
        await loadVoices(stored.voiceId);
      } catch {
        // Leave the controls on their defaults.
      }
      // Which credential is in play does not depend on reaching the reader, so
      // it is asked for separately and shown either way.
      const credentials = loadAuth();
      // A reader we could not reach says nothing about credentials, so say it
      // here instead.
      if ((await reader) === null && stored) {
        const auth = await ext.runtime.sendMessage({ type: "xaiAuthState" }).catch(() => null);
        const signedIn = Boolean(auth?.ok && auth.status.signedIn && !auth.status.tierDenied);
        show({ ...current, hasCredential: Boolean(stored.apiKey) || signedIn }, "live");
      }
      await credentials;
    }, 0),
  );
}

// Safe to start straight away: the panel is already on screen from its own
// markup, and nothing above occupies this thread long enough to hold a frame.
load();
