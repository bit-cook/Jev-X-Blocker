// Captures the real classify exception: patches cleanError in the SW, then
// triggers a classify from an extension page and reads the SW console logs.
const DEBUG = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT_ID = 'ddjdmgccmndmmofmfepmbdgmpehodico';

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const logs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.consoleAPICalled') logs.push('LOG: ' + (m.params.args || []).map((a) => a.value ?? a.description).join(' ').slice(0, 400));
    });
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
      },
      logs,
      close() { ws.close(); }
    }));
    ws.addEventListener('error', () => reject(new Error('ws error ' + wsUrl)));
  });
}

const wake = await fetch(DEBUG + '/json/new?' + encodeURIComponent(`chrome-extension://${EXT_ID}/src/popup.html`), { method: 'PUT' }).then((r) => r.json()).catch(() => null);
await sleep(2200);
const list = await (await fetch(DEBUG + '/json/list')).json();
const swT = list.find((x) => x.type === 'service_worker');
if (!swT) { console.log('SW still down'); process.exit(1); }
const sw = await connect(swT.webSocketDebuggerUrl);
await sw.send('Runtime.enable');
await sw.send('Runtime.evaluate', { expression: "JevXBlocker.cleanError = (e) => { console.error('CLEANERROR:', e && (e.stack || e.message || String(e))); return 'API_UNAVAILABLE'; }", returnByValue: true });
const ep = await sw.send('Runtime.evaluate', { expression: "new Promise(res => chrome.storage.local.get('jevXBlockerConfig', r => res((r.jevXBlockerConfig || {}).apiEndpoint || 'none')))", awaitPromise: true, returnByValue: true });
console.log('endpoint:', ep.result?.result?.value);
if (wake) await fetch(DEBUG + '/json/close/' + wake.id).catch(() => {});

// Keep the SW ws open; trigger the classify from a second page.
const page = await fetch(DEBUG + '/json/new?' + encodeURIComponent(`chrome-extension://${EXT_ID}/src/popup.html`), { method: 'PUT' }).then((r) => r.json());
await sleep(1500);
const pw = await connect(page.webSocketDebuggerUrl);
await pw.send('Runtime.enable');
const r = await pw.send('Runtime.evaluate', { expression: `new Promise(res => { chrome.runtime.sendMessage({ type: 'CLASSIFY_TARGET', payload: { tweetId: 'probe', text: '只进身体不进生活🖤想约的私信', kind: 'post', force: true } }, (resp) => res(JSON.stringify({ resp }))); setTimeout(() => res('HUNG_8S'), 8000); })`, awaitPromise: true, returnByValue: true });
console.log('分类响应:', r.result?.result?.value);
await sleep(600);
console.log('SW 日志:', sw.logs.length ? sw.logs.join('\n') : '(无)');
pw.close();
sw.close();
await fetch(DEBUG + '/json/close/' + page.id).catch(() => {});
