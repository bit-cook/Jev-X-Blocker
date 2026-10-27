// Debugs the background integration harness: prints the first classify
// response and any SW-side exception.
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function createArea() {
  const values = {};
  return {
    values,
    get(key, callback) { callback({ [key]: values[key] }); },
    set(value, callback) { Object.assign(values, value); callback(); },
    remove(key, callback) { delete values[key]; callback(); }
  };
}

const local = createArea();
const session = createArea();
let messageListener;
let installedListener;
let startupListener;
const requests = [];
const chrome = {
  storage: { local, session },
  runtime: {
    onMessage: { addListener(listener) { messageListener = listener; } },
    onInstalled: { addListener(listener) { installedListener = listener; } },
    onStartup: { addListener(listener) { startupListener = listener; } },
    getURL(file) { return `chrome-extension://test/${file}`; },
    openOptionsPage() { return Promise.resolve(); }
  },
  tabs: { create(options) { return Promise.resolve(); } }
};
const sandbox = {
  chrome,
  console,
  fetch: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    await new Promise((resolve2) => setTimeout(resolve2, 5));
    const body = JSON.parse(options.body);
    const answers = {};
    Object.keys(body.questions).forEach((id) => { answers[id] = { type: 'noul', noul: body.state.content === 'hide-me' ? (id === 'sexual_content' ? 0.93 : 0.12) : 0.08 }; });
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers }) };
  },
  performance, AbortController, setTimeout, clearTimeout,
  Promise, Date, JSON, Math, Object, String, Number, Boolean, Array, Map, Set, WeakSet, WeakMap, Uint8Array, TextEncoder, RegExp
};
vm.createContext(sandbox);
const core = readFileSync(join(ROOT, 'src/shared/core.js'), 'utf8');
const i18n = readFileSync(join(ROOT, 'src/shared/i18n.js'), 'utf8');
const background = readFileSync(join(ROOT, 'src/background.js'), 'utf8');
sandbox.importScripts = (...files) => {
  for (const file of files) {
    const code = file.includes('i18n') ? i18n : core;
    vm.runInContext(code, sandbox);
  }
};
vm.runInContext(background, sandbox);

vm.runInContext("JevXBlocker.cleanError = (e) => { console.log('CLEANERROR:', e && (e.stack || e.message || String(e))); return 'API_UNAVAILABLE'; }", sandbox);
const dispatch = (message) => new Promise((resolve2) => messageListener(message, {}, resolve2));

await dispatch({ type: 'SAVE_API_KEY', payload: { apiKey: 'apikey_secret' } });
await dispatch({ type: 'SAVE_CONFIG', payload: { debug: true } });
const first = await dispatch({ type: 'CLASSIFY_TARGET', payload: { tweetId: 'reply-1', text: 'hide-me', kind: 'comment' } });
console.log('first response:', JSON.stringify(first).slice(0, 300));
console.log('requests captured:', requests.length, '| questions:', requests[0] ? Object.keys(requests[0].body.questions) : '-');
