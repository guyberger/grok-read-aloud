/**
 * Fuzz pages and scenarios for seed 20261128. Product code is not involved:
 * these only drive the packaged extension. A scenario with `bug` set is an
 * open bug, expected to reproduce on every repeat.
 */
const shell = (title, body, extra = "") => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
  <style>
    body { margin: 0; font: 18px/1.6 Georgia, serif; }
    nav, footer { font: 14px system-ui, sans-serif; background: #eee; padding: 12px 16px; }
    article, main { max-width: 680px; margin: 24px auto; padding: 0 16px 80px; }
    td, th, caption { border: 1px solid #ccc; padding: 6px 10px; }
    ${extra}
  </style></head><body>
  <nav>Navigation: Home · Notes · Index</nav>
  ${body}
  <footer>Footer: sources and corrections.</footer>
  </body></html>`;

const STORY_SENTENCE =
  "STORYTOKEN The mill pond fills through the sluice and the keeper writes the hour in the ledger. ";
const OTHER_SENTENCE =
  "OTHERTKEN The feature keeps going with another creek, another wheel, and another ledger the keeper never opens. ";

export const todayPages = new Map();

todayPages.set(
  "longer-main.html",
  shell(
    "Two pieces",
    `<main id="story">
      <h1>How the tide mill keeps its wheel</h1>
      <p>${STORY_SENTENCE.repeat(6)}</p>
    </main>
    <article id="other">
      <h1>A longer feature</h1>
      <p>${OTHER_SENTENCE.repeat(14)}</p>
    </article>`,
  ),
);

todayPages.set(
  "flex-order.html",
  shell(
    "Reordered",
    `<article>
      <div id="col" style="display:flex;flex-direction:column-reverse;width:480px">
        <p id="newest">NEWESTTOKEN the latest note, painted at the bottom of the column.</p>
        <p id="oldest">OLDESTTOKEN the dawn note, painted at the top of the column.</p>
      </div>
      <div id="ord" style="display:flex;flex-direction:column;width:480px">
        <p id="order2" style="order:2">ORDER2TOKEN this line is painted second.</p>
        <p id="order1" style="order:1">ORDER1TOKEN this line is painted first.</p>
      </div>
      <div id="grid" style="display:grid;width:480px">
        <p id="grid2" style="order:2">GRID2TOKEN this grid line is painted second.</p>
        <p id="grid1" style="order:1">GRID1TOKEN this grid line is painted first.</p>
      </div>
    </article>`,
  ),
);

todayPages.set(
  "caption-last.html",
  shell(
    "Caption",
    `<article>
      <h1>Parts</h1>
      <table>
        <tbody><tr><td id="body">BODYTOKEN the row the caption sits above.</td></tr></tbody>
        <caption id="cap">CAPTIONTOKEN the caption painted above that row.</caption>
      </table>
      <p>After the table the keeper closes the ledger and walks the dam.</p>
    </article>`,
  ),
);

todayPages.set(
  "dialog-page.html",
  shell(
    "Notice",
    `<dialog open id="notice">
      <h1>The notice</h1>
      <p>DIALOGTOKEN the notice is the only prose on the page and it is what the window is showing, a full account of the sluice, the wheel, and the brake.</p>
      <p>The keeper writes the hour in the ledger before the pond fills, then walks the length of the dam to check every peg.</p>
      <p>The elm bucket was cut from timber that has lain under water since the spring so it will not shrink in the frame.</p>
    </dialog>`,
  ),
);

todayPages.set(
  "section-link.html",
  shell(
    "Sections",
    `<article>
      <p>See section <a href="#brake">2</a> for the brake, and the pond still empties through the wheel twice a day.</p>
      <h2 id="brake">The brake</h2>
      <p>The brake is checked before the pond fills and the wheel starts to turn.</p>
    </article>`,
  ),
);

todayPages.set(
  "scaled-away.html",
  shell(
    "Scaled",
    `<article>
      <p>VISIBLETOKEN the paragraph on screen names the sluice, the wheel, and the brake.</p>
      <p id="gone" style="display:block;transform:scale(0);transform-origin:top left">SCALEDTOKEN this paragraph is scaled to nothing and is not on the page.</p>
    </article>`,
  ),
);

todayPages.set(
  "closed-light.html",
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Closed host</title></head><body>
    <article id="host"></article>
    <script>
      const host = document.getElementById("host");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = "<h1>Painted mill</h1><p>SHADOWTOKEN the words on screen are this shadow article about the sluice, the wheel, and the brake the keeper checks at dawn.</p><p>The painted paragraph goes on to the dam, the ledger, and the elm bucket cut in the spring.</p>";
      const hidden = document.createElement("p");
      hidden.id = "light";
      hidden.textContent = "LIGHTTOKEN these words are not painted, because the closed shadow does not slot them into the page.";
      host.append(hidden);
    </script>
  </body></html>`,
);

todayPages.set(
  "pre-wrap.html",
  shell(
    "Lines",
    `<article>
      <div id="poem" style="white-space:pre-wrap;width:520px">LINEONE the sluice was shut
LINETWO the brake was checked</div>
    </article>`,
  ),
);

todayPages.set(
  "opacity-guard.html",
  shell(
    "Opacity",
    `<article>
      <p>SEENTOKEN the visible sentence about the sluice is the one to read aloud.</p>
      <p style="opacity:0">HIDDENTOKEN this sentence is invisible and must stay silent.</p>
    </article>`,
  ),
);

export function todayScenarios(ctx) {
  const { SEED, applySettings, navigate, control, probe, until, sleep, requests, save, screenshot, evaluate } = ctx;

  async function spoken() {
    return (await requests()).map((entry) => entry.text).join("\n");
  }

  async function tops(ids) {
    return evaluate(`
      (() => {
        const out = {};
        for (const id of ${JSON.stringify(ids)}) {
          const el = document.getElementById(id);
          const rect = el?.getBoundingClientRect();
          out[id] = rect ? { top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) } : null;
        }
        return out;
      })()
    `);
  }

  return [
    {
      name: "longer-article-wins",
      bug: "A longer article outside main is read and the story in main is skipped",
      async run(repeat) {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate(`longer-main.html?seed=${SEED}&r=${repeat}`);
        const boxes = await tops(["story", "other"]);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("OTHERTKEN")) break;
          await sleep(150);
        }
        const storyFirst = boxes.story && boxes.other && boxes.story.top < boxes.other.top;
        const skipped = storyFirst && text.includes("OTHERTKEN") && !text.includes("STORYTOKEN") && playing.status === "playing";
        const path = save(`bug-longer-article-${repeat}.json`, {
          seed: SEED,
          boxes,
          status: playing.status,
          skipped,
          spoken: text.slice(0, 500),
        });
        if (skipped) {
          await screenshot(`bug-longer-article-${repeat}.png`);
          await screenshot("bug-longer-article.png");
          save("bug-longer-article.json", { seed: SEED, boxes, spoken: text.slice(0, 500) });
        }
        return {
          ok: skipped,
          detail: skipped
            ? `main at ${boxes.story.top}px was skipped; the longer article at ${boxes.other.top}px was spoken`
            : `status ${playing.status} storyFirst ${storyFirst} spoken ${text.slice(0, 120)}`,
          evidence: path,
        };
      },
    },
    {
      name: "flex-visual-order",
      bug: "Flex and grid order is read in source order, not the order on the page",
      async run(repeat) {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate(`flex-order.html?seed=${SEED}&r=${repeat}`);
        const boxes = await tops(["newest", "oldest", "order1", "order2", "grid1", "grid2"]);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("GRID1TOKEN") && text.includes("OLDESTTOKEN")) break;
          await sleep(150);
        }
        const columnReversed = boxes.oldest && boxes.newest && boxes.oldest.top < boxes.newest.top;
        const flexOrdered = boxes.order1 && boxes.order2 && boxes.order1.top < boxes.order2.top;
        const gridOrdered = boxes.grid1 && boxes.grid2 && boxes.grid1.top < boxes.grid2.top;
        const spokenBackwards =
          text.indexOf("NEWESTTOKEN") >= 0 &&
          text.indexOf("NEWESTTOKEN") < text.indexOf("OLDESTTOKEN") &&
          text.indexOf("ORDER2TOKEN") < text.indexOf("ORDER1TOKEN") &&
          text.indexOf("GRID2TOKEN") < text.indexOf("GRID1TOKEN");
        const reproduced = playing.status === "playing" && columnReversed && flexOrdered && gridOrdered && spokenBackwards;
        const path = save(`bug-flex-order-${repeat}.json`, {
          seed: SEED,
          boxes,
          columnReversed,
          flexOrdered,
          gridOrdered,
          spokenBackwards,
          spoken: text.slice(0, 600),
        });
        if (reproduced) {
          await screenshot(`bug-flex-order-${repeat}.png`);
          await screenshot("bug-flex-order.png");
          save("bug-flex-order.json", { seed: SEED, boxes, spoken: text.slice(0, 600) });
        }
        return {
          ok: reproduced,
          detail: reproduced
            ? `visual tops oldest ${boxes.oldest.top} < newest ${boxes.newest.top}, but newest was spoken first`
            : `status ${playing.status} layout ${columnReversed}/${flexOrdered}/${gridOrdered} spokenBackwards ${spokenBackwards}`,
          evidence: path,
        };
      },
    },
    {
      name: "caption-after-rows",
      bug: "A table caption is read after the rows it sits above",
      async run(repeat) {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate(`caption-last.html?seed=${SEED}&r=${repeat}`);
        const boxes = await tops(["cap", "body"]);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("BODYTOKEN") && text.includes("CAPTIONTOKEN")) break;
          await sleep(150);
        }
        const captionAbove = boxes.cap && boxes.body && boxes.cap.top < boxes.body.top;
        const spokenAfter = text.indexOf("BODYTOKEN") >= 0 && text.indexOf("BODYTOKEN") < text.indexOf("CAPTIONTOKEN");
        const reproduced = playing.status === "playing" && captionAbove && spokenAfter;
        const path = save(`bug-caption-order-${repeat}.json`, {
          seed: SEED,
          boxes,
          captionAbove,
          spokenAfter,
          spoken: text.slice(0, 400),
        });
        if (reproduced) {
          await screenshot(`bug-caption-order-${repeat}.png`);
          await screenshot("bug-caption-order.png");
          save("bug-caption-order.json", { seed: SEED, boxes, spoken: text.slice(0, 400) });
        }
        return {
          ok: reproduced,
          detail: reproduced
            ? `caption at ${boxes.cap.top}px is above the row at ${boxes.body.top}px and was spoken after it`
            : `status ${playing.status} above ${captionAbove} after ${spokenAfter}`,
          evidence: path,
        };
      },
    },
    {
      name: "dialog-page-empty",
      bug: "An open dialog that holds the page is read as empty",
      async run(repeat) {
        await applySettings({ chunkChars: 4000 });
        await navigate(`dialog-page.html?seed=${SEED}&r=${repeat}`);
        const box = await evaluate(`
          (() => {
            const el = document.getElementById("notice");
            const rect = el?.getBoundingClientRect();
            const shown = el?.open === true && (el.innerText || "").includes("DIALOGTOKEN");
            return { shown, top: rect ? Math.round(rect.top) : null, height: rect ? Math.round(rect.height) : 0, width: rect ? Math.round(rect.width) : 0 };
          })()
        `);
        const started = await control("start", { scope: "page", from: "start" });
        const state = started?.state || {};
        await sleep(300);
        const sample = await probe();
        const text = await spoken();
        const reproduced =
          box.shown &&
          box.height > 40 &&
          state.status === "error" &&
          /readable text/i.test(state.error || "") &&
          !text.includes("DIALOGTOKEN") &&
          sample.paused !== false;
        const path = save(`bug-dialog-empty-${repeat}.json`, {
          seed: SEED,
          box,
          status: state.status,
          error: state.error || "",
          paused: sample.paused,
          spoken: text.slice(0, 200),
        });
        if (reproduced) {
          await screenshot(`bug-dialog-empty-${repeat}.png`);
          await screenshot("bug-dialog-empty.png");
          save("bug-dialog-empty.json", { seed: SEED, box, error: state.error || "" });
        }
        return {
          ok: reproduced,
          detail: reproduced
            ? `dialog is ${box.width}×${box.height} and on screen; read ended with "${state.error}"`
            : `status ${state.status} box ${JSON.stringify(box)} error ${state.error || ""} spoken ${text.slice(0, 80)}`,
          evidence: path,
        };
      },
    },
    {
      name: "section-number-dropped",
      bug: "A same-page link that is only a number is dropped from the sentence",
      async run(repeat) {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate(`section-link.html?seed=${SEED}&r=${repeat}`);
        const link = await evaluate(`
          (() => {
            const el = document.querySelector("a[href='#brake']");
            return { text: el?.textContent || "", href: el?.getAttribute("href") || "" };
          })()
        `);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("See section")) break;
          await sleep(150);
        }
        const dropped = link.text === "2" && text.includes("See section for the brake") && !/section 2/.test(text);
        const reproduced = playing.status === "playing" && dropped;
        const path = save(`bug-section-number-${repeat}.json`, {
          seed: SEED,
          link,
          dropped,
          spoken: text.slice(0, 400),
        });
        if (reproduced) {
          await screenshot(`bug-section-number-${repeat}.png`);
          await screenshot("bug-section-number.png");
          save("bug-section-number.json", { seed: SEED, link, spoken: text.slice(0, 400) });
        }
        return {
          ok: reproduced,
          detail: reproduced
            ? `the link text is "2" and the sentence was spoken as "See section for the brake"`
            : `status ${playing.status} link ${JSON.stringify(link)} spoken ${text.slice(0, 160)}`,
          evidence: path,
        };
      },
    },
    {
      name: "scaled-text-read",
      bug: "Text scaled to nothing is still read aloud",
      async run(repeat) {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate(`scaled-away.html?seed=${SEED}&r=${repeat}`);
        const box = await evaluate(`
          (() => {
            const el = document.getElementById("gone");
            const rect = el.getBoundingClientRect();
            return { height: Math.round(rect.height), width: Math.round(rect.width), text: el.textContent };
          })()
        `);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("VISIBLETOKEN") && text.includes("SCALEDTOKEN")) break;
          await sleep(150);
        }
        const reproduced =
          playing.status === "playing" && box.height === 0 && box.width === 0 && text.includes("SCALEDTOKEN") && text.includes("VISIBLETOKEN");
        const path = save(`bug-scaled-text-${repeat}.json`, {
          seed: SEED,
          box,
          status: playing.status,
          spoken: text.slice(0, 400),
        });
        if (reproduced) {
          await screenshot(`bug-scaled-text-${repeat}.png`);
          await screenshot("bug-scaled-text.png");
          save("bug-scaled-text.json", { seed: SEED, box, spoken: text.slice(0, 400) });
        }
        return {
          ok: reproduced,
          detail: reproduced
            ? `the scaled paragraph is ${box.width}×${box.height} and was still sent to be spoken`
            : `status ${playing.status} box ${JSON.stringify(box)} spoken ${text.slice(0, 140)}`,
          evidence: path,
        };
      },
    },
    {
      name: "closed-shadow-light",
      bug: "A closed shadow host reads hidden light text instead of the words on screen",
      async run(repeat) {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate(`closed-light.html?seed=${SEED}&r=${repeat}`);
        const boxes = await evaluate(`
          (() => {
            const host = document.getElementById("host");
            const light = document.getElementById("light");
            const hostRect = host.getBoundingClientRect();
            const lightRect = light.getBoundingClientRect();
            return {
              host: { height: Math.round(hostRect.height), width: Math.round(hostRect.width) },
              light: { height: Math.round(lightRect.height), width: Math.round(lightRect.width), text: light.textContent.slice(0, 24) },
              shadowOpen: Boolean(host.shadowRoot),
            };
          })()
        `);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("LIGHTTOKEN") || text.includes("SHADOWTOKEN") || playing.status === "error") break;
          await sleep(150);
        }
        const reproduced =
          playing.status === "playing" &&
          boxes.shadowOpen === false &&
          boxes.host.height > 10 &&
          boxes.light.height === 0 &&
          text.includes("LIGHTTOKEN") &&
          !text.includes("SHADOWTOKEN");
        const path = save(`bug-closed-shadow-${repeat}.json`, {
          seed: SEED,
          boxes,
          status: playing.status,
          spoken: text.slice(0, 400),
        });
        if (reproduced) {
          await screenshot(`bug-closed-shadow-${repeat}.png`);
          await screenshot("bug-closed-shadow.png");
          save("bug-closed-shadow.json", { seed: SEED, boxes, spoken: text.slice(0, 400) });
        }
        return {
          ok: reproduced,
          detail: reproduced
            ? `host is ${boxes.host.height}px tall on screen; the unspoken shadow text was replaced by the 0×0 light node`
            : `status ${playing.status} boxes ${JSON.stringify(boxes)} spoken ${text.slice(0, 140)}`,
          evidence: path,
        };
      },
    },
    {
      name: "preserved-break-collapsed",
      bug: "A preserved line break is spoken as a space",
      async run(repeat) {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate(`pre-wrap.html?seed=${SEED}&r=${repeat}`);
        const lines = await evaluate(`
          (() => {
            const el = document.getElementById("poem");
            const style = getComputedStyle(el).whiteSpace;
            const node = el.firstChild;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = [...range.getClientRects()].filter((rect) => rect.width > 2 && rect.height > 2);
            const tops = rects.map((rect) => Math.round(rect.top));
            return { whiteSpace: style, tops, text: node.data };
          })()
        `);
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("LINEONE") && text.includes("LINETWO")) break;
          await sleep(150);
        }
        const twoLines = lines.whiteSpace === "pre-wrap" && lines.text.includes("\n") && new Set(lines.tops).size >= 2;
        const collapsed = /LINEONE the sluice was shut LINETWO the brake was checked/.test(text) && !/LINEONE the sluice was shut\nLINETWO/.test(text);
        const reproduced = playing.status === "playing" && twoLines && collapsed;
        const path = save(`bug-preserved-break-${repeat}.json`, {
          seed: SEED,
          lines,
          twoLines,
          collapsed,
          spoken: text.slice(0, 300),
        });
        if (reproduced) {
          await screenshot(`bug-preserved-break-${repeat}.png`);
          await screenshot("bug-preserved-break.png");
          save("bug-preserved-break.json", { seed: SEED, lines, spoken: text.slice(0, 300) });
        }
        return {
          ok: reproduced,
          detail: reproduced
            ? `two painted lines at ${lines.tops.join(" and ")}px were spoken as one sentence`
            : `status ${playing.status} lines ${JSON.stringify(lines)} spoken ${JSON.stringify(text.slice(0, 160))}`,
          evidence: path,
        };
      },
    },
    {
      name: "today-guards",
      async run() {
        await applySettings({ chunkChars: 4000, autoScroll: false });
        await navigate("opacity-guard.html");
        await control("start", { scope: "page", from: "start" });
        const playing = await until((sample) => sample.status === "playing" || sample.status === "error", 12000);
        let text = "";
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          text = await spoken();
          if (text.includes("SEENTOKEN")) break;
          await sleep(150);
        }
        if (playing.status !== "playing") return { ok: false, detail: `opacity guard ${playing.status} ${playing.error}` };
        if (!text.includes("SEENTOKEN")) return { ok: false, detail: "visible sentence was skipped" };
        if (text.includes("HIDDENTOKEN")) return { ok: false, detail: "opacity 0 text was read" };
        return { ok: true, detail: "opacity 0 stayed silent and the visible sentence was read" };
      },
    },
  ];
}
