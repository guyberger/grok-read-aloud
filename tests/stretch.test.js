/**
 * The speed control's red line: a voice sped up or slowed down must stay at
 * the pitch it was recorded at. These feed tones through the stretcher at the
 * rates the slider reaches and measure what comes out.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadContentNamespace } from "./load-content.js";

const { stretch } = loadContentNamespace(["util.js", "stretch.js"], { setTimeout, performance });

const SAMPLE_RATE = 24000;

function tone(hz, seconds, harmonics = [1]) {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i += 1) {
    let value = 0;
    harmonics.forEach((gain, index) => {
      value += gain * Math.sin((2 * Math.PI * hz * (index + 1) * i) / SAMPLE_RATE);
    });
    samples[i] = 0.4 * value;
  }
  return samples;
}

/** The strongest frequency between `low` and `high`, to a tenth of a hertz. */
function dominantFrequency(samples, low = 50, high = 2000) {
  // The middle of the signal, clear of the edges, through a Hann window.
  const length = Math.min(samples.length, SAMPLE_RATE);
  const start = Math.floor((samples.length - length) / 2);
  const windowed = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    windowed[i] = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length));
  }
  const power = (hz) => {
    let re = 0;
    let im = 0;
    const step = (2 * Math.PI * hz) / SAMPLE_RATE;
    for (let i = 0; i < length; i += 1) {
      re += windowed[i] * Math.cos(step * i);
      im += windowed[i] * Math.sin(step * i);
    }
    return re * re + im * im;
  };
  let best = low;
  let bestPower = -1;
  for (let hz = low; hz <= high; hz += 2) {
    const p = power(hz);
    if (p > bestPower) [best, bestPower] = [hz, p];
  }
  for (let hz = best - 2; hz <= best + 2; hz += 0.1) {
    const p = power(hz);
    if (p > bestPower) [best, bestPower] = [hz, p];
  }
  return best;
}

const rms = (samples) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);

for (const rate of [0.5, 0.75, 1.5, 2, 3]) {
  for (const hz of [140, 220, 440]) {
    test(`a ${hz} Hz tone at ${rate}x keeps its pitch and lasts 1/${rate} as long`, () => {
      const input = tone(hz, 2);
      const output = stretch.stretchSync(input, rate, SAMPLE_RATE);

      const measured = dominantFrequency(output);
      const deviation = Math.abs(measured - hz) / hz;
      assert.ok(deviation < 0.02, `${hz} Hz came out at ${measured.toFixed(1)} Hz (${(deviation * 100).toFixed(2)}%)`);

      const expected = input.length / rate;
      assert.ok(Math.abs(output.length - expected) <= 1, `${output.length} samples, wanted ${expected}`);
    });
  }
}

test("a voice-like tone keeps its fundamental and its loudness at 2x", () => {
  // A 120 Hz fundamental with the falling harmonics of a voiced vowel.
  const input = tone(120, 2, [1, 0.6, 0.4, 0.25, 0.15]);
  const output = stretch.stretchSync(input, 2, SAMPLE_RATE);
  const measured = dominantFrequency(output, 60, 200);
  assert.ok(Math.abs(measured - 120) / 120 < 0.02, `fundamental came out at ${measured.toFixed(1)} Hz`);
  const ratio = rms(output.subarray(2400, -2400)) / rms(input.subarray(2400, -2400));
  assert.ok(ratio > 0.9 && ratio < 1.1, `loudness changed by ${ratio.toFixed(3)}x`);
});

test("output time t is input time t × rate, near enough to keep the highlight on the word", () => {
  // A click every quarter second; where each click lands says where the
  // input time went.
  const input = new Float32Array(SAMPLE_RATE * 2);
  const clicks = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75];
  for (const at of clicks) {
    for (let i = 0; i < 240; i += 1) input[Math.round(at * SAMPLE_RATE) + i] = Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE);
  }
  for (const rate of [0.75, 1.5, 2]) {
    const output = stretch.stretchSync(input, rate, SAMPLE_RATE);
    for (const at of clicks) {
      const expected = Math.round((at / rate) * SAMPLE_RATE);
      let peak = expected;
      for (let i = expected - 1200; i < expected + 1200; i += 1) {
        if (Math.abs(output[i] ?? 0) > Math.abs(output[peak] ?? 0)) peak = i;
      }
      const errorMs = (Math.abs(peak - expected) / SAMPLE_RATE) * 1000;
      assert.ok(errorMs < 30, `at ${rate}x the click at ${at}s moved ${errorMs.toFixed(1)} ms`);
    }
  }
});

test("1x is the audio untouched", () => {
  const input = tone(300, 0.5);
  assert.deepEqual([...stretch.stretchSync(input, 1, SAMPLE_RATE)], [...input]);
});

test("the sliced stretch gives the same audio as the one-shot, and can be called off", async () => {
  const input = tone(200, 3);
  const sliced = await stretch.stretch(input, 1.7, SAMPLE_RATE);
  assert.deepEqual([...sliced], [...stretch.stretchSync(input, 1.7, SAMPLE_RATE)]);

  let asked = 0;
  const cancelled = await stretch.stretch(tone(200, 60), 1.3, SAMPLE_RATE, { isCancelled: () => ++asked > 0 });
  assert.equal(cancelled, null);
});

test("a WAV of the stretched audio says what it holds", () => {
  const wav = stretch.encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), SAMPLE_RATE);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint32(40, true), 10);
  assert.equal(view.getInt16(44 + 3 * 2, true), 32767);
});
