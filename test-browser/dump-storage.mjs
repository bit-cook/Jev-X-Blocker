// Ground-truth storage dump for the headless e2e session.
const DEBUG = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(DEBUG + '/json/list')).json();
let extT = list.find((t) => t.type === 'page' && /chrome-extension:\/\//.test(t.url));
if (!extT) {
  const created = await fetch(DEBUG + '/json/new?' + encodeURIComponent('chrome-extension://ddjdmgccmndmmofmfepmbdgmpehodico/src/popup.html'), { method: 'PUT' }).then((r) => r.json());
  await sleep(1800);
  extT = created;
}
const ws = new WebSocket(extT.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') events.push('EXC: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable');
await send('Runtime.evaluate', { expression: "chrome.storage.local.get(null, (all) => { window.__dump = JSON.stringify(all || {}); })" });
await sleep(800);
const r = await send('Runtime.evaluate', { expression: 'window.__dump', returnByValue: true });
const dump = JSON.parse(r.result?.result?.value || '{}');
const cfg = dump.jevXBlockerConfig || null;
console.log('storage keys:', Object.keys(dump).join(', '));
console.log('config:', cfg ? JSON.stringify({
  key: cfg.typesafeApiKey ? 'has-key(' + cfg.typesafeApiKey.slice(0, 12) + ')' : 'NO-KEY',
  endpoint: cfg.apiEndpoint,
  uiLang: cfg.uiLang,
  scopes: JSON.stringify(cfg.scopes),
  enabled: cfg.enabled
}) : 'null');
console.log('stats:', dump.jevXBlockerStats ? JSON.stringify({ hidden: dump.jevXBlockerStats.totalHidden, postsHidden: dump.jevXBlockerStats.totalPostsHidden }) : 'null');
console.log('events:', events.length ? events.join('\n') : '(clean)');
ws.close();
if (extT.id) await fetch(DEBUG + '/json/close/' + extT.id).catch(() => {});
