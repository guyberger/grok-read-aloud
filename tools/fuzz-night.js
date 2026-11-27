/**
 * Tonight's fuzz pages and scenarios (seed 20261127). Product code is not
 * involved: these only drive the packaged extension. A scenario with `bug`
 * set is an open bug, expected to reproduce on every repeat.
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

const OPENER = "TOKENOPEN The sluice was shut at dawn.";
const LONG_HEAD = "TOKENLONG The keeper walked the whole length of the dam";
const LONG_FILL = " and looked at another peg in the frame";
const LONG_TAIL = " until CHUNKTWOTOKEN showed up in this same sentence and the brake still held firm";

let longBody = LONG_HEAD;
while (OPENER.length + 1 + longBody.length < 560) longBody += LONG_FILL;
longBody += LONG_TAIL;

export const nightPages = new Map();

nightPages.set(
  "long-sentence.html",
  shell(
    "One long sentence",
    `<article>
      <p id="open">${OPENER}</p>
      <p id="long">${longBody}.</p>
    </article>`,
  ),
);

nightPages.set(
  "table-order.html",
  shell(
    "Ledger order",
    `<article>
      <h1>Season ledger</h1>
      <table id="foot-first">
        <caption>CAPTIONTOKEN The season in one line.</caption>
        <thead><tr><th id="head-cell">HEADTOKEN</th><th>Task</th></tr></thead>
        <tfoot><tr><td id="foot-cell">FOOTTOKEN</td><td>Total for the season</td></tr></tfoot>
        <tbody>
          <tr><td id="body-cell">BODYTOKEN</td><td>Draw the gudgeon and set it true before the tide</td></tr>
          <tr><td>SLUICETOKEN</td><td>Clear the sluice before the pond fills</td></tr>
        </tbody>
      </table>
      <table id="head-last">
        <tbody><tr><td id="late-body">LATEBODY</td><td>The rows are written first in the markup</td></tr></tbody>
        <thead><tr><th id="late-head">LATEHEAD</th><th>Column</th></tr></thead>
      </table>
      <p>After both tables the keeper closes the ledger and walks the dam.</p>
    </article>`,
  ),
);

nightPages.set(
  "open-details.html",
  shell(
    "Open ledger",
    `<article>
      <p>The keeper opens the ledger before anything else and writes the hour.</p>
      <details open>
        <summary>Open question about the wheel</summary>
        <p>OPENANSWERTOKEN the answer is on the page and must be spoken.</p>
        <details>
          <summary>Nested question still folded</summary>
          <p>NESTEDFOLDEDTOKEN this inner answer must stay silent.</p>
        </details>
      </details>
      <p>After the open note the brake is mentioned once.</p>
    </article>`,
  ),
);

nightPages.set(
  "hebrew.html",
  shell(
    "טחנה",
    `<article dir="rtl" lang="he"><h1>טחנת הגאות</h1>
     <p>הטחנה עובדת על הגאות פעמיים ביום, והשומר בודק את הגלגל לפני שהעץ מתייבש.</p>
     <p>אין דבק במסגרת. כל חיבור ננעל ביתד שאפשר להוציא בפטיש ובסבלנות.</p></article>`,
  ),
);

nightPages.set(
  "exponent.html",
  shell(
    "Relation",
    `<article><p>The relation written in the ledger is E=mc<sup>2</sup> and the digit belongs in the sentence.</p>
     <p>After the relation the keeper returns to the sluice and the brake.</p></article>`,
  ),
);

nightPages.set(
  "nested-list.html",
  shell(
    "Lists",
    `<article>
      <p>Before the list the keeper names the morning.</p>
      <ol>
        <li>LISTONETOKEN draw the gudgeon and set it true.</li>
        <li>LISTTWOTOKEN clear the sluice.
          <ol><li>NESTEDTOKEN the inner step is part of the second item and is read once.</li></ol>
        </li>
      </ol>
      <p>After the list the elm bucket is cut from timber that has lain under water.</p>
    </article>`,
  ),
);

nightPages.set(
  "line-gap.html",
  shell(
    "Wrapped",
    `<article><p id="wrap">The wrapped paragraph is long enough to break across several lines of the page so a click in the gap between two of those lines still has a sentence to move, and the keeper keeps writing until the pond is empty and the brake is checked and the ledger is closed for the night.</p></article>`,
    "article p { font-size: 28px; line-height: normal; max-width: 420px; }",
  ),
);

nightPages.set(
  "button-article.html",
  shell(
    "Button",
    `<article>
      <p id="prose">The prose around the control says the sluice was drawn at dawn and the brake held.</p>
      <p><button type="button">BUTTONTOKEN do not speak this control</button></p>
      <p id="later">The later sentence mentions the elm bucket and the spring tide only.</p>
    </article>`,
  ),
);

export function nightScenarios(ctx) {
  const {
    SEED,
    applySettings,
    navigate,
    control,
    probe,
    until,
    sleep,
    setFault,
    resetMock,
    requests,
    article,
    save,
    screenshot,
    activate,
    evaluate,
    refreshWorld,
    recentLogs,
  } = ctx;

  async function spoken() {
    return (await requests()).map((entry) => entry.text).join("\n");
  }

  async function paragraphId() {
    return evaluate(`
      (() => {
        const highlight = CSS.highlights?.get?.("read-aloud-word");
        let id = "";
        if (highlight) {
          for (const range of highlight) {
            const node = range.startContainer;
            const el = node && node.nodeType === 1 ? node : node?.parentElement;
            id = el?.closest?.("p, td, th")?.id || "";
          }
        }
        return id;
      })()
    `);
  }

  async function pointOf(selector) {
    return article.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = el.getClientRects()[0];
        if (!rect) return null;
        return { x: rect.left + Math.min(24, Math.max(8, rect.width / 4)), y: rect.top + Math.min(rect.height / 2, 14) };
      })()
    `);
  }

  async function click(point) {
    await activate();
    const common = { x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 };
    await article.send("Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 0, ...common });
    await sleep(40);
    await article.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...common });
    await article.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...common });
  }

  return [
    {
      name: "sentence-back-across-chunk",
      bug: "Stepping back just after a chunk join leaves the sentence still being spoken",
      async run(repeat) {
        await applySettings({ chunkChars: 2000, rate: 1, autoScroll: false, clickToJump: false });
        await navigate(`long-sentence.html?seed=${SEED}&r=${repeat}`);
        const shape = await evaluate(`
          (() => {
            const doc = globalThis.__readAloud.extract.extract("page");
            const ranges = globalThis.__readAloud.align.chunkRanges(doc.text, 2000, { firstChars: 240 });
            const sentences = globalThis.__readAloud.align.sentences(doc.text);
            const second = ranges[1];
            const sentence = sentences.find((span) => second && span.start < second.start && span.end > second.start);
            return {
              chunks: ranges.length,
              chunk0: doc.text.slice(ranges[0].start, ranges[0].end).slice(0, 80),
              chunk1HasToken: second ? doc.text.slice(second.start, second.end).includes("CHUNKTWOTOKEN") : false,
              chunk0HasLong: doc.text.slice(ranges[0].start, ranges[0].end).includes("TOKENLONG"),
              sentenceCrosses: Boolean(sentence),
              sentenceCount: sentences.length,
            };
          })()
        `);
        if (!shape.sentenceCrosses || !shape.chunk1HasToken || !shape.chunk0HasLong) {
          return { ok: false, detail: `page did not split the long sentence: ${JSON.stringify(shape)}` };
        }
        await control("start", { scope: "page", from: "start" });
        let caught = null;
        const spokenAt = (sample) =>
          sample.time * (sample.playback?.stretchedRate || 1) - (sample.playback?.lead || 0);
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const sample = await probe();
          if (sample.status === "error") return { ok: false, detail: `errored before the join: ${sample.error}` };
          // chunkIndex moves as soon as the next chunk is requested, while the
          // element clock still belongs to the chunk that is finishing. Only a
          // playing sample is the new chunk, and its spoken time is past the
          // unspoken lead-in.
          if (sample.status === "playing" && sample.chunkIndex >= 1 && sample.word) {
            const spoken = spokenAt(sample);
            if (spoken >= 1.2) {
              return {
                ok: false,
                detail: `chunk 2 opened at spoken ${spoken.toFixed(2)}s (element ${sample.time.toFixed(2)}s, lead ${sample.playback?.lead ?? 0})`,
              };
            }
            if (spoken > 0.02) {
              caught = { ...sample, spoken };
              break;
            }
          }
          await sleep(30);
        }
        if (!caught) return { ok: false, detail: "never reached the second chunk" };
        const beforeId = await paragraphId();
        await control("skipSentence", { delta: -1 });
        const landed = await until(
          (sample) => sample.status === "playing" && sample.word && sample.chunkIndex === 0,
          8000,
        );
        await sleep(200);
        const after = await probe();
        const afterId = await paragraphId();
        const text = await spoken();
        const leftTheSentence = afterId === "open" || /\bTOKENOPEN\b/.test(after.word || "");
        const path = save(`bug-sentence-back-chunk-${repeat}.json`, {
          seed: SEED,
          shape,
          caught: {
            chunkIndex: caught.chunkIndex,
            time: caught.time,
            spoken: caught.spoken,
            lead: caught.playback?.lead ?? 0,
            word: caught.word,
            id: beforeId,
          },
          after: { status: after.status, chunkIndex: after.chunkIndex, time: after.time, word: after.word, id: afterId },
          landed: { status: landed.status, word: landed.word, chunkIndex: landed.chunkIndex },
          leftTheSentence,
          text: text.slice(0, 240),
        });
        if (leftTheSentence) {
          await screenshot(`bug-sentence-back-chunk-${repeat}.png`);
          await screenshot("bug-sentence-back-chunk.png");
          save("bug-sentence-back-chunk.json", {
            seed: SEED,
            spoken: caught.spoken,
            word: caught.word,
            from: beforeId,
            landed: afterId,
            landedWord: after.word,
          });
        }
        return {
          ok: leftTheSentence && after.status === "playing",
          detail: leftTheSentence
            ? `at spoken ${caught.spoken.toFixed(2)}s of chunk 2 ("${caught.word}" #${beforeId}) back landed on #${afterId} "${after.word}"`
            : `back stayed on #${afterId || "none"} "${after.word}" (status ${after.status})`,
          evidence: path,
        };
      },
    },
    {
      name: "table-source-order",
      bug: "Table headers and footers are read in source order, not the order on the page",
      async run(repeat) {
        await applySettings({ chunkChars: 2000, autoScroll: false });
        await navigate(`table-order.html?seed=${SEED}&r=${repeat}`);
        const order = await evaluate(`
          (() => {
            const doc = globalThis.__readAloud.extract.extract("page");
            const text = doc?.text || "";
            const top = (selector) => {
              const el = document.querySelector(selector);
              const rect = el?.getBoundingClientRect();
              return rect ? Math.round(rect.top) : null;
            };
            return {
              text,
              footBeforeBody: text.indexOf("FOOTTOKEN") >= 0 && text.indexOf("FOOTTOKEN") < text.indexOf("BODYTOKEN"),
              lateHeadBeforeBody: text.indexOf("LATEHEAD") >= 0 && text.indexOf("LATEHEAD") < text.indexOf("LATEBODY"),
              tops: {
                head: top("#head-cell"),
                foot: top("#foot-cell"),
                body: top("#body-cell"),
                lateHead: top("#late-head"),
                lateBody: top("#late-body"),
              },
            };
          })()
        `);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 10000);
        let text = "";
        const askedDeadline = Date.now() + 8000;
        while (Date.now() < askedDeadline) {
          text = await spoken();
          if (text.includes("BODYTOKEN") && text.includes("LATEBODY")) break;
          await sleep(150);
        }
        const visualFootLast = order.tops.foot != null && order.tops.body != null && order.tops.foot > order.tops.body;
        const visualHeadFirst = order.tops.lateHead != null && order.tops.lateBody != null && order.tops.lateHead < order.tops.lateBody;
        const spokenFootFirst = text.indexOf("FOOTTOKEN") >= 0 && text.indexOf("FOOTTOKEN") < text.indexOf("BODYTOKEN");
        const spokenHeadAfterBody = text.includes("LATEHEAD") && text.indexOf("LATEBODY") >= 0 && text.indexOf("LATEBODY") < text.indexOf("LATEHEAD");
        const footBug = visualFootLast && (order.footBeforeBody || spokenFootFirst);
        const headBug = visualHeadFirst && spokenHeadAfterBody;
        const path = save(`bug-table-order-${repeat}.json`, {
          seed: SEED,
          playing: playing.status,
          visualFootLast,
          visualHeadFirst,
          spokenFootFirst,
          spokenHeadAfterBody,
          tops: order.tops,
          extractFootBeforeBody: order.footBeforeBody,
          extractLateHeadBeforeBody: order.lateHeadBeforeBody,
          spoken: text.slice(0, 700),
        });
        if (footBug || headBug) {
          await screenshot(`bug-table-order-${repeat}.png`);
          await screenshot("bug-table-order.png");
          save("bug-table-order.json", {
            seed: SEED,
            tops: order.tops,
            spokenFootFirst,
            spokenHeadAfterBody,
            spoken: text.slice(0, 700),
          });
        }
        const reproduced = playing.status === "playing" && (footBug || headBug);
        return {
          ok: reproduced,
          detail: reproduced
            ? `footer spoken before the rows ${footBug}; header spoken after the rows it labels ${headBug}`
            : `status ${playing.status} did not reproduce (foot ${footBug}, head ${headBug})`,
          evidence: path,
        };
      },
    },
    {
      name: "night-invariants",
      async run() {
        const notes = [];
        await applySettings({ chunkChars: 2000, rate: 1, autoScroll: false, clickToJump: true });

        await navigate("open-details.html");
        await control("start", { scope: "page", from: "start" });
        const details = await until((sample) => sample.status === "playing" || sample.status === "error", 10000);
        const detailsText = await spoken();
        if (details.status === "error") return { ok: false, detail: `open details errored ${details.error}` };
        if (!detailsText.includes("OPENANSWERTOKEN")) return { ok: false, detail: "open disclosure body was skipped" };
        if (detailsText.includes("NESTEDFOLDEDTOKEN")) return { ok: false, detail: "nested closed disclosure was read" };
        notes.push("open details");

        await resetMock();
        await navigate("exponent.html");
        await control("start", { scope: "page", from: "start" });
        const exponent = await until((sample) => sample.status === "playing" || sample.status === "error", 10000);
        const exponentText = await spoken();
        if (exponent.status === "error") return { ok: false, detail: `exponent errored ${exponent.error}` };
        if (!/mc2|mc²/.test(exponentText)) return { ok: false, detail: `superscript digit dropped: ${exponentText.slice(0, 160)}` };
        notes.push("exponent");

        await resetMock();
        await navigate("nested-list.html");
        const listExtract = await evaluate(`globalThis.__readAloud.extract.extract("page")?.text || ""`);
        await control("start", { scope: "page", from: "start" });
        const listed = await until((sample) => sample.status === "playing" || sample.status === "error", 10000);
        if (listed.status === "error") return { ok: false, detail: `list errored ${listed.error}` };
        const once = (token) => listExtract.split(token).length - 1 === 1;
        if (!once("LISTONETOKEN") || !once("LISTTWOTOKEN") || !once("NESTEDTOKEN")) {
          return { ok: false, detail: `list tokens repeated or missing: ${listExtract.slice(0, 220)}` };
        }
        notes.push("nested list once");

        await resetMock();
        await navigate("hebrew.html");
        await control("start", { scope: "page", from: "start" });
        const hebrew = await until((sample) => sample.status === "playing" && sample.word, 10000);
        const hebrewText = await spoken();
        if (hebrew.status !== "playing" || !hebrewText.includes("הטחנה")) {
          return { ok: false, detail: `hebrew status ${hebrew.status} ${hebrewText.slice(0, 80)}` };
        }
        const hebrewWords = [];
        for (let i = 0; i < 8; i += 1) {
          const sample = await probe();
          if (sample.word && hebrewWords.at(-1) !== sample.word) hebrewWords.push(sample.word);
          await sleep(180);
        }
        if (hebrewWords.length < 2) return { ok: false, detail: `hebrew highlight stuck: ${hebrewWords.join(" | ") || "none"}` };
        notes.push(`hebrew ${hebrewWords.length} words`);

        await resetMock();
        await navigate("button-article.html");
        await control("start", { scope: "page", from: "start" });
        const buttonRead = await until((sample) => sample.status === "playing" && sample.word, 10000);
        if (buttonRead.status !== "playing") return { ok: false, detail: `button page ${buttonRead.status} ${buttonRead.error}` };
        const buttonText = await spoken();
        if (buttonText.includes("BUTTONTOKEN")) return { ok: false, detail: "button label was read" };
        if (!buttonText.includes("sluice")) return { ok: false, detail: "prose around the button was skipped" };
        const beforeClick = await probe();
        const buttonPoint = await pointOf("button");
        if (!buttonPoint) return { ok: false, detail: "button was not on the page" };
        await click(buttonPoint);
        await sleep(400);
        const afterClick = await probe();
        if (afterClick.status === "error") return { ok: false, detail: `clicking the button errored ${afterClick.error}` };
        if (afterClick.status !== "playing" && afterClick.status !== "paused") {
          return { ok: false, detail: `clicking the button left ${afterClick.status}` };
        }
        const moved = afterClick.chunkIndex !== beforeClick.chunkIndex && afterClick.time + 0.2 < beforeClick.time;
        if (moved) return { ok: false, detail: "clicking the button jumped the read" };
        notes.push("button ignored");

        await resetMock();
        await setFault("nan-timestamps", 4);
        await navigate("exponent.html?case=nan");
        await control("start", { scope: "page", from: "start" });
        const nan = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        if (nan.status !== "playing" && nan.status !== "error") {
          return { ok: false, detail: `non-finite timestamps stayed ${nan.status}` };
        }
        const leaked = (recentLogs?.() ?? []).some((entry) => /mock-local-key/.test(entry.text));
        if (leaked) return { ok: false, detail: "credential surfaced while timestamps were non-finite" };
        const exploded = (recentLogs?.() ?? []).filter((entry) =>
          /TypeError|ReferenceError|Cannot read properties/.test(entry.text),
        );
        if (exploded.length) return { ok: false, detail: `non-finite timestamps threw ${exploded[0].text.slice(0, 160)}` };
        notes.push(`nan timestamps ${nan.status}`);

        await resetMock();
        await setFault("", 0);
        await applySettings({ rate: 1, chunkChars: 400, autoScroll: true, clickToJump: true });
        await navigate("tall.html");
        await control("start", { scope: "page", from: "start" });
        const tall = await until((sample) => sample.status === "playing" && sample.word, 12000);
        if (tall.status !== "playing") return { ok: false, detail: `tall page ${tall.status} ${tall.error}` };
        await activate();
        await article.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 500,
          y: 400,
          deltaX: 0,
          deltaY: 900,
        });
        await sleep(700);
        const parked = await evaluate(`
          ({ y: Math.round(window.scrollY), following: globalThis.__readAloud.reader.snapshot().following })
        `);
        await sleep(1200);
        const held = await evaluate(`
          ({ y: Math.round(window.scrollY), following: globalThis.__readAloud.reader.snapshot().following, status: globalThis.__readAloud.reader.snapshot().status })
        `);
        if (held.status === "error") return { ok: false, detail: "scroll-away errored" };
        if (parked.following !== false) {
          return { ok: false, detail: `wheel did not release the view (following ${parked.following}, y ${parked.y})` };
        }
        if (Math.abs(held.y - parked.y) > 40) {
          return { ok: false, detail: `auto-scroll pulled the page back (${parked.y} → ${held.y})` };
        }
        notes.push("scroll-away held");

        await control("setRate", { rate: 0.5 });
        await sleep(400);
        const slow = await probe();
        const pitchOk = slow.playback?.pitchPreserving === true
          && Math.abs((slow.playback?.stretchedRate ?? 0) - 0.5) < 0.05
          && slow.rates.every((rate) => rate === 1);
        if (!pitchOk) return { ok: false, detail: `0.5× moved the pitch ${JSON.stringify(slow.playback)} rates ${slow.rates}` };
        await control("pause");
        await sleep(200);
        await control("setRate", { rate: 2 });
        await control("resume");
        const resumed = await until((sample) => sample.status === "playing" && sample.time > 0, 8000);
        const pitchAgain = resumed.playback?.pitchPreserving === true
          && Math.abs((resumed.playback?.stretchedRate ?? 0) - 2) < 0.08
          && resumed.rates.every((rate) => rate === 1);
        if (resumed.status !== "playing" || !pitchAgain) {
          return { ok: false, detail: `pause-rate-resume ${resumed.status} ${JSON.stringify(resumed.playback)}` };
        }
        notes.push("0.5× then 2×");

        await control("stop");
        await sleep(250);
        const stopped = await probe();
        const atStop = stopped.time;
        await sleep(400);
        const later = await probe();
        if (stopped.status !== "idle" || later.paused === false || Math.abs(later.time - atStop) > 0.08) {
          return { ok: false, detail: `audio after stop at 2× ${later.status} ${atStop}→${later.time}` };
        }
        notes.push("stop silenced");

        await resetMock();
        await applySettings({ chunkChars: 2000, rate: 1, autoScroll: false });
        await navigate("line-gap.html");
        await control("start", { scope: "page", from: "start" });
        const gapPlay = await until((sample) => sample.status === "playing" && sample.word, 10000);
        if (gapPlay.status !== "playing") return { ok: false, detail: `line gap page ${gapPlay.status}` };
        const gap = await evaluate(`
          (() => {
            const paragraph = document.querySelector("#wrap");
            const node = paragraph.firstChild;
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, node.data.length);
            const rects = [...range.getClientRects()].filter((rect) => rect.width > 2 && rect.height > 2);
            rects.sort((a, b) => a.top - b.top || a.left - b.left);
            let hole = null;
            for (let i = 0; i < rects.length - 1; i += 1) {
              const above = rects[i];
              const below = rects[i + 1];
              if (below.top - above.bottom < 2) continue;
              if (Math.abs(below.left - above.left) > 40) continue;
              hole = {
                x: Math.round(above.left + 12),
                y: Math.round((above.bottom + below.top) / 2),
                gap: Math.round(below.top - above.bottom),
              };
              break;
            }
            if (!hole) return { hole: null, rects: rects.length };
            const doc = globalThis.__readAloud.extract.extract("page");
            const index = globalThis.__readAloud.extract.charIndexFromPoint(doc, hole.x, hole.y);
            return { hole, index, rects: rects.length };
          })()
        `);
        if (gap.hole && gap.index < 0) {
          const path = save("line-gap.json", { seed: SEED, gap });
          await screenshot("line-gap.png");
          return {
            ok: false,
            detail: `click gap of ${gap.hole.gap}px between lines is not part of the read`,
            evidence: path,
          };
        }
        notes.push(gap.hole ? `line gap ${gap.hole.gap}px hit` : "no line gap");

        await resetMock();
        await applySettings({ chunkChars: 240, rate: 1, autoScroll: false });
        await navigate("huge.html?seed=resume");
        await control("start", { scope: "page", from: "start" });
        const started = await until((sample) => sample.status === "playing" && sample.word, 12000);
        if (started.status !== "playing") return { ok: false, detail: `resume page ${started.status}` };
        let mid = started;
        for (let step = 0; step < 6; step += 1) {
          await control("skipSentence", { delta: 1 });
          mid = await until((sample) => sample.status === "playing" || sample.status === "paused" || sample.status === "error", 8000);
          await sleep(120);
        }
        if (mid.status === "error") return { ok: false, detail: `skipping ahead errored ${mid.error}` };
        await control("pause");
        await sleep(400);
        const marked = await evaluate(`globalThis.__readAloud.reader.snapshot().resume`);
        await article.send("Page.reload", { ignoreCache: true });
        await refreshWorld();
        const continued = await control("start", { scope: "page", from: "resume" });
        const again = await until((sample) => sample.status === "playing" && sample.word, 12000);
        const resumedWord = again.word || "";
        const restartedAtTop = /Paragraph 1\b/.test(resumedWord) || resumedWord === "Paragraph" || resumedWord === "A";
        if (!marked) {
          notes.push("resume not offered");
        } else if (again.status !== "playing") {
          return { ok: false, detail: `continue after reload ${again.status} ${again.error} (was ${continued?.state?.status})` };
        } else if (restartedAtTop) {
          const path = save("reload-resume.json", { seed: SEED, marked, mid, again, resumedWord });
          return {
            ok: false,
            detail: `continue after reload started at "${resumedWord}" instead of the saved place`,
            evidence: path,
          };
        } else {
          notes.push(`reload resumed at "${resumedWord}"`);
        }

        return { ok: true, detail: notes.join("; ") };
      },
    },
  ];
}
