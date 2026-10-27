// Restores the browser window from minimized state via CDP, then confirms
// the mock tab is visible.
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
const win = await send('Browser.getWindowForTarget', {}, sessionId);
const windowId = win.result?.windowId;
const bounds = win.result?.bounds;
console.log('window:', windowId, '| state:', bounds?.windowState);
if (bounds?.windowState && bounds.windowState !== 'normal') {
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  console.log(`restored: ${bounds.windowState} -> normal`);
}
await send('Page.bringToFront', {}, sessionId);
await new Promise((r) => setTimeout(r, 1500));
const vis = await send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId);
const state = vis.result?.result?.value;
console.log('visibility:', state);
ws.close();
process.exit(state === 'visible' ? 0 : 3);
