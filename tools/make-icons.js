/**
 * Draws the extension icons and writes them as PNGs. Run with `npm run icons`
 * after changing the artwork; the generated files are committed so a plain
 * `npm run build` needs no extra step.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/icons");
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const BACKGROUND = [79, 70, 229];
const FOREGROUND = [255, 255, 255];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed distance from a point to a rounded rectangle, in unit coordinates. */
function roundedRect(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

function insideTriangle(x, y) {
  // Play head pointing right, inside the left half of the glyph area.
  if (x < -0.34 || x > -0.02) return false;
  const height = 0.3 * (1 - (x + 0.34) / 0.32);
  return Math.abs(y) <= height + 0.02;
}

function insideArc(x, y, radius, thickness) {
  if (x < 0.02) return false;
  const distance = Math.hypot(x + 0.06, y);
  return Math.abs(distance - radius) <= thickness / 2 && x + 0.06 >= distance * 0.42;
}

function sample(x, y) {
  if (roundedRect(x, y, 0.94, 0.3) > 0) return null;
  if (insideTriangle(x, y)) return FOREGROUND;
  if (insideArc(x, y, 0.3, 0.1) || insideArc(x, y, 0.52, 0.1)) return FOREGROUND;
  return BACKGROUND;
}

function render(size) {
  const dimension = size * SUPERSAMPLE;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = ((px * SUPERSAMPLE + sx + 0.5) / dimension) * 2 - 1;
          const y = ((py * SUPERSAMPLE + sy + 0.5) / dimension) * 2 - 1;
          const colour = sample(x, y);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (py * size + px) * 4;
      const covered = a / 255;
      rgba[offset] = covered ? Math.round(r / covered) : 0;
      rgba[offset + 1] = covered ? Math.round(g / covered) : 0;
      rgba[offset + 2] = covered ? Math.round(b / covered) : 0;
      rgba[offset + 3] = Math.round(a / samples);
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote icons/icon-${size}.png`);
}
