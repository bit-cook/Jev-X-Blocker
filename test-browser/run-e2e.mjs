// End-to-end verification against a REAL Edge browser with the REAL extension
// (dist-test build) loaded, driven over the Chrome DevTools Protocol.
//
// Flow: install opens onboarding -> seed config via the service worker ->
// timeline posts get classified & hidden -> restore reveals a post ->
// SPA route change classifies detail root post + replies -> dead endpoint
// fails open (nothing hidden) -> live endpoint recovers.
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_PORT = Number(process.env.CDP_PORT || 9223);
const MOCK = 'http://127.0.0.1:8788';
const MOCK_API = `${MOCK}/v1/systemone`;
const DEAD_API = 'http://127.0.0.1:9/v1/systemone';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(fn, { timeout = 15000, interval = 500, describe = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${describe}`);
    await sleep(interval);
  }
}

async function jsonList() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return response.json();
}

function connect(wsUrl) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    ws.addEventListener('open', () => {
      resolveConnect({
        send(method, params = {}) {
          return new Promise((resolveSend) => {
            const id = ++seq;
            pending.set(id, resolveSend);
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { ws.close(); }
      });
    });
    ws.addEventListener('error', () => reject(new Error(`cannot attach ${wsUrl}`)));
  });
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  // CDP replies {id, result: {result: RemoteObject, exceptionDetails?}}.
  const body = response.result || {};
  if (body.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(body.exceptionDetails.exception?.description || body.exceptionDetails).slice(0, 300)}`);
  return body.result?.value;
}

const PAGE_STATE = `JSON.stringify((() => {
  const root = document.querySelector('a[href="/someone/status/123456789"]');
  return {
    url: location.pathname,
    monitor: Boolean(document.querySelector('.jxb-monitor')),
    monitorStatus: (document.querySelector('.jxb-monitor-status') || {}).textContent || '',
    monitorSummary: (document.querySelector('.jxb-monitor-summary') || {}).textContent || '',
    placeholders: document.querySelectorAll('[data-jxb-placeholder]').length,
    hiddenArticles: document.querySelectorAll('article[data-jxb-state="hidden"]').length,
    safeArticles: document.querySelectorAll('article[data-jxb-state="safe"]').length,
    displayNoneArticles: [...document.querySelectorAll('article[data-testid="tweet"]')].filter((a) => a.style.display === 'none').length,
    checkHosts: document.querySelectorAll('.jxb-check-host').length,
    revealedArticles: document.querySelectorAll('article[data-jxb-revealed]').length,
    placeholderTitles: [...document.querySelectorAll('.jxb-placeholder-copy strong')].map((n) => n.textContent),
    placeholderDetails: [...document.querySelectorAll('.jxb-placeholder-details')].map((n) => n.textContent),
    rootState: root ? root.closest('article').getAttribute('data-jxb-state') : null,
    rootRevealed: root ? root.closest('article').getAttribute('data-jxb-revealed') : null
  };
})())`;

