// Original Jev X Blocker icon generator.
//
// Pure-software rasterizer: signed-distance shapes + gradients rendered with
// 4x4 supersampling and box-filtered down to 16/32/48/128 PNGs (RGBA).
// Replaces the inherited elons-job emoji icon with a bespoke "block" mark:
// dark rounded square, cyan->blue gradient ring, white block bar.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA8, filter type 0)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;

function mix3(c1, c2, c3, t) {
  if (t < 0.5) {
    const k = t * 2;
    return [mix(c1[0], c2[0], k), mix(c1[1], c2[1], k), mix(c1[2], c2[2], k)];
  }
  const k = (t - 0.5) * 2;
  return [mix(c2[0], c3[0], k), mix(c2[1], c3[1], k), mix(c2[2], c3[2], k)];
}

function sdRoundRect(x, y, hx, hy, r) {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

// One sample at unit-space (x, y) in [-0.5, 0.5]. Painter's algorithm.
function sample(x, y) {
  const bg = sdRoundRect(x, y, 0.475, 0.475, 0.115);
  if (bg > 0) return [0, 0, 0, 0];

  // Background: deep navy vertical gradient + blue core glow.
  const ty = clamp01(y + 0.5);
  let col = mix3([21, 32, 58], [6, 10, 22], ty, 0);
  const glow = Math.exp(-(x * x + y * y) / 0.05) * 0.26;
  col = [col[0] + glow * 30, col[1] + glow * 96, col[2] + glow * 210];

  // Thin top-edge highlight for a machined feel.
  const edge = clamp01((bg + 0.055) / 0.055);
  if (y < -0.05) {
    const lift = (1 - edge) * 30;
    col = [col[0] + lift, col[1] + lift, col[2] + lift * 1.1];
  }

  // Gradient ring (the "block" circle): sky -> blue -> violet.
  const ring = Math.abs(Math.hypot(x, y) - 0.295) - 0.05;
  const gt = clamp01(((x + y) + 0.45) / 0.9);
  const ringCol = mix3([125, 211, 252], [59, 130, 246], [76, 29, 149], gt, 0);
  if (ring <= 0) col = ringCol;

  // White block bar at -45 degrees, ends tucked into the ring.
  const c = Math.SQRT1_2;
  const u = x * c + y * c;
  const v = -x * c + y * c;
  const bar = sdRoundRect(u, v, 0.272, 0.054, 0.052);
  if (bar <= 0) col = [247, 250, 255];

  return [col[0], col[1], col[2], 255];
}

function render(size) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size - 0.5;
          const y = (py + (sy + 0.5) / SS) / size - 0.5;
          const [cr, cg, cb, ca] = sample(x, y);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

mkdirSync(resolve(ROOT, 'assets'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, size, render(size));
  const file = resolve(ROOT, 'assets', `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
