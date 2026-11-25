/**
 * Extra fuzz pages and scenarios. Product code is not involved: these only
 * drive the packaged extension. A scenario with `bug` set is expected to
 * reproduce that bug on every repeat.
 */
const shell = (title, body, extra = "") => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
  <style>
    body { margin: 0; font: 18px/1.6 Georgia, serif; }
    nav, footer { font: 14px system-ui, sans-serif; background: #eee; padding: 12px 16px; }
    article { max-width: 680px; margin: 24px auto; padding: 0 16px 80px; }
    td, th { border: 1px solid #ccc; padding: 6px 10px; }
    ${extra}
  </style></head><body>
  <nav>Navigation: Home · Notes · Index</nav>
  ${body}
  <footer>Footer: sources and corrections.</footer>
  </body></html>`;

export const huntPages = new Map();

huntPages.set(
  "cjk.html",
  shell(
    "潮汐磨坊",
    `<article lang="zh"><h1>潮汐磨坊</h1>
     <p>这座潮汐磨坊已经依靠潮水运转了四百年，所有仍在转动的部件都是木头做的，每天两次池塘通过水闸灌满再通过水轮排空。</p>
     <p>干燥一整个季节的水轮会在接缝处张开，从未干燥的水轮则会从芯部变软，在两者之间取舍就是看守人全部的手艺。</p></article>`,
  ),
);

huntPages.set(
  "editor.html",
  shell(
    "Keeper notes",
    `<article contenteditable="true"><h1>Keeper notes</h1>
     <p>The first editable paragraph says the dawn peg was loose and was driven home before the pond filled.</p>
     <p>The second editable paragraph is about the spring tide and the brake and it never mentions the dawn peg.</p></article>`,
  ),
);

huntPages.set(
  "mixed.html",
  shell(
    "Mixed mill",
    `<article><h1>Tide mill / طاحونة</h1>
     <p>The keeper wrote الطاحونة in the ledger next to the word sluice and then walked back to the wheel.</p>
     <p dir="rtl" lang="ar">بعد ذلك عاد الحارس ليكتب wheel في الدفتر قبل أن تغلق البوابة.</p></article>`,
  ),
);

huntPages.set(
  "kitchen.html",
  shell(
    "Kitchen mill",
    `<article><h1>Morning list</h1>
     <p>The prose around the snippet says autoCommit stays in the sentence.</p>
     <pre><code>function KITCHENCODETOKEN(){ return 1; }</code></pre>
     <p>Ruby base <ruby>東京<rt>とうきょう</rt></ruby> sits in the sentence, and the reading above it does not.</p>
     <p>The pond lasts<sup class="citation">[1]</sup> through winter without the marker.</p>
     <table><tr><th>Part</th><th>Task</th></tr><tr><td>Gudgeon</td><td>Draw and set it true</td></tr></table>
     <p>After the table the keeper returns to the sluice.</p></article>
     <iframe src="/frame-body.html" style="width:800px;height:240px;border:0"></iframe>`,
  ),
);

huntPages.set(
  "select.html",
  shell(
    "Selection mill",
    `<article><h1>Two parts</h1>
     <p id="picked">The selected sluice sentence is the only one that should be spoken aloud.</p>
     <p id="rest">The unselected brake sentence must stay silent and unhighlighted for the whole read.</p></article>`,
  ),
);

// A one-page PDF whose only sentence is unique. The viewer may refuse the
// extension; the scenario only checks that refusal stays contained.
huntPages.set(
  "tiny.pdf",
  `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 68>>stream
BT /F1 18 Tf 36 90 Td (PDFMILLTOKEN holds the tide.) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`,
);

const DOC_URL = "https://docs.google.com/document/d/1mockTideMillDocumentForEndToEndChecks/edit";

export function huntScenarios(ctx) {
  const {
    SEED,
    KEY,
    PAGE_PORT,
    applySettings,
    navigate,
    control,
    probe,
    until,
    sleep,
    setTiming,
    setFault,
    resetMock,
    requests,
    article,
    save,
    screenshot,
    ui,
    activate,
    browser,
    findTarget,
    Session,
    attachConsole,
    extensionId,
    mulberry32,
    evaluate,
    refreshWorld,
    recentLogs,
  } = ctx;

  async function untilPopup(popup) {
    const deadline = Date.now() + 8000;
    let text = "";
    while (Date.now() < deadline) {
      text = await popup.evaluate(`document.getElementById("status")?.dataset.state || ""`);
      if (text === "error") return text;
      await sleep(150);
    }
    return text;
  }

  async function tabIdByUrl(part) {
    return ui.evaluate(`new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const found = (tabs || []).find((tab) => (tab.url || "").includes(${JSON.stringify(part)}));
        resolve(found ? found.id : 0);
      });
    })`);
  }

  async function controlTab(tabId, action, actionArgs = {}) {
    return ui.evaluate(
      `new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify({ type: "control", action, args: actionArgs, tabId })}, resolve))`,
    );
  }

  async function pointOf(selector, index = 0) {
    return article.evaluate(`
      (() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = el.getClientRects()[0];
        if (!rect) return null;
        return { x: rect.left + Math.min(28, Math.max(8, rect.width / 3)), y: rect.top + Math.min(rect.height / 2, 12) };
      })()
    `);
  }

  async function hover(point) {
    await activate();
    await article.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(point.x),
      y: Math.round(point.y),
      buttons: 0,
    });
  }

  async function click(point) {
    await hover(point);
    await sleep(60);
    const common = { x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 };
    await article.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
    await article.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
  }

  async function cue(point) {
    await hover(point);
    await sleep(220);
    return article.evaluate(`
      (() => {
        const under = document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)});
        return {
          marked: document.querySelectorAll("[data-read-aloud-jump]").length,
          cursor: under ? getComputedStyle(under).cursor : null,
          text: (under?.innerText || "").slice(0, 80),
        };
      })()
    `);
  }

  async function spoken() {
    return (await requests()).map((entry) => entry.text).join("\n");
  }

  async function openPopup() {
    const created = await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId()}/popup/popup.html`,
      background: true,
    });
    const info = await findTarget((target) => target.url.includes("/popup/popup.html"), "popup");
    const popup = await new Session(info.webSocketDebuggerUrl).open();
    await popup.send("Runtime.enable");
    await attachConsole(popup, "popup");
    return {
      popup,
      async close() {
        await browser.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
        popup.close();
      },
    };
  }

  return [
    {
      name: "empty-timestamps-highlight",
      bug: "Empty timestamp arrays stick the highlight on the last word of the chunk",
      async run(repeat) {
        await setFault("empty-timestamps", 6);
        await applySettings({ chunkChars: 2000, rate: 1 });
        await navigate("article.html");
        const started = await control("start", { scope: "page", from: "start" });
        if (!started?.state || started.state.status === "error") {
          return { ok: false, detail: `did not start ${JSON.stringify(started?.state || started)}` };
        }
        const playing = await until((sample) => sample.status === "playing" && sample.time > 0.35, 12000);
        const samples = [playing];
        for (let i = 0; i < 6; i += 1) {
          await sleep(180);
          samples.push(await probe());
        }
        const expected = await evaluate(`
          (() => {
            const doc = globalThis.__readAloud.extract.extract("page");
            const ranges = globalThis.__readAloud.align.chunkRanges(doc.text, 2000, { firstChars: 240 });
            const chunk = doc.text.slice(ranges[0].start, ranges[0].end).trim();
            const words = chunk.split(/\\s+/);
            return { first: words[0], last: words.at(-1), count: words.length, chunks: ranges.length };
          })()
        `);
        const words = [];
        for (const sample of samples) {
          if (sample.word && words.at(-1) !== sample.word) words.push(sample.word);
        }
        const moved = samples.some((sample) => sample.time > (playing.time || 0) + 0.25);
        const stuckOnLast = words.length === 1 && words[0] === expected.last && expected.count > 4 && moved;
        const path = save(`bug-empty-timestamps-${repeat}.json`, { expected, words, samples, moved });
        if (stuckOnLast) await screenshot(`bug-empty-timestamps-${repeat}.png`);
        return {
          ok: stuckOnLast,
          detail: stuckOnLast
            ? `highlight stayed on "${words[0]}" while audio moved, first word was "${expected.first}"`
            : `words ${words.join(" | ") || "none"}; expected last "${expected.last}" first "${expected.first}"; moved ${moved}; status ${playing.status}`,
          evidence: path,
        };
      },
    },
    {
      name: "jump-error-keeps-audio",
      async run(repeat) {
        await applySettings({ chunkChars: 320, clickToJump: true, autoScroll: false, rate: 1 });
        await navigate("huge.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.time > 0.15, 12000);
        if (playing.status !== "playing") return { ok: false, detail: `did not start ${playing.status} ${playing.error}` };
        await setFault("http-500", 9);
        const point = await pointOf("article p", 22);
        if (!point) return { ok: false, detail: "no paragraph to click" };
        const before = await probe();
        await click(point);
        const failed = await until((sample) => sample.status === "error", 15000);
        const atError = await probe();
        await sleep(700);
        const later = await probe();
        const paused = await control("pause");
        await sleep(400);
        const afterPause = await probe();
        let popupState = null;
        let popupHandle = null;
        try {
          await activate();
          popupHandle = await openPopup();
          await untilPopup(popupHandle.popup);
          popupState = await popupHandle.popup.evaluate(`({
            status: document.getElementById("status")?.textContent || "",
            state: document.getElementById("status")?.dataset.state || "",
            stopDisabled: document.getElementById("stop")?.disabled ?? null,
            toggleDisabled: document.getElementById("toggle")?.disabled ?? null,
            toggleLabel: document.getElementById("toggle-label")?.textContent || ""
          })`);
        } finally {
          await popupHandle?.close();
        }
        const media = await evaluate(`navigator.mediaSession?.playbackState ?? null`);
        const quiet = later.paused === true && later.time <= atError.time + 0.05;
        const pauseHeld = afterPause.paused !== false && afterPause.status === "error";
        const stopAvailable = popupState?.state === "error" && popupState.stopDisabled === false;
        const highlightHeld = !later.word || later.word === atError.word;
        const ok = failed.status === "error" && quiet && pauseHeld && stopAvailable && highlightHeld;
        const path = save(`bug-jump-error-audio-${repeat}.json`, {
          before: { status: before.status, time: before.time, word: before.word },
          atError: { status: atError.status, time: atError.time, word: atError.word, error: atError.error, paused: atError.paused },
          later: { status: later.status, time: later.time, paused: later.paused, word: later.word },
          pauseReply: paused?.state?.status ?? null,
          afterPause: { status: afterPause.status, time: afterPause.time, paused: afterPause.paused },
          popupState,
          media,
          quiet,
          stopAvailable,
        });
        if (ok) await screenshot(`jump-error-stopped.png`);
        return {
          ok,
          detail: ok
            ? `failed jump paused at ${later.time.toFixed(2)}s on "${later.word || ""}"; Stop available; media ${media}`
            : `status ${failed.status}/${later.status} paused ${later.paused} ${atError.time}→${later.time} pauseHeld ${pauseHeld} highlight ${atError.word}→${later.word} popup ${JSON.stringify(popupState)} media ${media}`,
          evidence: path,
        };
      },
    },
    {
      name: "selection-stays-inside",
      async run() {
        await applySettings({ rate: 2, chunkChars: 800 });
        await navigate("select.html");
        const selected = await article.evaluate(`
          (() => {
            const node = document.querySelector("#picked");
            const range = document.createRange();
            range.selectNodeContents(node);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString();
          })()
        `);
        if (!selected.includes("sluice")) return { ok: false, detail: "selection was not applied" };
        await control("start", { scope: "selection", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 10000);
        const text = await spoken();
        const leaked = text.includes("unselected") || text.includes("brake sentence");
        const heard = text.includes("sluice");
        let escaped = false;
        for (let i = 0; i < 16; i += 1) {
          const sample = await probe();
          if (sample.word && /brake|unselected/i.test(sample.word)) escaped = true;
          if (sample.status === "idle" || sample.status === "error") break;
          await sleep(200);
        }
        const end = await probe();
        const ok = playing.status === "playing" && heard && !leaked && !escaped && end.status !== "error";
        return {
          ok,
          detail: ok
            ? `selection ended ${end.status}, spoke only the picked sentence`
            : `status ${playing.status}→${end.status} heard ${heard} leaked ${leaked} escaped ${escaped} text ${text.slice(0, 140)}`,
        };
      },
    },
    {
      name: "pitch-and-chunk-walk",
      async run() {
        await applySettings({ rate: 1, chunkChars: 280, autoScroll: false });
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.word, 12000);
        if (playing.status !== "playing") return { ok: false, detail: `did not start ${playing.status} ${playing.error}` };
        await control("setRate", { rate: 3 });
        await sleep(500);
        const sped = await probe();
        const pitchOk = sped.playback?.pitchPreserving === true
          && Math.abs((sped.playback?.stretchedRate ?? 0) - 3) < 0.05
          && sped.playback?.rate === 3
          && sped.rates.every((rate) => rate === 1);
        if (!pitchOk) return { ok: false, detail: `pitch moved ${JSON.stringify(sped.playback)} rates ${sped.rates}` };
        const text = await evaluate(`globalThis.__readAloud.extract.extract("page").text`);
        const seen = [];
        let cursor = 0;
        let backward = "";
        const deadline = Date.now() + 9000;
        let crossed = false;
        while (Date.now() < deadline) {
          const sample = await probe();
          if (sample.chunkIndex >= 1) crossed = true;
          if (sample.status === "error") return { ok: false, detail: `walk errored ${sample.error}` };
          if (sample.word && seen.at(-1) !== sample.word) {
            const at = text.indexOf(sample.word, Math.max(0, cursor - sample.word.length));
            if (at < 0) {
              const earlier = text.indexOf(sample.word);
              if (earlier >= 0 && earlier + sample.word.length < cursor - 1) {
                backward = `${seen.at(-1) || ""} → ${sample.word}`;
                break;
              }
            } else {
              cursor = Math.max(cursor, at + sample.word.length);
            }
            seen.push(sample.word);
          }
          await sleep(140);
        }
        const asked = await requests();
        const speedOk = asked.every((entry) => entry.speed === 1);
        if (!speedOk) return { ok: false, detail: `API speed was not 1: ${asked.map((entry) => entry.speed).join(",")}` };
        if (backward) return { ok: false, detail: `highlight jumped backward ${backward}` };
        if (!crossed) return { ok: false, detail: `never reached the next chunk; words ${seen.slice(0, 8).join(" ")}` };
        if (seen.length < 4) return { ok: false, detail: `highlight barely moved: ${seen.join(" ")}` };
        return { ok: true, detail: `3× kept pitch, walked ${seen.length} words across a chunk boundary, API speed 1` };
      },
    },
    {
      name: "stop-during-slow-load",
      async run() {
        await setTiming({ base: 1800, perChar: 0, timestamps: 0 });
        await applySettings({ chunkChars: 2000 });
        await navigate("article.html");
        const started = await control("start", { scope: "page", from: "start" });
        if (started?.state?.status !== "loading") return { ok: false, detail: `wanted loading, got ${started?.state?.status}` };
        await control("stop");
        await sleep(2300);
        const seen = await probe();
        const made = (await requests()).length;
        const silent = seen.status === "idle" && seen.paused !== false && seen.time < 0.05;
        return {
          ok: silent,
          detail: silent ? `stop during load stayed idle (${made} requests settled)` : `status ${seen.status} time ${seen.time} paused ${seen.paused}`,
        };
      },
    },
    {
      name: "loading-cursor",
      async run() {
        await setTiming({ base: 1600, perChar: 0, timestamps: 0 });
        await applySettings({ clickToJump: true, autoScroll: false });
        await navigate("article.html");
        const started = await control("start", { scope: "page", from: "start" });
        if (started?.state?.status !== "loading") return { ok: false, detail: `wanted loading, got ${started?.state?.status}` };
        const point = await pointOf("article p", 0);
        const seen = await cue(point);
        const still = await probe();
        const ok = still.status === "loading" && seen.cursor === "pointer" && seen.marked > 0;
        return {
          ok,
          detail: ok ? "pointer cursor while loading" : `status ${still.status} cursor ${seen.cursor} marked ${seen.marked}`,
        };
      },
    },
    {
      name: "editable-click-ignored",
      bug: "Editable text shows the jump cursor but a click does not move the read",
      async run(repeat) {
        await applySettings({ clickToJump: true, autoScroll: false, chunkChars: 2000 });
        await navigate("editor.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.word, 12000);
        if (playing.status !== "playing") return { ok: false, detail: `did not start ${playing.status} ${playing.error}` };
        const point = await pointOf("article p", 1);
        if (!point) return { ok: false, detail: "no second paragraph" };
        const before = await probe();
        const seen = await cue(point);
        await click(point);
        await sleep(700);
        const after = await probe();
        const onSecond = /spring|brake|second/i.test(after.word || "");
        const promised = seen.cursor === "pointer" && seen.marked > 0;
        const ignored = promised && !onSecond && after.status === "playing" && after.time < 4;
        const path = save(`bug-editable-click-${repeat}.json`, { seen, before, after, onSecond, promised });
        if (ignored) await screenshot(`bug-editable-click-${repeat}.png`);
        return {
          ok: ignored,
          detail: ignored
            ? `pointer over "${seen.text.slice(0, 48)}" but playback stayed on "${after.word}" at ${after.time.toFixed(2)}s`
            : `cursor ${seen.cursor} marked ${seen.marked} word ${before.word} → ${after.word} time ${after.time}`,
          evidence: path,
        };
      },
    },
    {
      name: "cjk-highlight-stuck",
      bug: "A space-free Chinese paragraph is highlighted as one block",
      async run(repeat) {
        await applySettings({ rate: 1, chunkChars: 2000 });
        await navigate("cjk.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.word && sample.time > 0.3, 12000);
        if (playing.status !== "playing") return { ok: false, detail: `did not start ${playing.status} ${playing.error}` };
        const samples = [playing];
        for (let i = 0; i < 8; i += 1) {
          await sleep(200);
          samples.push(await probe());
        }
        const words = [];
        for (const sample of samples) {
          if (sample.word && words.at(-1) !== sample.word) words.push(sample.word);
        }
        const movedTime = samples.at(-1).time > playing.time + 0.6;
        const longStuck = words.length === 1 && [...(words[0] || "")].length > 20 && movedTime && samples.at(-1).status === "playing";
        const path = save(`bug-cjk-highlight-${repeat}.json`, {
          words,
          length: [...(words[0] || "")].length,
          movedTime,
          from: playing.time,
          to: samples.at(-1).time,
        });
        if (longStuck) await screenshot(`bug-cjk-highlight-${repeat}.png`);
        return {
          ok: longStuck,
          detail: longStuck
            ? `highlight stayed on a ${[...words[0]].length}-character block from ${playing.time.toFixed(2)}s to ${samples.at(-1).time.toFixed(2)}s`
            : `words ${words.length}, status ${samples.at(-1).status}`,
          evidence: path,
        };
      },
    },
    {
      name: "mixed-script-plays",
      async run() {
        await applySettings();
        await navigate("mixed.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.word, 10000);
        const text = await spoken();
        const ok = playing.status === "playing"
          && text.includes("الطاحونة")
          && text.includes("sluice")
          && text.includes("الحارس");
        const words = [];
        for (let i = 0; i < 6; i += 1) {
          const sample = await probe();
          if (sample.word && words.at(-1) !== sample.word) words.push(sample.word);
          await sleep(200);
        }
        return {
          ok: ok && words.length >= 2 && playing.error === "",
          detail: ok ? `mixed script walked ${words.join(" | ")}` : `status ${playing.status} text ${text.slice(0, 100)} words ${words.join(" | ")}`,
        };
      },
    },
    {
      name: "kitchen-page",
      async run() {
        await applySettings({ readCodeBlocks: false, chunkChars: 2000 });
        await navigate("kitchen.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 10000);
        const text = await spoken();
        const problems = [];
        if (playing.status === "error") problems.push(playing.error || "error");
        if (text.includes("KITCHENCODETOKEN")) problems.push("code block was read");
        if (text.includes("とうきょう")) problems.push("ruby reading was read");
        if (!text.includes("東京")) problems.push("ruby base was skipped");
        if (text.includes("[1]")) problems.push("citation marker was read");
        if (!text.includes("autoCommit")) problems.push("prose was skipped");
        if (!text.includes("Gudgeon")) problems.push("table cell was skipped");
        if (text.includes("inner sluice token")) problems.push("iframe body was pulled into the page");
        return {
          ok: problems.length === 0,
          detail: problems.length ? problems.join("; ") : "kitchen page read prose, ruby base and the table once",
        };
      },
    },
    {
      name: "voice-mid-play",
      async run() {
        await applySettings({ voiceId: "eve", chunkChars: 280, rate: 2 });
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.time > 0.2, 12000);
        if (playing.status !== "playing") return { ok: false, detail: `did not start ${playing.status}` };
        await ui.evaluate(`chrome.storage.local.set({ voiceId: "ara" })`);
        await control("settingsChanged");
        await sleep(600);
        const during = await probe();
        if (during.status === "error") return { ok: false, detail: `voice change errored ${during.error}` };
        const settled = await until((sample) => sample.chunkIndex >= 1 && sample.status === "playing", 15000);
        const voices = (await requests()).map((entry) => entry.voiceId);
        const usedNew = voices.includes("ara");
        const ok = settled.status === "playing" && usedNew && during.time >= playing.time;
        return {
          ok,
          detail: ok
            ? `voice changed mid-play and the next chunk asked for ara (${voices.join(",")})`
            : `status ${during.status}→${settled.status} voices ${voices.join(",")}`,
        };
      },
    },
    {
      name: "navigate-reload-mid-read",
      async run() {
        await setTiming({ base: 1200, perChar: 0, timestamps: 0 });
        await applySettings();
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        const loading = await until((sample) => sample.status === "loading" || sample.status === "playing", 8000);
        if (loading.status === "error") return { ok: false, detail: loading.error };
        await navigate("empty.html");
        const next = await probe();
        if (next.status === "playing") return { ok: false, detail: "audio still marked playing after navigation" };
        await setTiming({ base: 0, perChar: 0, timestamps: 0 });
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        const again = await until((sample) => sample.status === "playing" && sample.time > 0.1, 10000);
        if (again.status !== "playing") return { ok: false, detail: `could not restart after navigate ${again.status} ${again.error}` };
        let reloadFired = false;
        const markReload = () => {
          reloadFired = true;
        };
        article.on("Page.loadEventFired", markReload);
        await article.send("Page.reload", { ignoreCache: true });
        const reloadDeadline = Date.now() + 8000;
        while (!reloadFired && Date.now() < reloadDeadline) await sleep(100);
        await sleep(300);
        await refreshWorld();
        const reloaded = await probe();
        const restarted = await control("start", { scope: "page", from: "start" });
        const ok = reloaded.status !== "playing" && restarted?.state?.status !== "error";
        return {
          ok,
          detail: ok ? "navigate and reload both left a page that can be read again" : `after reload ${reloaded.status}, restart ${restarted?.state?.status}`,
        };
      },
    },
    {
      name: "second-tab-handoff",
      async run() {
        await applySettings({ chunkChars: 2000 });
        await navigate("article.html");
        await control("start", { scope: "page", from: "start" });
        const first = await until((sample) => sample.status === "playing" && sample.time > 0.1, 10000);
        if (first.status !== "playing") return { ok: false, detail: `first tab did not play ${first.status}` };
        const created = await browser.send("Target.createTarget", {
          url: `http://127.0.0.1:${PAGE_PORT}/select.html`,
        });
        const info = await findTarget((target) => target.id === created.targetId, "second tab");
        const second = await new Session(info.webSocketDebuggerUrl).open();
        await second.send("Runtime.enable");
        await second.send("Page.enable");
        await attachConsole(second, "page");
        const tabId = await tabIdByUrl("/select.html");
        if (!tabId) {
          second.close();
          return { ok: false, detail: "second tab had no id" };
        }
        await ui.evaluate(`new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify({ type: "getTabState", tabId })}, resolve))`);
        const started = await controlTab(tabId, "start", { scope: "page", from: "start" });
        const other = await untilTabPlaying(tabId);
        await sleep(400);
        const original = await probe();
        await browser.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
        second.close();
        await activate();
        const yielded = other === "playing" && original.status === "paused";
        return {
          ok: yielded,
          detail: yielded
            ? `second tab took the read, first paused (${original.notice})`
            : `first ${original.status} notice "${original.notice}", second ${other}, start ${started?.state?.status}`,
        };
      },
    },
    {
      name: "rapid-click-jump",
      async run() {
        await applySettings({ clickToJump: true, autoScroll: false, chunkChars: 400 });
        await navigate("huge.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" && sample.word, 12000);
        if (playing.status !== "playing") return { ok: false, detail: `did not start ${playing.status}` };
        const indexes = [6, 10, 14];
        for (const index of indexes) {
          const point = await pointOf("article p", index);
          if (point) await click(point);
          await sleep(80);
        }
        const settled = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        const text = await spoken();
        const askedLate = text.includes("Paragraph 15") || text.includes("Paragraph 11") || text.includes("Paragraph 7");
        const ok = settled.status === "playing" && !settled.error && askedLate;
        return {
          ok,
          detail: ok ? `rapid clicks settled on ${settled.word}` : `status ${settled.status} ${settled.error} late ${askedLate}`,
        };
      },
    },
    {
      name: "bad-key-and-faults",
      async run() {
        const secret = "ra-hunt-token-not-a-real-key";
        await applySettings({ apiKey: secret, chunkChars: 2000 });
        await setFault("unauthorized", 4);
        await navigate("article.html?case=unauthorized");
        await control("start", { scope: "page", from: "start" });
        const rejected = await until((sample) => sample.status === "error" || sample.status === "playing", 12000);
        const message = rejected.error || "";
        if (rejected.status !== "error") return { ok: false, detail: `bad key status ${rejected.status}` };
        if (message.includes(secret) || message.includes(KEY)) return { ok: false, detail: "error text included the credential" };
        if ((recentLogs?.() ?? []).some((entry) => entry.text.includes(secret))) {
          return { ok: false, detail: "credential was written to a console log" };
        }
        await resetMock();
        await applySettings({ apiKey: KEY, chunkChars: 2000 });
        await setFault("missing-audio", 4);
        await navigate("article.html?case=missing-audio");
        await control("start", { scope: "page", from: "start" });
        const missing = await until((sample) => sample.status === "error", 12000);
        if (missing.status !== "error") return { ok: false, detail: `missing audio stayed ${missing.status}` };
        if ((missing.error || "").includes(KEY)) return { ok: false, detail: "missing-audio error included the credential" };
        const made = (await requests()).length;
        if (made > 6) return { ok: false, detail: `missing audio issued ${made} requests` };
        return { ok: true, detail: `rejected key without echoing it; missing audio errored in ${made} requests` };
      },
    },
    {
      name: "docs-canvas",
      async run() {
        await applySettings({ chunkChars: 2000, clickToJump: true });
        await navigate(DOC_URL);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        const text = await spoken();
        const point = await pointOf(".kix-page", 0);
        const seen = point ? await cue(point) : { cursor: null, marked: 0 };
        const problems = [];
        if (playing.status !== "playing") problems.push(`status ${playing.status} ${playing.error}`);
        if (!text.includes("Blackwater")) problems.push("document text was not requested");
        if (!text.includes("pegged") && playing.chunkCount < 3) {
          problems.push(`only ${playing.chunkCount} parts were fetched (${text.length} chars)`);
        }
        if (/\b(File|Edit|Share|Tools)\b/.test(text)) problems.push("menu chrome was read");
        if (playing.word) problems.push(`highlighted "${playing.word}" on a canvas doc`);
        if (seen.cursor === "pointer" || seen.marked > 0) problems.push(`cursor ${seen.cursor} marked ${seen.marked}`);
        if (!String(playing.notice || "").toLowerCase().includes("canvas")) problems.push(`notice "${playing.notice}"`);
        return {
          ok: problems.length === 0,
          detail: problems.length ? problems.join("; ") : "docs export read, no highlight, no pointer",
        };
      },
    },
    {
      name: "append-while-reading",
      async run() {
        await applySettings({ chunkChars: 400 });
        await navigate("article.html");
        const before = (await requests()).length;
        await control("start", { scope: "page", from: "start" });
        await until((sample) => sample.status === "playing", 10000);
        await article.evaluate(`
          (() => {
            const article = document.querySelector("article");
            for (let i = 0; i < 30; i += 1) {
              const p = document.createElement("p");
              p.textContent = "Appended paragraph " + i + " arrives after the read has already started and must not restart it.";
              article.append(p);
            }
          })()
        `);
        await sleep(800);
        const seen = await probe();
        const made = (await requests()).length - before;
        const ok = seen.status === "playing" && !seen.error && made <= 4;
        return {
          ok,
          detail: ok ? `appending 30 paragraphs left playback playing, ${made} requests` : `status ${seen.status} ${seen.error} requests ${made}`,
        };
      },
    },
    {
      name: "pdf-refusal",
      async run() {
        await applySettings();
        try {
          await navigate("tiny.pdf");
        } catch (error) {
          const text = String(error.message || error);
          if (text.includes(KEY)) return { ok: false, detail: "pdf error included the credential" };
          return { ok: true, detail: `pdf navigate stopped cleanly: ${text.slice(0, 140)}` };
        }
        const started = await control("start", { scope: "page", from: "start" });
        const status = started?.state?.status || started?.ok;
        const message = `${started?.state?.error || ""} ${started?.error || ""}`;
        if (message.includes(KEY)) return { ok: false, detail: "pdf start error included the credential" };
        const ok = status === "error" || status === "playing" || started?.ok === false;
        return {
          ok,
          detail: `pdf start → ${status} ${message.slice(0, 120)}`,
        };
      },
    },
    {
      name: "impatient-seeds",
      async run() {
        const seeds = [SEED, 8675309, 424242];
        const notes = [];
        for (const seed of seeds) {
          const random = mulberry32(seed);
          const rate = [0.5, 1, 1.5, 2, 3][Math.floor(random() * 5)];
          await applySettings({ rate: 1, chunkChars: 300, clickToJump: true, autoScroll: false });
          await navigate(`article.html?seed=${seed}`);
          await control("start", { scope: "page", from: "start" });
          const playing = await until((sample) => sample.status === "playing" && sample.word, 12000);
          if (playing.status !== "playing") return { ok: false, detail: `seed ${seed} did not start ${playing.status} ${playing.error}` };
          await control("setRate", { rate });
          await sleep(350);
          const sped = await probe();
          const pitchOk = sped.status !== "error"
            && sped.playback?.pitchPreserving === true
            && Math.abs((sped.playback?.stretchedRate ?? 0) - rate) < 0.08
            && sped.rates.every((value) => value === 1);
          if (!pitchOk) return { ok: false, detail: `seed ${seed} pitch ${JSON.stringify(sped.playback)} rates ${sped.rates}` };
          if (random() < 0.5) {
            await control("pause");
            await sleep(200);
            const held = await probe();
            if (held.status !== "paused") return { ok: false, detail: `seed ${seed} pause → ${held.status}` };
            await control("resume");
          } else {
            await control("skipSentence", { delta: random() < 0.5 ? -1 : 1 });
          }
          await sleep(300);
          const mid = await probe();
          if (mid.status === "error") return { ok: false, detail: `seed ${seed} errored ${mid.error}` };
          await control("stop");
          await sleep(250);
          const stopped = await probe();
          const timeAtStop = stopped.time;
          await sleep(350);
          const later = await probe();
          if (stopped.status !== "idle" || later.paused === false || Math.abs(later.time - timeAtStop) > 0.08) {
            return { ok: false, detail: `seed ${seed} audio after stop ${later.status} ${timeAtStop}→${later.time}` };
          }
          const burstBefore = (await requests()).length;
          await Promise.all([
            control("start", { scope: "page", from: "start" }),
            control("start", { scope: "page", from: "start" }),
            control("start", { scope: "page", from: "start" }),
          ]);
          await sleep(800);
          const after = await probe();
          const made = (await requests()).length - burstBefore;
          if (after.error && after.status === "error" && /TypeError|undefined/.test(after.error)) {
            return { ok: false, detail: `seed ${seed} burst ${after.error}` };
          }
          if (made > 8) return { ok: false, detail: `seed ${seed} burst issued ${made} requests` };
          notes.push(`${seed}@${rate}×`);
        }
        return { ok: true, detail: `seeds ${notes.join(", ")}` };
      },
    },
  ];

  async function untilTabPlaying(tabId) {
    const deadline = Date.now() + 12000;
    let status = "missing";
    while (Date.now() < deadline) {
      const response = await controlTab(tabId, "getState");
      status = response?.state?.status || status;
      if (status === "playing" || status === "error" || status === "paused") return status;
      await sleep(200);
    }
    return status;
  }
}
