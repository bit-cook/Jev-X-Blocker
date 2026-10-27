// Brings the mock page to the foreground and reloads it, then reports the
// injected-UI state. Used to recover the e2e browser when the window lost
// focus (IntersectionObserver never fires for hidden tabs).
import { writeFileSync } from 'node:fs';

const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const pageT = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8788'));
if (!pageT) { console.log('no mock page target'); process.exit(1); }

const ws = new WebSocket(pageT.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
await send('Page.bringToFront');
await send('Runtime.evaluate', { expression: 'location.reload()', returnByValue: true });
await new Promise((r) => setTimeout(r, 4500));

const probe = `JSON.stringify({
  monitor: !!document.querySelector('.jxb-monitor'),
  hosts: document.querySelectorAll('.jxb-check-host').length,
  placeholders: document.querySelectorAll('[data-jxb-placeholder]').length,
  hidden: document.querySelectorAll('article[data-jxb-state="hidden"]').length,
  vis: document.visibilityState
})`;
const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
console.log('after front+reload:', r.result?.result?.value);
ws.close();
