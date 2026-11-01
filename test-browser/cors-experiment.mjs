// DECISIVE EXPERIMENT: does an MV3 service worker with host_permissions
// still need CORS headers?
//
// Setup: a mock TypeSafe endpoint on :8789 that serves correct answers but
// sends NO Access-Control-* headers. The extension (dist-test built with
// WITH_HOST_PERMS=1) HAS host_permissions for that origin.
// If classification still succeeds -> host_permissions exempts CORS.
// If it fails with a network error -> CORS still applies in MV3.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_PORT = 9224;
const PROFILE = resolve(ROOT, '.edge-profile-cors');

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

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const body = response.result || {};
  if (body.exceptionDetails) throw new Error(JSON.stringify(body.exceptionDetails).slice(0, 300));
  return body.result?.value;
}

// 1. Mock API on :8789 with CORS disabled.
const mock = spawn(process.execPath, [resolve(ROOT, 'test-browser/mock-server.mjs')], {
  env: { ...process.env, MOCK_PORT: '8789', MOCK_CORS: 'off' },
  detached: true, stdio: 'ignore'
});
mock.unref();
await sleep(1500);
const probe = await fetch('http://127.0.0.1:8789/v1/systemone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"state":{"content":"x"}}' });
console.log(`mock :8789 响应 ${probe.status} | Access-Control-Allow-Origin: ${probe.headers.get('access-control-allow-origin') || '(无)'}`);

// 2. Edge with the extension that HAS host_permissions for :8789.
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--user-data-dir=' + PROFILE,
  '--disable-extensions-except=' + resolve(ROOT, 'dist-test'),
  '--load-extension=' + resolve(ROOT, 'dist-test'),
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-first-run-ui', '--disable-sync',
  '--disable-features=msEdgeSyncConfirmationDialog,msEdgeFirstRunExperience',
  '--window-size=1280,900',
  'http://127.0.0.1:8788/home'
], { detached: true, stdio: 'ignore' });
edge.unref();

let pageT = null;
let extT = null;
for (let i = 0; i < 40 && !(pageT && extT); i += 1) {
  await sleep(700);
  const list = await listTargets().catch(() => []);
  pageT = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8788')) || pageT;
  extT = list.find((t) => t.type === 'page' && /chrome-extension:\/\//.test(t.url)) || extT;
}
if (!pageT || !extT) throw new Error('browser or extension did not start');

// The mock page's main world cannot see chrome.* (content scripts live in an
// isolated world), so storage/manifest operations run in an extension page.
const ext = await connect(extT.webSocketDebuggerUrl);
await ext.send('Runtime.enable');
const setConfig = (endpoint) => evaluate(ext, `new Promise((res) => chrome.storage.local.set({ jevXBlockerConfig: { typesafeApiKey: 'apikey_x', apiEndpoint: '${endpoint}', onboardingCompleted: true, enabled: true } }, res))`);

const perms = await evaluate(ext, 'chrome.runtime.getManifest().host_permissions.join(",")');
console.log(`扩展 host_permissions: ${perms}`);
console.log(`包含 127.0.0.1:8789: ${String(perms).includes('8789')}`);

const page = await connect(pageT.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('Page.bringToFront');
// The first navigation can race the extension install: reload so the content
// script is definitely present.
await evaluate(page, 'location.reload()');
await sleep(3500);

const reloadAndSettle = async () => {
  await evaluate(page, 'location.reload()');
  await sleep(4000);
};
const hiddenCount = () => evaluate(page, `document.querySelectorAll('article[data-jxb-state="hidden"]').length`);

// Control: CORS-enabled endpoint on :8788.
await setConfig('http://127.0.0.1:8788/v1/systemone');
await reloadAndSettle();
const control = await hiddenCount();
console.log(`\n[对照组] CORS 开启 (:8788)  -> 隐藏帖子数: ${control}`);

// Experiment: no-CORS endpoint on :8789, host permission granted.
await setConfig('http://127.0.0.1:8789/v1/systemone');
await reloadAndSettle();
const experiment = await hiddenCount();
const detail = await evaluate(page, `(document.querySelector('.jxb-check-detail') || {}).textContent || ''`);
const monitor = await evaluate(page, `(document.querySelector('.jxb-monitor-status') || {}).textContent || ''`);
console.log(`[实验组] CORS 关闭 (:8789, 有 host 权限) -> 隐藏帖子数: ${experiment}`);
console.log(`         弹层提示: ${detail || '(无)'} | 监视器: ${monitor || '(无)'}`);

console.log(`\n结论: ${experiment >= 2 ? 'host_permissions 足以绕过 CORS —— MV3 下豁免成立' : 'CORS 仍然生效 —— MV3 service worker 需要 API 返回 CORS 头'}`);

page.close();
ext.close();
for (const pid of [edge.pid, mock.pid]) {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch (_) {}
}
process.exit(0);
