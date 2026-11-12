(function (ns) {
  "use strict";

  /**
   * Speed without pitch.
   *
   * Playing samples faster raises the voice (Web Audio's `playbackRate`), and
   * the media element's own pitch-keeping stretch warbles from about 1.5× up.
   * So neither engine is ever asked to change speed: the decoded audio is
   * time-stretched here, once per rate, and played back at 1×.
   *
   * The stretch is WSOLA — the same family as SoundTouch's. The output is
   * built from overlapping 30 ms windows of the input, taken `rate` times
   * further apart than they are laid down. Each window is nudged by up to
   * 12 ms to wherever the input lines up best with the window before it, so
   * the waveform stays continuous and every pitch period keeps its length.
   * Output second `t` is input second `t × rate`, give or take that nudge,
   * which is what keeps the timestamps (and the highlight) right.
   *
   * It runs in slices that hand the thread back every few milliseconds, so the
   * page stays responsive. A worker would be better still, but a content
   * script can only start one from the page's own origin or a blob URL, and
   * the pages that need the Web Audio fallback are exactly the ones that
   * refuse blob URLs.
   */

  /** What speech is decoded at: the rate the API is asked for (tts-client.js). */
  const SPEECH_SAMPLE_RATE = 24000;
  const FRAME_SECONDS = 0.03;
  const SEEK_SECONDS = 0.012;
  /** Every how many samples the coarse search looks. */
  const COARSE = 4;
  /** How long a slice runs before handing the thread back. */
  const SLICE_MS = 8;

  /** Close enough to 1× that the original audio is what plays. */
  function isUnity(rate) {
    return Math.abs(rate - 1) < 0.005;
  }

  /**
   * A generator that does the work, yielding now and then so a caller can
   * pause it; its return value is the stretched audio. `stretchSync` and
   * `stretch` drive it.
   */
  function* stretchSteps(input, rate, sampleRate) {
    if (!(rate > 0)) throw new RangeError(`bad rate ${rate}`);
    if (isUnity(rate) || input.length === 0) return Float32Array.from(input);

    const half = Math.max(16, Math.round((sampleRate * FRAME_SECONDS) / 2));
    const size = half * 2;
    const seek = Math.max(COARSE, Math.round(sampleRate * SEEK_SECONDS));
    const outLength = Math.max(1, Math.round(input.length / rate));

    // Zero padding on both sides keeps every read in bounds without a check.
    const pad = size + 2 * seek + half;
    const source = new Float32Array(input.length + 2 * pad);
    source.set(input, pad);

    const window = new Float32Array(size);
    for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);

    const out = new Float32Array(outLength + size);
    const last = input.length + seek;
    let previous = 0;

    for (let frame = 0; frame * half < outLength; frame += 1) {
      const nominal = Math.round(frame * half * rate);
      let position = nominal;
      if (frame > 0) position = bestMatch(source, pad, previous + half, nominal, seek, size, last);

      const at = frame * half;
      const from = pad + position;
      // The first frame has nothing before it to fade in against.
      for (let i = 0; i < size; i += 1) {
        const weight = frame === 0 && i < half ? 1 : window[i];
        out[at + i] += source[from + i] * weight;
      }
      previous = position;
      if (frame % 32 === 31) yield frame;
    }
    return out.subarray(0, outLength);
  }

  /**
   * Where near `nominal` the input best continues the previous window, which
   * would have gone on at `natural`: a coarse pass over every COARSE-th sample
   * and offset, then a fine one around the winner.
   */
  function bestMatch(source, pad, natural, nominal, seek, size, last) {
    const template = pad + natural;
    let templateEnergy = 0;
    for (let i = 0; i < size; i += COARSE) templateEnergy += source[template + i] * source[template + i];
    // Silence lines up with anything; stay on time.
    if (templateEnergy < 1e-9) return nominal;

    const low = Math.max(-seek, -nominal);
    const high = Math.min(seek, last - nominal);
    let best = 0;
    let bestScore = -Infinity;
    const score = (offset, step) => {
      const start = pad + nominal + offset;
      let dot = 0;
      let energy = 1e-12;
      for (let i = 0; i < size; i += step) {
        const sample = source[start + i];
        dot += sample * source[template + i];
        energy += sample * sample;
      }
      return dot / Math.sqrt(energy);
    };
    for (let offset = low; offset <= high; offset += COARSE) {
      const value = score(offset, COARSE);
      if (value > bestScore) {
        bestScore = value;
        best = offset;
      }
    }
    const coarse = best;
    bestScore = -Infinity;
    for (let offset = Math.max(low, coarse - COARSE + 1); offset <= Math.min(high, coarse + COARSE - 1); offset += 1) {
      const value = score(offset, 2);
      if (value > bestScore) {
        bestScore = value;
        best = offset;
      }
    }
    return nominal + best;
  }

  function stretchSync(input, rate, sampleRate) {
    const steps = stretchSteps(input, rate, sampleRate);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  const now = () => globalThis.performance?.now() ?? Date.now();
  const yieldThread = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * The same stretch, in slices of a few milliseconds. `isCancelled` is asked
   * between slices; a stretch nobody wants any more stops with null.
   */
  async function stretch(input, rate, sampleRate, { isCancelled } = {}) {
    const steps = stretchSteps(input, rate, sampleRate);
    let sliceStart = now();
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      if (now() - sliceStart >= SLICE_MS) {
        await yieldThread();
        if (isCancelled?.()) return null;
        sliceStart = now();
      }
    }
  }

  /** Mono 16-bit PCM WAV, which every media element plays. */
  function encodeWav(samples, sampleRate) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
      view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
    }
    return bytes;
  }

  /** Decoded audio, by the bytes it came from — shared by both engines. */
  const decoded = new WeakMap();
  /** Stretched audio, by those same bytes and then by rate. Two rates each. */
  const stretched = new WeakMap();

  /** Mono samples at the speech rate, decoded once per set of bytes. */
  function decode(bytes) {
    let pending = decoded.get(bytes);
    if (!pending) {
      pending = (async () => {
        const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
        const context = new Offline(1, 1, SPEECH_SAMPLE_RATE);
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const buffer = await context.decodeAudioData(copy);
        let samples = buffer.getChannelData(0);
        if (buffer.numberOfChannels > 1) {
          samples = Float32Array.from(samples);
          for (let channel = 1; channel < buffer.numberOfChannels; channel += 1) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < samples.length; i += 1) samples[i] += data[i];
          }
          for (let i = 0; i < samples.length; i += 1) samples[i] /= buffer.numberOfChannels;
        }
        return { samples, sampleRate: buffer.sampleRate, duration: samples.length / buffer.sampleRate };
      })();
      decoded.set(bytes, pending);
      pending.catch(() => decoded.delete(bytes));
    }
    return pending;
  }

  /**
   * The audio in `bytes` at `rate`, pitch untouched: `{ samples, sampleRate,
   * rate }`, or null if it was cancelled first. Rendered once per rate.
   */
  async function render(bytes, rate, { isCancelled } = {}) {
    const audio = await decode(bytes);
    if (isUnity(rate)) return { samples: audio.samples, sampleRate: audio.sampleRate, rate: 1 };
    const byRate = stretched.get(bytes) ?? new Map();
    stretched.set(bytes, byRate);
    const key = rate.toFixed(3);
    let samples = byRate.get(key);
    if (!samples) {
      if (isCancelled?.()) return null;
      samples = await stretch(audio.samples, rate, audio.sampleRate, { isCancelled });
      if (!samples) return null;
      byRate.delete(key);
      byRate.set(key, samples);
      while (byRate.size > 2) byRate.delete(byRate.keys().next().value);
    }
    return { samples, sampleRate: audio.sampleRate, rate };
  }

  ns.stretch = { SPEECH_SAMPLE_RATE, isUnity, stretchSync, stretch, encodeWav, decode, render };
})(globalThis.__readAloud || (globalThis.__readAloud = {}));
