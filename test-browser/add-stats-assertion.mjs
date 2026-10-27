// Adds a stats-reconciliation assertion to run-e2e.mjs (idempotent).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(ROOT, 'test-browser/run-e2e.mjs');
let e = readFileSync(file, 'utf8');

if (!e.includes('stats after recovery')) {
  const anchor = "  check('recovery: live endpoint re-hides content', true);";
  if (!e.includes(anchor)) throw new Error('anchor not found in run-e2e.mjs');
  const addition = [
    anchor,
    '  await sleep(2500);',
    "  const stats = JSON.parse(await evaluate(sw, `new Promise(res => chrome.storage.local.get('jevXBlockerStats', r => res(JSON.stringify(r.jevXBlockerStats || {}))))`));",
    "  check('stats after recovery: hidden totals reconcile with page counters', Number(stats.totalHidden) >= 1 && Number(stats.totalPostsHidden) >= 1, `totalHidden=${stats.totalHidden} totalPostsHidden=${stats.totalPostsHidden}`);"
  ].join('\n');
  e = e.replace(anchor, addition);
  writeFileSync(file, e);
  console.log('e2e stats assertion added');
} else {
  console.log('already present');
}
