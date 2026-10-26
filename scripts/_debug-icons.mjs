// Original Jev X Blocker icon generator — v2 "shield & bar".
//
// Pure-software rasterizer: signed-distance field rendering with a polygon
// SDF for the shield, layered gradients, analytic soft shadows/glow and
// 6x6 supersampling. Outputs 16/32/48/128 PNGs (RGBA).
//
// Design: dark navy badge -> soft blue core glow -> heraldic shield with a
// cyan->blue->violet diagonal gradient, glass inner highlight, white
// redaction bar with drop shadow, top-left specular. Matches the in-app
// SVG brand marks (shield + bar motif).
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

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

// Exact signed distance for a polygon (Inigo Quilez). Negative inside.
function sdPolygon(px, py, verts) {
  const n = verts.length;
  let d = (px - verts[0][0]) ** 2 + (py - verts[0][1]) ** 2;
  let sign = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const ex = verts[j][0] - verts[i][0];
    const ey = verts[j][1] - verts[i][1];
    const wx = px - verts[i][0];
    const wy = py - verts[i][1];
    const bx = wx - ex * clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const by = wy - ey * clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= verts[i][1];
    const c2 = py < verts[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
  }
  return sign * Math.sqrt(d);
}

// Heraldic shield outline (screen coords, y grows downward, centered).
// Right half from top-center down to the bottom point; left side mirrored.
const SHIELD_RIGHT = [
  [0.000, -0.388],
  [0.120, -0.380],
  [0.230, -0.358],
  [0.300, -0.328],
  [0.318, -0.178],
  [0.305,  0.022],
  [0.260,  0.187],
  [0.170,  0.302],
  [0.070,  0.367]
];
const SHIELD_PTS = (() => {
  const right = SHIELD_RIGHT.slice(1); // skip top-center
  const left = right.slice().reverse().map(([x, y]) => [-x, y]);
  return [[0, 0.387], ...left, [SHIELD_RIGHT[0][0], SHIELD_RIGHT[0][1]], ...right];
})();
const SHIELD_ROUND = 0.032;

const SHIELD_SCALE = 1.07;
const shieldSDF = (x, y) => sdPolygon(x / SHIELD_SCALE, y / SHIELD_SCALE, SHIELD_PTS) * SHIELD_SCALE - SHIELD_ROUND;

// Redaction bar across the shield, horizontal with rounded ends.
const BAR = { cx: 0, cy: -0.005, hx: 0.180, hy: 0.052, r: 0.050 };
const barSDF = (x, y) => sdRoundRect(x - BAR.cx, y - BAR.cy, BAR.hx, BAR.hy, BAR.r);

// ---------------------------------------------------------------------------
// Scene: one sample at unit-space (x, y) in [-0.5, 0.5], y grows downward.
// Returns [r, g, b, a] 0-255. Painter's algorithm with analytic soft layers.
// ---------------------------------------------------------------------------

function sample(x, y) {
  // --- badge canvas ---
  const bg = sdRoundRect(x, y, 0.478, 0.478, 0.118);
  if (bg > 0) return [0, 0, 0, 0];

  // Background: deep navy vertical gradient + vignette.
  const ty = clamp01(y + 0.5);
  let col = mix3([22, 33, 60], [6, 10, 21], ty, 0);
  const vig = smoothstep(0.22, 0.52, Math.hypot(x, y));
  col = [col[0] * (1 - 0.22 * vig), col[1] * (1 - 0.22 * vig), col[2] * (1 - 0.20 * vig)];

  // Soft blue core glow behind the shield (slightly above center).
  const gx = x - 0.02, gy = y + 0.06;
  const glow = Math.exp(-(gx * gx + gy * gy) / 0.052) * 0.42;
  col = [col[0] + glow * 30, col[1] + glow * 105, col[2] + glow * 225];

  // Shield drop shadow (soft, below-right), clipped to the canvas.
  const shSDF = shieldSDF(x - 0.016, y - 0.028);
  const shA = (1 - smoothstep(-0.030, 0.035, shSDF)) * 0.55;
  if (shA > 0) col = [mix(col[0], 4, shA), mix(col[1], 7, shA), mix(col[2], 16, shA)];

  const sd = shieldSDF(x, y);
  if (sd <= 0.001) {
    // --- shield body: diagonal sky -> blue -> deep violet gradient ---
    const gt = clamp01((y + 0.43) / 0.84);
    let sc = mix3([96, 226, 250], [42, 108, 244], [96, 58, 224], gt);
    // vertical volume: light from above, darker toward the bottom point
    const vol = smoothstep(-0.28, 0.40, y);
    sc = [mix(sc[0], 16, vol * 0.22), mix(sc[1], 24, vol * 0.18), mix(sc[2], 104, vol * 0.12)];
    // top rim catches light
    const rim = smoothstep(-0.26, -0.388, y) * 0.30;
    sc = [sc[0] + rim * 46, sc[1] + rim * 60, sc[2] + rim * 80];
    col = sc;

    // glass inner highlight: thin bright line just inside the edge, fading down
    const ringA = (1 - smoothstep(0.008, 0.014, Math.abs(sd + 0.048))) * (0.20 + 0.30 * smoothstep(0.15, -0.30, y));
    col = [col[0] + ringA * 190, col[1] + ringA * 215, col[2] + ringA * 255];

    // bottom inner shadow: the point recedes
    const inA = smoothstep(0.10, 0.36, y) * 0.30;
    col = [col[0] * (1 - inA), col[1] * (1 - inA * 0.6), col[2] * (1 - inA * 0.4)];

    // specular blob, top-left
    const sx = (x + 0.115) / 0.115, sy = (y + 0.170) / 0.070;
    const spec = Math.exp(-(sx * sx + sy * sy)) * 0.16;
    col = [col[0] + spec * 130, col[1] + spec * 150, col[2] + spec * 170];
  }

  // --- bar drop shadow (on the shield only) ---
  const bsSDF = barSDF(x - 0.004, y - 0.030);
  const bsA = (1 - smoothstep(-0.012, 0.045, bsSDF)) * 0.50 * (1 - smoothstep(0.001, 0.02, sd));
  if (bsA > 0) col = [mix(col[0], 7, bsA), mix(col[1], 12, bsA), mix(col[2], 30, bsA)];

  // --- white redaction bar with a subtle vertical sheen ---
  const bd = barSDF(x, y);
  if (bd <= 0) {
    const bt = clamp01((y - (BAR.cy - BAR.hy)) / (BAR.hy * 2));
    col = mix3([255, 255, 255], [236, 244, 255], [206, 224, 250], bt);
  }

  // badge edge: hairline highlight on top, deeper shading at the bottom rim
  if (bg > -0.018 && y < 0) {
    const lift = (1 - clamp01((bg + 0.018) / 0.018)) * 22;
    col = [col[0] + lift, col[1] + lift, col[2] + lift * 1.1];
  }
  if (bg > -0.03 && y > 0.30) {
    const dk = (1 - clamp01((bg + 0.03) / 0.03)) * 16;
    col = [col[0] - dk, col[1] - dk, col[2] - dk * 0.8];
  }

  return [clamp(col[0], 0, 255), clamp(col[1], 0, 255), clamp(col[2], 0, 255), 255];
}

function render(size) {
  const SS = 6;
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

export { sample };