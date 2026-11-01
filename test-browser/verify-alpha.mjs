// Verifies icon transparency and renders white/dark composite previews.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let src = readFileSync(resolve(ROOT, 'scripts/make-icons.mjs'), 'utf8');

// Freeze the file-writing side effects, expose the render buffers, and
// convert ESM imports to require() so the source runs inside new Function.
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
const rendered = sandbox.__rendered;
if (!rendered || !rendered[128]) throw new Error('render failed');

const S = 128;
const rgba = rendered[S];
const px = (x, y) => { const i = (y * S + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]; };
console.log('四角 alpha (应全 0):', px(2, 2)[3], px(125, 2)[3], px(2, 125)[3], px(125, 125)[3]);
console.log('盾内 alpha (应 255):', px(64, 40)[3], px(64, 90)[3]);
console.log('光晕采样 (0<a<255):', px(10, 64)[3], px(118, 64)[3]);

function composite(bg) {
  const out = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4; const a = rgba[i + 3] / 255; const o = (y * S + x) * 3;
    out[o] = Math.round(rgba[i] * a + bg[0] * (1 - a));
    out[o + 1] = Math.round(rgba[i + 1] * a + bg[1] * (1 - a));
    out[o + 2] = Math.round(rgba[i + 2] * a + bg[2] * (1 - a));
  }
  return out;
}
function writeBMP(file, S, rgb) {
  const rowSize = Math.ceil(S * 3 / 4) * 4, imgSize = rowSize * S, fileSize = 54 + imgSize;
  const b = Buffer.alloc(fileSize);
  b.write('BM', 0); b.writeUInt32LE(fileSize, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(S, 18); b.writeInt32LE(S, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(imgSize, 34);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const si = ((S - 1 - y) * S + x) * 3, di = 54 + y * rowSize + x * 3;
    b[di] = rgb[si + 2]; b[di + 1] = rgb[si + 1]; b[di + 2] = rgb[si];
  }
  writeFileSync(file, b);
}
mkdirSync(resolve(ROOT, 'test-browser/artifacts'), { recursive: true });
writeBMP(resolve(ROOT, 'test-browser/artifacts/icon-on-white.bmp'), S, composite([255, 255, 255]));
writeBMP(resolve(ROOT, 'test-browser/artifacts/icon-on-dark.bmp'), S, composite([21, 32, 43]));
console.log('预览已生成: test-browser/artifacts/icon-on-{white,dark}.bmp');
