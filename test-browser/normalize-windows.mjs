// Brings the mock tab (and its window) to the foreground before e2e runs.
// A minimized/background window suspends rendering: IntersectionObserver
// never fires and the lazy scan classifies nothing. If the tab still reports
// hidden after activation, exit non-zero with an actionable message.
const DEBUG = 'http://127.0.0.1:9223';
const version = await (await fetch(DEBUG + '/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  ws.send(JSON.stringify(message));
});

const list = await (await fetch(DEBUG + '/json/list')).json();
const pageT = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8788'));
if (!pageT) { console.log('no mock page target'); process.exit(2); }
const attached = await send('Target.attachToTarget', { targetId: pageT.id, flatten: true });
const sessionId = attached.result.sessionId;
await send('Target.activateTarget', { targetId: pageT.id });
await send('Page.enable', {}, sessionId);
await send('Page.bringToFront', {}, sessionId);
await new Promise((r) => setTimeout(r, 1200));
const vis = await send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId);
const state = vis.result?.result?.value;
if (state !== 'visible') {
  console.error(`mock tab visibility is "${state}" — bring the Edge window to the foreground (un-minimize it) and rerun.`);
  ws.close();
  process.exit(3);
}
console.log('mock tab visible');
ws.close();
