// Generates icons/icon-{16,48,128}.png — a black robot silhouette with two
// eyes and a smile, on a transparent background. 4x supersampled for clean
// antialiased edges at 16px. No deps.
//
// Run with: node scripts/make-icons.js

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 48, 128];
const SUPERSAMPLE = 4;

const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

// ---- drawing -----------------------------------------------------------

function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const ss = SUPERSAMPLE;
  const ss2 = ss * ss;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size;
          const ny = (y + (sy + 0.5) / ss) / size;
          const c = robotColorAt(nx, ny);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const i = (y * size + x) * 4;
      px[i]     = Math.round(r / ss2);
      px[i + 1] = Math.round(g / ss2);
      px[i + 2] = Math.round(b / ss2);
      px[i + 3] = Math.round(a / ss2);
    }
  }
  return px;
}

// Returns the RGBA color at normalized position (nx, ny) ∈ [0,1].
// Layered painter's algorithm: later layers overwrite earlier.
function robotColorAt(nx, ny) {
  let color = CLEAR;

  // Antenna ball (circle at top center).
  if (inCircle(nx, ny, 0.50, 0.08, 0.060)) color = BLACK;

  // Antenna stem (vertical bar from ball to head top).
  if (inRect(nx, ny, 0.485, 0.08, 0.515, 0.27)) color = BLACK;

  // Left ear (rounded pill).
  if (inRoundedRect(nx, ny, 0.040, 0.50, 0.180, 0.78, 0.055)) color = BLACK;

  // Right ear (rounded pill).
  if (inRoundedRect(nx, ny, 0.820, 0.50, 0.960, 0.78, 0.055)) color = BLACK;

  // Head (rounded square).
  const inHead = inRoundedRect(nx, ny, 0.18, 0.27, 0.82, 0.95, 0.10);
  if (inHead) color = BLACK;

  // Eyes — only inside the head silhouette.
  if (inHead) {
    const eyeR  = 0.090;
    const pupilR = 0.030;
    const eyes = [[0.36, 0.55], [0.64, 0.55]];
    for (const [ex, ey] of eyes) {
      if (inCircle(nx, ny, ex, ey, eyeR)) color = WHITE;
      if (inCircle(nx, ny, ex, ey, pupilR)) color = BLACK;
    }

    // Smile — a thick lower-half arc (crescent).
    const mx = 0.50, my = 0.68;
    const dx = nx - mx, dy = ny - my;
    const d = Math.hypot(dx, dy);
    if (dy > 0.015 && d >= 0.140 && d <= 0.180) color = WHITE;
  }

  return color;
}

// ---- shape helpers -----------------------------------------------------

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRect(x, y, x1, y1, x2, y2) {
  return x >= x1 && x <= x2 && y >= y1 && y <= y2;
}

function inRoundedRect(x, y, x1, y1, x2, y2, r) {
  if (x < x1 || x > x2 || y < y1 || y > y2) return false;
  // Inside the cross-shaped union of two non-corner rectangles → trivially in.
  if (x >= x1 + r && x <= x2 - r) return true;
  if (y >= y1 + r && y <= y2 - r) return true;
  // Otherwise we're in a corner cell — must be within r of the corner anchor.
  const cx = x < x1 + r ? x1 + r : x2 - r;
  const cy = y < y1 + r ? y1 + r : y2 - r;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// ---- PNG encoder (RGBA, 8-bit, no filter) ------------------------------

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 6;  // color type RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filter
  ihdr[12] = 0;  // no interlace

  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter byte: none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * stride + 1 + x * 4;
      raw[dst]     = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function main() {
  for (const size of SIZES) {
    const png = encodePng(size, size, drawIcon(size));
    writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), png);
    console.log(`icons/icon-${size}.png (${png.length} bytes)`);
  }
}

main();
