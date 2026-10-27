// Packages dist/ into a release ZIP that users can unzip and load unpacked.
// Zero dependencies: minimal ZIP writer (deflate via node:zlib).
//
//   node scripts/package-release.mjs [--out=release/Jev-X-Blocker-v1.0.0.zip]
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const manifest = JSON.parse(readFileSync(resolve(DIST, 'manifest.json'), 'utf8'));
const version = arg('version', manifest.version);
const folder = arg('folder', 'Jev-X-Blocker');
const outPath = resolve(ROOT, arg('out', `release/Jev-X-Blocker-v${version}.zip`));

if (!existsSync(join(DIST, '_locales'))) { console.error('dist/_locales missing — run scripts/build.mjs first.'); process.exit(1); }
if (!existsSync(DIST)) {
  console.error('dist/ not found. Run `node scripts/build.mjs` first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ZIP primitives
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

function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  return { time, date: day };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const now = new Date();
const { time: dosTime, date: dosDate } = dosDateTime(now);
const files = walk(DIST).sort();

const chunks = [];
const central = [];
let offset = 0;

for (const file of files) {
  const data = readFileSync(file);
  const name = Buffer.from(`${folder}/${relative(DIST, file).split('\\').join('/')}`, 'utf8');
  const crc = crc32(data);
  const compressed = deflateRawSync(data, { level: 9 });
  const useDeflate = compressed.length < data.length;
  const payload = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);          // local file header
  local.writeUInt16LE(20, 4);                  // version needed
  local.writeUInt16LE(0x0800, 6);              // UTF-8 filename flag
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);                  // extra length

  chunks.push(local, name, payload);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);            // central directory header
  dir.writeUInt16LE(20, 4);                    // version made by
  dir.writeUInt16LE(20, 6);                    // version needed
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(dosTime, 12);
  dir.writeUInt16LE(dosDate, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(payload.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt16LE(0, 30);                    // extra
  dir.writeUInt16LE(0, 32);                    // comment
  dir.writeUInt16LE(0, 34);                    // disk number
  dir.writeUInt16LE(0, 36);                    // internal attrs
  dir.writeUInt32LE(0, 38);                    // external attrs
  dir.writeUInt32LE(offset, 42);               // local header offset
  central.push(Buffer.concat([dir, name]));

  offset += local.length + name.length + payload.length;
}

const centralBuffer = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuffer.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...chunks, centralBuffer, eocd]);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, zip);

console.log(`packaged ${files.length} files -> ${outPath}`);
console.log(`size: ${(zip.length / 1024).toFixed(1)} KB | top-level folder: ${folder}/`);
for (const file of files.slice(0, 5)) console.log(`  ${folder}/${relative(DIST, file).split('\\').join('/')}`);
if (files.length > 5) console.log(`  ... and ${files.length - 5} more`);
