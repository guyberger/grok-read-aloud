/**
 * The playback transport: every command has one answer in every status.
 *
 * The reader applies these answers to the engine. What belongs here is the
 * decision itself — a pause during a load stays a pause, a chunk that arrives
 * afterwards does not start, and a failed request silences whatever is still
 * playing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadContentNamespace } from "./load-content.js";

const { createTransport, statuses } = loadContentNamespace(["util.js", "transport.js"]).transport;

const COMMANDS = [
  { type: "reset" },
  { type: "stop" },
  { type: "commit" },
  { type: "load" },
  { type: "pause" },
  { type: "resume" },
  { type: "jump" },
  { type: "chunkReady" },
  { type: "fail" },
  { type: "finish" },
  { type: "yield" },
  { type: "voice" },
  { type: "rate" },
];

function fresh() {
  return createTransport();
}

/** Put a transport into `status` and return the generation that owns it. */
function enter(status) {
  const transport = fresh();
  switch (status) {
    case "idle":
      return transport;
    case "loading":
      transport.dispatch({ type: "load" });
      return transport;
    case "playing": {
      transport.dispatch({ type: "load" });
      transport.dispatch({ type: "chunkReady", generation: transport.generation });
      return transport;
    }
    case "paused":
      transport.dispatch({ type: "load" });
      transport.dispatch({ type: "pause" });
      return transport;
    case "error":
      transport.dispatch({ type: "load" });
      transport.dispatch({ type: "fail", generation: transport.generation });
      return transport;
    default: {
      const unexpected = status;
      throw new Error(`Unhandled playback status ${unexpected}`);
    }
  }
}

test("every command is defined for every status", () => {
  for (const status of statuses) {
    for (const command of COMMANDS) {
      const transport = enter(status);
      const generation = transport.generation;
      const payload =
        command.type === "chunkReady" || command.type === "fail" ? { ...command, generation } : command;
      const outcome = transport.dispatch(payload);
      assert.ok(statuses.includes(outcome.status), `${status} + ${command.type} → ${outcome.status}`);
      assert.ok(["none", "pause", "stop", "play"].includes(outcome.engine), outcome.engine);
      assert.equal(transport.status, outcome.status);
    }
  }
});

test("an unknown command is refused", () => {
  const transport = fresh();
  assert.throws(() => transport.dispatch({ type: "seek" }), /Unknown transport command/);
});

test("pause during a load stays paused and the arriving chunk does not start", () => {
  const transport = fresh();
  transport.dispatch({ type: "load" });
  const paused = transport.dispatch({ type: "pause" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.held, true);
  assert.equal(paused.engine, "pause");

  // The generation bump that commits a start must not forget the pause.
  transport.dispatch({ type: "commit" });
  assert.equal(transport.status, "paused");
  assert.equal(transport.held, true);

  const ready = transport.dispatch({ type: "chunkReady", generation: transport.generation });
  assert.equal(ready.status, "paused");
  assert.equal(ready.engine, "none");
  assert.equal(ready.audible, true);
  assert.equal(transport.status, "paused");
});

test("resume before the chunk arrives waits, and resume after it plays", () => {
  const waiting = fresh();
  waiting.dispatch({ type: "load" });
  waiting.dispatch({ type: "pause" });
  const backToLoading = waiting.dispatch({ type: "resume" });
  assert.equal(backToLoading.status, "loading");
  assert.equal(backToLoading.engine, "none");
  const started = waiting.dispatch({ type: "chunkReady", generation: waiting.generation });
  assert.equal(started.status, "playing");
  assert.equal(started.engine, "play");

  const held = fresh();
  held.dispatch({ type: "load" });
  held.dispatch({ type: "pause" });
  held.dispatch({ type: "chunkReady", generation: held.generation });
  const resumed = held.dispatch({ type: "resume" });
  assert.equal(resumed.status, "playing");
  assert.equal(resumed.engine, "play");
});

test("a voice or speed change does not retarget the chunk in flight", () => {
  const transport = enter("loading");
  const generation = transport.generation;
  for (const type of ["voice", "rate"]) {
    const outcome = transport.dispatch({ type });
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.engine, "none");
    assert.equal(transport.status, "loading");
    assert.equal(transport.generation, generation);
  }
});

test("a stale chunk or a stale failure does not move the read", () => {
  const transport = enter("playing");
  const stale = transport.generation;
  transport.dispatch({ type: "jump" });
  assert.equal(transport.status, "loading");

  const ready = transport.dispatch({ type: "chunkReady", generation: stale });
  assert.equal(ready.accepted, false);
  assert.equal(transport.status, "loading");

  const failed = transport.dispatch({ type: "fail", generation: stale });
  assert.equal(failed.accepted, false);
  assert.equal(transport.status, "loading");
});

test("a failed request pauses the engine and asks for the highlight to catch up", () => {
  for (const status of ["loading", "playing", "paused"]) {
    const transport = enter(status);
    const failed = transport.dispatch({ type: "fail", generation: transport.generation });
    assert.equal(failed.accepted, true, status);
    assert.equal(failed.status, "error", status);
    assert.equal(failed.engine, "pause", status);
    assert.equal(failed.syncHighlight, true, status);
  }
});

test("pause from error still silences the engine", () => {
  const transport = enter("error");
  const paused = transport.dispatch({ type: "pause" });
  assert.equal(paused.accepted, true);
  assert.equal(paused.status, "error");
  assert.equal(paused.engine, "pause");
  assert.equal(paused.syncHighlight, true);
});

test("stop from error ends the read", () => {
  const transport = enter("error");
  const stopped = transport.dispatch({ type: "stop" });
  assert.equal(stopped.status, "idle");
  assert.equal(stopped.engine, "stop");
  assert.equal(stopped.accepted, true);
});

test("a jump while paused asks to play from the new place", () => {
  const transport = enter("paused");
  const jumped = transport.dispatch({ type: "jump" });
  assert.equal(jumped.accepted, true);
  assert.equal(jumped.status, "loading");
  assert.equal(jumped.held, false);
  const ready = transport.dispatch({ type: "chunkReady", generation: transport.generation });
  assert.equal(ready.status, "playing");
  assert.equal(ready.engine, "play");
});

test("yielding while loading leaves the read to claim itself when it speaks", () => {
  const transport = enter("loading");
  const yielded = transport.dispatch({ type: "yield" });
  assert.equal(yielded.accepted, false);
  assert.equal(transport.status, "loading");
  assert.equal(transport.held, false);
});

test("a chunk that arrives with nothing willing to play it does not start", () => {
  const transport = enter("loading");
  const generation = transport.generation;
  transport.dispatch({ type: "stop" });
  const ready = transport.dispatch({ type: "chunkReady", generation });
  assert.equal(ready.accepted, false);
  assert.equal(ready.engine, "none");
  assert.equal(transport.status, "idle");
});
