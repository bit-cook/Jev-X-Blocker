// Capture console output + exceptions from the content script during a reload.
const DEBUG_PORT = 9223;
const list = async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();

function connect(wsUrl) {
  return new Promise((resolveConnect, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      else if (message.method) events.push(message);
    });
    ws.addEventListener('open', () => resolveConnect({
      send(method, params = {}) {
        return new Promise((resolveSend) => { const id = ++seq; pending.set(id, resolveSend); ws.send(JSON.stringify({ id, method, params })); });
      },
      events,
      close() { ws.close(); }
    }));
    ws.addEventListener('error', () => reject(new Error(`cannot attach ${wsUrl}`)));
  });
}

const targets = await list();
const pageT = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8788'));
const page = await connect(pageT.webSocketDebuggerUrl);
await page.send('Runtime.enable');
await page.send('Log.enable');
await page.evaluate ? null : null;

const captured = [];
const harvest = () => {
  for (const event of page.events) {
    if (event.method === 'Runtime.consoleAPICalled') {
      const args = (event.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      captured.push(`[console.${event.params.type}] ${args}`);
    } else if (event.method === 'Runtime.exceptionThrown') {
      captured.push(`[exception] ${JSON.stringify(event.params.exceptionDetails).slice(0, 500)}`);
    } else if (event.method === 'Log.entryAdded') {
      captured.push(`[log.${event.params.entry.level}] ${event.params.entry.text} ${event.params.entry.url || ''}`);
    }
  }
  page.events.length = 0;
};

await new Promise((r) => setTimeout(r, 300));
// reload via CDP Page domain (same navigation, fresh console)
await page.send('Page.enable');
await page.send('Page.reload');
await new Promise((r) => setTimeout(r, 6000));
harvest();
console.log('captured', captured.length, 'console events');
for (const line of captured) console.log(line);

// Also inspect final DOM state after reload
const response = await page.send('Runtime.evaluate', { expression: `JSON.stringify({
  monitors: document.querySelectorAll('.jxb-monitor').length,
  hosts: document.querySelectorAll('.jxb-check-host').length,
  placeholders: document.querySelectorAll('[data-jxb-placeholder]').length,
  states: [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) => a.getAttribute('data-jxb-state'))
})`, returnByValue: true });
console.log('final state:', JSON.stringify(response.result?.result?.value));
page.close();
