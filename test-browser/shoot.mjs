// Visual review helper: opens each extension surface in the running
// CDP-connected browser, sizes it with device-metrics emulation, screenshots
// it into test-browser/artifacts/.
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_PORT = 9223;
const ART = resolve(ROOT, 'test-browser', 'artifacts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  return (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
}

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

async function shoot(cdp, file, { width = 1280, height = 860 } = {}) {
  await cdp.send('Page.enable');
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(1100);
  for (const opts of [{ format: 'png' }, { format: 'png', captureBeyondViewport: false }, { format: 'jpeg', quality: 85 }]) {
    const shot = await cdp.send('Page.captureScreenshot', opts);
    const data = shot.result?.data;
    if (data) {
      await writeFile(resolve(ART, file), Buffer.from(data, 'base64'));
      console.log(`saved ${file} (${width}x${height})`);
      return;
    }
  }
  console.log(`FAILED ${file}: no screenshot data`);
}

const targets0 = await listTargets();
let swT = targets0.find((t) => t.type === 'service_worker' && /chrome-extension:/.test(t.url));
// Extension id is stable for an unpacked install (hash of the path); recover
// it from any lingering extension page (e.g. onboarding) when the MV3
// service worker has idle-stopped, then wake it via a popup page.
let extensionId = swT ? swT.url.match(/chrome-extension:\/\/([^/]+)/)[1] : null;
if (!swT) {
  const anyExt = targets0.find((t) => /chrome-extension:\/\//.test(t.url));
  extensionId = extensionId || (anyExt ? anyExt.url.match(/chrome-extension:\/\/([^/]+)/)[1] : null);
  if (extensionId) {
    const wake = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/src/popup.html`)}`, { method: 'PUT' }).then((r) => r.json()).catch(() => null);
    await sleep(2000);
    const targets1 = await listTargets();
    swT = targets1.find((t) => t.type === 'service_worker' && /chrome-extension:/.test(t.url));
    if (wake) await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${wake.id}`).catch(() => {});
  }
}
if (!swT) throw new Error('extension service worker not found; is the test browser running?');
await mkdir(ART, { recursive: true });

// Fresh seed config so the popup/settings render the "connected" state.
const sw = await connect(swT.webSocketDebuggerUrl);
const seed = (endpoint, theme = 'dark') => `new Promise((res) => chrome.storage.local.set({ jevXBlockerConfig: { typesafeApiKey: 'apikey_demo', apiEndpoint: '${endpoint}', onboardingCompleted: true, enabled: true, theme: '${theme}', showMonitor: true, scopes: { detailReplies: true, detailRoot: true, timeline: true, search: true, profile: true, explore: false } } }, res))`;
await sw.send('Runtime.evaluate', { expression: seed('https://api.typesafe.ai/v1/systemone'), awaitPromise: true });
sw.close();

async function openAndShoot(url, file, size, { seedEndpoint = 'https://api.typesafe.ai/v1/systemone', theme = 'dark', prepare = null } = {}) {
  // Always seed before opening so the page renders the intended theme/endpoint.
  const sw = await connect(swT.webSocketDebuggerUrl);
  await sw.send('Runtime.evaluate', { expression: seed(seedEndpoint, theme), awaitPromise: true });
  sw.close();
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  await sleep(1600);
  const cdp = await connect(created.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  if (prepare) await prepare(cdp, seedEndpoint);
  await shoot(cdp, file, size);
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${created.id}`).catch(() => {});
  await sleep(400);
}

await openAndShoot(`chrome-extension://${extensionId}/src/popup.html`, 'ui-popup.png', { width: 420, height: 780 });
await openAndShoot(`chrome-extension://${extensionId}/src/settings.html`, 'ui-settings.png', { width: 1280, height: 880 });
await openAndShoot(`chrome-extension://${extensionId}/src/settings.html`, 'ui-settings-light.png', { width: 1280, height: 880 }, { theme: 'light' });
await openAndShoot(`chrome-extension://${extensionId}/src/popup.html?view=console`, 'ui-console.png', { width: 900, height: 820 });
await openAndShoot(`chrome-extension://${extensionId}/src/onboarding.html`, 'ui-onboarding.png', { width: 900, height: 820 });
// Content page must run against the mock endpoint so classifications succeed.
await openAndShoot('http://127.0.0.1:8788/home', 'ui-content.png', { width: 1280, height: 880 }, {
  seedEndpoint: 'http://127.0.0.1:8788/v1/systemone',
  seedBeforeOpen: true,
  prepare: async (cdp) => {
    // Wait until the risky posts are actually hidden (not just pending).
    let hidden = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelectorAll('article[data-jxb-state="hidden"]').length`, returnByValue: true });
      hidden = r.result?.result?.value || 0;
      if (hidden >= 2) break;
      await sleep(500);
    }
    if (hidden < 2) console.log(`warning: only ${hidden} hidden posts when shooting`);
    await cdp.send('Runtime.evaluate', { expression: `(() => {
      const style = document.createElement('style');
      style.textContent = '.jxb-check-host{opacity:1 !important;pointer-events:auto !important} .jxb-check-host .jxb-check-popover{display:block !important}';
      document.head.appendChild(style);
      document.querySelectorAll('.jxb-check-host')[2]?.classList.add('is-visible');
      document.querySelector('.jxb-monitor-button')?.click();
    })()`, returnByValue: true });
    await sleep(600);
  }
});
console.log('done');
