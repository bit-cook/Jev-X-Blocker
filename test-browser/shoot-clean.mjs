// Relaunch Edge cleanly, poll until the CDP port is actually up, then
// capture the cleaned brand areas (popup hero + onboarding brand).
import { spawn, execSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = resolve(ROOT, '.edge-profile-docs');
const DEBUG_PORT = 9226;
const ART = resolve(ROOT, 'test-browser/artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync('taskkill /F /IM msedge.exe', { stdio: 'ignore' }); } catch (_) {}
await sleep(2500);
try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (_) {}

const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--user-data-dir=' + PROFILE,
  '--disable-extensions-except=' + resolve(ROOT, 'dist-test'),
  '--load-extension=' + resolve(ROOT, 'dist-test'),
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-first-run-ui', '--disable-sync',
  '--disable-features=msEdgeSyncConfirmationDialog,msEdgeFirstRunExperience',
  '--window-size=1366,768',
  'http://127.0.0.1:8788/home'
], { detached: true, stdio: 'ignore' });
edge.unref();

let listTargets = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(800);
  try { listTargets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); break; } catch (_) {}
}
if (!listTargets) throw new Error('DevTools port never came up');
console.log('DevTools up after polling');

let extId = null, swT = null, pageT = null;
for (let i = 0; i < 25 && !(extId && swT && pageT); i += 1) {
  await sleep(700);
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const any = list.find((t) => /chrome-extension:\/\//.test(t.url));
  extId = any ? any.url.match(/chrome-extension:\/\/([^/]+)/)[1] : extId;
  swT = list.find((t) => t.type === 'service_worker' && /chrome-extension:/.test(t.url)) || swT;
  pageT = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8788')) || pageT;
}
if (!extId || !swT || !pageT) throw new Error('extension did not fully start');
console.log('extId:', extId);

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

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const body = response.result || {};
  if (body.exceptionDetails) throw new Error(JSON.stringify(body.exceptionDetails).slice(0, 300));
  return body.result?.value;
}

const sw = await connect(swT.webSocketDebuggerUrl);
await evaluate(sw, `new Promise((res) => chrome.storage.local.set({ jevXBlockerConfig: { typesafeApiKey: 'apikey_demo', apiEndpoint: 'https://api.typesafe.ai/v1/systemone', onboardingCompleted: true, enabled: true, theme: 'dark' } }, res))`);
sw.close();

const page = await connect(pageT.webSocketDebuggerUrl);
await page.send('Page.enable');
await page.send('Page.bringToFront');
await evaluate(page, 'location.reload()');
await sleep(3500);
mkdirSync(ART, { recursive: true });

const shoot = async (url, file, clip) => {
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  await sleep(2500);
  const w = await connect(created.webSocketDebuggerUrl);
  await w.send('Page.enable');
  await w.send('Page.bringToFront');
  await sleep(700);
  const shot = await w.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  writeFileSync(resolve(ART, file), Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${file}`);
  w.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${created.id}`).catch(() => {});
  await sleep(400);
};

await shoot(`chrome-extension://${extId}/src/popup.html`, 'clean-popup.png', { x: 0, y: 0, width: 380, height: 140, scale: 2 });
await shoot(`chrome-extension://${extId}/src/onboarding.html`, 'clean-onboarding.png', { x: 0, y: 0, width: 660, height: 220, scale: 1.4 });
page.close();
process.exit(0);
