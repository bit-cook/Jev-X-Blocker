// Grep the whole tracked tree for stale strings (old versions, old name,
// removed badges, hardcoded versions). Run: node scripts/stale-grep.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url)); // scripts/
const BASE = join(ROOT, '..');
const SKIP = new Set(['.git', 'node_modules', 'dist', 'dist-test', 'release', 'docs', '.edge-profile', '.edge-profile-cors', '.edge-profile-docs', 'test-browser', 'assets']);
const patterns = {
  '旧版本号 v1.0.0/1/2 硬编码': /v1\.0\.[012][^.\d]/,
  '旧名 Jev-X-blocker': /Jev-X-blocker/,
  'PROD 残留': /PROD/,
  'MV3 徽章残留': /jxb-badge">MV3</,
  '写死版本号 v1.0.x ·': /v1\.0\.\d ·/,
};
const hits = {};

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('stale-grep.mjs')) continue;
    else {
      const text = readFileSync(full, 'utf8');
      for (const [label, re] of Object.entries(patterns)) {
        if (re.test(text)) (hits[label] ||= []).push(relative(BASE, full));
      }
    }
  }
}

walk(BASE);
let count = 0;
for (const [label, list] of Object.entries(hits)) {
  count += list.length;
  console.log('[' + label + ']', list.join(', '));
}
if (!count) console.log('无过期字符串残留 ✅');
