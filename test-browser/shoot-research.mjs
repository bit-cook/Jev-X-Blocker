// Opens the research page in Edge (fresh profile, CDP :9225) and screenshots
// both themes for visual verification.
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = resolve(ROOT, '.edge-profile-docs');
const ART = resolve(ROOT, 'test-browser/artifacts');
const DEBUG_PORT = 9225;
const PAGE_URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/docs/model-providers-research.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}

const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--user-data-dir=' + PROFILE,
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-first-run-ui', '--disable-sync',
  '--window-size=1280,900',
  PAGE_URL
], { detached: true, stdio: 'ignore' });
edge.unref();

const listTargets = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();

function connect(wsUrl) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    ws.addEventListener('open', () => resolveConnect({
      send(method, params = {}) {
        return new Promise((resolveSend) => { const id = ++seq; pending.set(id, resolveSend); ws.send(JSON.stringify({ id, method, params })); });
      },
      close() { ws.close(); }
    }));
    ws.addEventListener('error', () => reject(new Error(`cannot attach ${wsUrl}`)));
  });
}

let pageT = null;
for (let i = 0; i < 30 && !pageT; i += 1) {
  await sleep(700);
  const list = await listTargets().catch(() => []);
  pageT = list.find((t) => t.type === 'page' && t.url.includes('model-providers-research')) || pageT;
}
if (!pageT) throw new Error('page did not open');

const page = await connect(pageT.webSocketDebuggerUrl);
await page.send('Page.enable');
await page.send('Page.bringToFront');
await sleep(900);
mkdirSync(ART, { recursive: true });

for (const theme of ['dark', 'light']) {
  await page.send('Runtime.evaluate', { expression: `document.documentElement.dataset.jxbTheme = '${theme}'`, returnByValue: true });
  await sleep(500);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const data = shot.result?.data;
  if (!data) throw new Error(`no screenshot data for ${theme}`);
  const file = resolve(ART, `research-${theme}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`saved ${file}`);
}

// Full-page (capture beyond viewport) for a final overall look.
const full = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
if (full.result?.data) {
  writeFileSync(resolve(ART, 'research-full.png'), Buffer.from(full.result.data, 'base64'));
  console.log(`saved full-page capture`);
}

// Console errors check.
const errors = await page.send('Runtime.evaluate', {
  expression: `JSON.stringify({h2: document.querySelectorAll('h2').length, tables: document.querySelectorAll('table').length, badges: document.querySelectorAll('.badge').length, theme: document.documentElement.dataset.jxbTheme})`,
  returnByValue: true
});
console.log('page state:', errors.result?.result?.value);

page.close();
try { spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore' }); } catch (_) {}
process.exit(0);
