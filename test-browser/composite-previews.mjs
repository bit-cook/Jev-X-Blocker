// Renders the transparent icon over white and dark backgrounds as PNGs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = 128;

// Load make-icons.mjs source, neutralize ESM + file writes, expose render().
let src = readFileSync(resolve(ROOT, 'scripts/make-icons.mjs'), 'utf8');
src = src
  .replace("import { writeFileSync, mkdirSync } from 'node:fs';", "const { writeFileSync, mkdirSync } = require('node:fs');")
  .replace("import { deflateSync } from 'node:zlib';", "const { deflateSync } = require('node:zlib');")
  .replace(/import \{[^}]+\} from 'node:path';\n/, "const { resolve, dirname, join, relative } = require('node:path');\n")
  .replace(/import \{ fileURLToPath \} from 'node:url';\n/, "const fileURLToPath = (u) => u;\n")
  .split('import.meta.url').join('"/x/scripts/make-icons.mjs"')
  .replace(/mkdirSync\(resolve\(ROOT, 'assets'\), \{ recursive: true \}\);[\s\S]*$/, "globalThis.__rendered = {};\nfor (const size of [16, 32, 48, 128]) { globalThis.__rendered[size] = render(size); }");

const sandbox = { JevXBlocker: null, __rendered: null, console, module: { exports: {} }, require };
sandbox.globalThis = sandbox;
new Function('globalThis', 'module', 'require', src)(sandbox, sandbox.module, require);
const rgba = sandbox.__rendered[S];
if (!rgba) throw new Error('render failed');

// PNG encoder (same as make-icons).
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const o = Buffer.alloc(8 + data.length + 4); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'ascii'); data.copy(o, 8); o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length); return o; }
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const stride = w * 4; const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function composite(bg) {
  const out = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const a = rgba[i * 4 + 3] / 255;
    out[i * 4] = Math.round(rgba[i * 4] * a + bg[0] * (1 - a));
    out[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a + bg[1] * (1 - a));
    out[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a + bg[2] * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return out;
}

mkdirSync(resolve(ROOT, 'test-browser/artifacts'), { recursive: true });
writeFileSync(resolve(ROOT, 'test-browser/artifacts/icon-on-white.png'), encodePNG(S, S, composite([255, 255, 255])));
writeFileSync(resolve(ROOT, 'test-browser/artifacts/icon-on-dark.png'), encodePNG(S, S, composite([21, 32, 43])));
// Also composite the 16px over white to judge small-size readability.
const rgba16 = sandbox.__rendered[16];
writeFileSync(resolve(ROOT, 'test-browser/artifacts/icon16-on-white.png'), encodePNG(16, 16, composite.call(null, [255, 255, 255]) && (() => {
  const out = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    const a = rgba16[i * 4 + 3] / 255;
    out[i * 4] = Math.round(rgba16[i * 4] * a + 255 * (1 - a));
    out[i * 4 + 1] = Math.round(rgba16[i * 4 + 1] * a + 255 * (1 - a));
    out[i * 4 + 2] = Math.round(rgba16[i * 4 + 2] * a + 255 * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return out;
})()));
console.log('previews written: icon-on-white.png / icon-on-dark.png / icon16-on-white.png');