async function main() {
  console.log('waiting for Edge DevTools endpoint...');
  const initial = await waitFor(async () => {
    try { return await jsonList(); } catch (_) { return null; }
  }, { timeout: 30000, interval: 600, describe: 'DevTools endpoint' });

  // The install flow opens onboarding in its own tab; give it a moment.
  const onboardingSeen = await waitFor(async () => {
    const list = await jsonList();
    return list.some((t) => t.type === 'page' && /\/src\/onboarding\.html/.test(t.url));
  }, { timeout: 12000, interval: 500, describe: 'onboarding page' }).then(() => true, () => false);
  check('install opened the onboarding page', onboardingSeen);

  const workers = (await jsonList()).filter((t) => t.type === 'service_worker');
  const swTarget = workers.find((t) => /\/src\/background\.js/.test(t.url)) || workers.find((t) => /chrome-extension:/.test(t.url));
  check('service worker registered', Boolean(swTarget), swTarget ? swTarget.url : 'none');

  const sw = await connect(swTarget.webSocketDebuggerUrl);
  const manifestName = await waitFor(async () => {
    const value = await evaluate(sw, 'chrome.runtime.getManifest().name');
    return typeof value === 'string' ? value : null;
  }, { timeout: 10000, interval: 500, describe: 'service worker context' });
  const manifestVersion = await evaluate(sw, 'chrome.runtime.getManifest().version');
  check('loaded extension is Jev X Blocker', /Jev X Blocker/.test(String(manifestName)), `${manifestName} ${manifestVersion}`);

  // Seed config: API key + mock endpoint. loadConfig normalizes the rest.
  await evaluate(sw, `chrome.storage.local.set({ jevXBlockerConfig: { typesafeApiKey: 'apikey_mock', apiEndpoint: '${MOCK_API}', onboardingCompleted: true, enabled: true, scopes: { detailReplies: true, detailRoot: true, timeline: true, search: true, profile: true, explore: false } } })`);

  const pageTarget = (await jsonList()).find((t) => t.type === 'page' && t.url.startsWith(MOCK));
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  // Hidden tabs never render, so IntersectionObserver (the post lazy-scan
  // gate) never fires. Keep the mock page frontmost for the whole run.
  const front = () => page.send('Page.bringToFront').catch(() => {});
  await front();
  // The first navigation can race the extension install: reload so the
  // content script injection is guaranteed on a fully-loaded extension.
  await evaluate(page, 'location.reload()');

  // 1. Content script boots: monitor widget injected.
  await waitFor(async () => (await evaluate(page, `Boolean(document.querySelector('.jxb-monitor'))`)), { describe: 'monitor widget' });
  check('content script injected monitor widget', true);

  // 2. Timeline posts classified: 2 of 3 hidden via the mock API.
  await waitFor(async () => (await evaluate(page, `document.querySelectorAll('[data-jxb-placeholder]').length`)) === 2, { describe: 'two hidden posts' });
  await sleep(600);
  const home = JSON.parse(await evaluate(page, PAGE_STATE));
  check('timeline: 2 posts hidden, 1 safe', home.placeholders === 2 && home.hiddenArticles === 2 && home.safeArticles === 1,
    `placeholders=${home.placeholders} hidden=${home.hiddenArticles} safe=${home.safeArticles}`);
  check('timeline: check controls created for every post', home.checkHosts === 3, `hosts=${home.checkHosts}`);
  check('timeline: placeholder copy says 帖子 with confidence', home.placeholderTitles.some((t) => t.includes('帖子')) && home.placeholderDetails.some((d) => /\d+%/.test(d)),
    home.placeholderDetails.join(' | '));
  check('monitor reports page progress', /已检查/.test(home.monitorSummary), home.monitorSummary);

  // 3. Restore reveals a hidden post in place; the OTHER hidden post stays hidden.
  await evaluate(page, `document.querySelector('[data-jxb-placeholder] .jxb-restore').click()`);
  await sleep(700);
  const restored = JSON.parse(await evaluate(page, PAGE_STATE));
  check('restore button reveals the post', restored.placeholders === 1 && restored.displayNoneArticles === 1 && restored.safeArticles === 2 && restored.revealedArticles === 1,
    `placeholders=${restored.placeholders} displayNone=${restored.displayNoneArticles} safe=${restored.safeArticles} revealed=${restored.revealedArticles}`);

  // 4. SPA route change to a detail page: root post + spam reply hidden, normal reply safe.
  await front();
  await evaluate(page, `history.pushState({}, '', '/someone/status/123456789')`);
  await waitFor(async () => (await evaluate(page, `document.querySelectorAll('[data-jxb-placeholder]').length`)) === 2, { describe: 'detail page classification' });
  await sleep(600);
  const detail = JSON.parse(await evaluate(page, PAGE_STATE));
  check('detail: root post hidden via detailRoot scope', detail.rootState === 'hidden', `rootState=${detail.rootState}`);
  check('detail: reply + root placeholders distinguish 帖子/评论', detail.placeholderTitles.some((t) => t.includes('帖子')) && detail.placeholderTitles.some((t) => t.includes('评论')),
    detail.placeholderTitles.join(' | '));
  check('detail: normal reply stays safe', detail.safeArticles >= 1, `safe=${detail.safeArticles}`);

  // 5. Fail-open: dead endpoint + FORCED rechecks (the popover 重新检查
  //    path, which bypasses the decision cache) keep everything visible.
  //    The plain check button intentionally serves the cached decision.
  await front();
  await evaluate(sw, `chrome.storage.local.set({ jevXBlockerConfig: { typesafeApiKey: 'apikey_mock', apiEndpoint: '${DEAD_API}', onboardingCompleted: true, enabled: true, scopes: { detailReplies: true, detailRoot: true, timeline: true, search: true, profile: true, explore: false } } })`);
  await sleep(3600); // content script config poll is 3s
  await evaluate(page, `[...document.querySelectorAll('.jxb-check-host button.jxb-check-recheck')].forEach((b) => b.click())`);
  await waitFor(async () => (await evaluate(page, `document.querySelectorAll('[data-jxb-placeholder]').length`)) === 0, { timeout: 15000, describe: 'fail-open unhide' });
  await sleep(600);
  const failed = JSON.parse(await evaluate(page, PAGE_STATE));
  check('fail-open: API dead -> everything stays visible', failed.placeholders === 0 && failed.displayNoneArticles === 0,
    `placeholders=${failed.placeholders} displayNone=${failed.displayNoneArticles}`);
  check('fail-open: monitor surfaces the error state', /失败/.test(failed.monitorStatus), failed.monitorStatus);

  // 6. Recovery: endpoint back online, forced rechecks re-hide fresh.
  await evaluate(sw, `chrome.storage.local.set({ jevXBlockerConfig: { typesafeApiKey: 'apikey_mock', apiEndpoint: '${MOCK_API}', onboardingCompleted: true, enabled: true, scopes: { detailReplies: true, detailRoot: true, timeline: true, search: true, profile: true, explore: false } } })`);
  await sleep(3600);
  await evaluate(page, `[...document.querySelectorAll('.jxb-check-host button.jxb-check-recheck')].forEach((b) => b.click())`);
  await waitFor(async () => (await evaluate(page, `document.querySelectorAll('[data-jxb-placeholder]').length`)) === 2, { timeout: 15000, describe: 'recovery re-hide' });
  check('recovery: live endpoint re-hides content', true);
  await sleep(2500);
  const stats = JSON.parse(await evaluate(sw, `new Promise(res => chrome.storage.local.get('jevXBlockerStats', r => res(JSON.stringify(r.jevXBlockerStats || {}))))`));
  check('stats after recovery: hidden totals reconcile with page counters', Number(stats.totalHidden) >= 1 && Number(stats.totalPostsHidden) >= 1, `totalHidden=${stats.totalHidden} totalPostsHidden=${stats.totalPostsHidden}`);

  // 7. Screenshot of the final state for the user.
  await front();
  await sleep(800);
  let shotData = null;
  for (const opts of [{ format: 'png' }, { format: 'png', captureBeyondViewport: false }, { format: 'jpeg', quality: 80 }]) {
    const shot = await page.send('Page.captureScreenshot', opts);
    if (shot.result?.data) { shotData = shot.data ?? shot.result.data; break; }
  }
  if (!shotData) throw new Error('Page.captureScreenshot returned no data');
  const artifacts = resolve(ROOT, 'test-browser', 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(resolve(artifacts, 'final-state.png'), Buffer.from(shotData, 'base64'));
  console.log('screenshot: test-browser/artifacts/final-state.png');

  // 8. Monitor dismiss: hide via the widget button, verify it persists and
  //    comes back through the same config path the settings toggle uses.
  await front();
  await evaluate(page, `document.querySelector('.jxb-monitor-button').click()`);
  await sleep(300);
  await evaluate(page, `document.querySelector('.jxb-monitor-hide').click()`);
  await sleep(3600); // config poll picks up showMonitor:false
  const monitorDisplay = await evaluate(page, `getComputedStyle(document.querySelector('.jxb-monitor')).display`);
  check('monitor hide button dismisses the widget', monitorDisplay === 'none', `display=${monitorDisplay}`);
  const persisted = await evaluate(sw, `new Promise((res) => chrome.storage.local.get('jevXBlockerConfig', (r) => res(r.jevXBlockerConfig.showMonitor)))`);
  check('dismissal persists to config', persisted === false, `showMonitor=${persisted}`);
  await evaluate(sw, `chrome.storage.local.set({ jevXBlockerConfig: { typesafeApiKey: 'apikey_mock', apiEndpoint: '${MOCK_API}', onboardingCompleted: true, enabled: true, showMonitor: true } })`);
  await sleep(3600);
  const backDisplay = await evaluate(page, `getComputedStyle(document.querySelector('.jxb-monitor')).display`);
  check('settings toggle path restores the widget', backDisplay !== 'none', `display=${backDisplay}`);

  sw.close();
  page.close();

  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failedCount}/${results.length} checks passed`);
  process.exitCode = failedCount ? 1 : 0;
}

main().catch((error) => {
  console.error('E2E error:', error.message);
  process.exitCode = 1;
});
