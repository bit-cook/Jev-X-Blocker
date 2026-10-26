// Interactive CDP diagnosis helper.
const DEBUG_PORT = 9223;
const list = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();

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
  if (body.exceptionDetails) return `EVAL_ERROR: ${JSON.stringify(body.exceptionDetails).slice(0, 400)}`;
  return body.result?.value;
}

const targets = await list();
const swT = targets.find((t) => t.type === 'service_worker');
const pageT = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8788'));
console.log('sw target:', swT?.url, '| page target:', pageT?.url);

const sw = await connect(swT.webSocketDebuggerUrl);
console.log('\n--- stored config ---');
console.log(await evaluate(sw, `chrome.storage.local.get(null, (r) => document.title)`));
console.log(await evaluate(sw, `new Promise((res) => chrome.storage.local.get('jevXBlockerConfig', (r) => res(JSON.stringify(r).slice(0, 400))))`));
console.log('\n--- SW fetch to mock API (CORS check) ---');
console.log(await evaluate(sw, `(async () => {
  try {
    const r = await fetch('http://127.0.0.1:8788/v1/systemone', { method: 'POST', headers: { Authorization: 'Bearer apikey_mock', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state: { content: '只进身体' }, questions: {} }) });
    return 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120);
  } catch (e) { return 'FETCH_ERROR: ' + e.message; }
})()`));

const page = await connect(pageT.webSocketDebuggerUrl);
await page.send('Runtime.enable');
console.log('\n--- page state ---');
console.log(await evaluate(page, `JSON.stringify({
  url: location.pathname,
  monitor: Boolean(document.querySelector('.jxb-monitor')),
  status: (document.querySelector('.jxb-monitor-status') || {}).textContent,
  summary: (document.querySelector('.jxb-monitor-summary') || {}).textContent,
  scopes: (document.querySelector('.jxb-monitor-scopes') || {}).textContent,
  placeholders: document.querySelectorAll('[data-jxb-placeholder]').length,
  articles: document.querySelectorAll('article[data-testid="tweet"]').length,
  states: [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) => a.getAttribute('data-jxb-state')),
  hosts: document.querySelectorAll('.jxb-check-host').length,
  popoverStatuses: [...document.querySelectorAll('.jxb-check-status')].map((n) => n.textContent)
})`));
console.log('\n--- force one classification through the real message path ---');
console.log(await evaluate(page, `(async () => {
  const done = new Promise((resolve) => {
    const ext = document.querySelector('.jxb-check-host button');
    if (!ext) { resolve('no check button'); return; }
    // poll for popover status change
    const start = Date.now();
    const timer = setInterval(() => {
      const s = document.querySelector('.jxb-check-status');
      if (s && /命中|未命中|失败/.test(s.textContent)) { clearInterval(timer); resolve(s.textContent); }
      if (Date.now() - start > 12000) { clearInterval(timer); resolve('timeout: ' + (s ? s.textContent : 'none')); }
    }, 250);
    ext.click();
  });
  return await done;
})()`));
console.log('\n--- page state after forced classification ---');
console.log(await evaluate(page, `JSON.stringify({
  status: (document.querySelector('.jxb-monitor-status') || {}).textContent,
  summary: (document.querySelector('.jxb-monitor-summary') || {}).textContent,
  placeholders: document.querySelectorAll('[data-jxb-placeholder]').length,
  states: [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) => a.getAttribute('data-jxb-state')),
  popoverDetail: [...document.querySelectorAll('.jxb-check-detail')].map((n) => n.textContent)
})`));
sw.close();
page.close();
