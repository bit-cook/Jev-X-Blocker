const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createArea() {
  const values = {};
  return {
    values,
    get(key, callback) { callback({ [key]: values[key] }); },
    set(value, callback) { Object.assign(values, value); callback(); },
    remove(key, callback) { delete values[key]; callback(); }
  };
}

function createBackgroundHarness() {
  const local = createArea();
  const session = createArea();
  let messageListener;
  let installedListener;
  let startupListener;
  const requests = [];
  const createdTabs = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const chrome = {
    storage: { local, session },
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      onInstalled: { addListener(listener) { installedListener = listener; } },
      onStartup: { addListener(listener) { startupListener = listener; } },
      getURL(file) { return `chrome-extension://test/${file}`; },
      openOptionsPage() { return Promise.resolve(); }
    },
    tabs: { create(options) { createdTabs.push(options); return Promise.resolve(); } }
  };
  const sandbox = {
    chrome,
    console,
    fetch: async (url, options) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      requests.push({ url, options, body: JSON.parse(options.body) });
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (options.body.includes('network-fail')) throw new TypeError('network failed');
        const body = JSON.parse(options.body);
        const answers = {};
        Object.keys(body.questions).forEach((id) => { answers[id] = { type: 'noul', noul: body.state.content === 'hide-me' ? (id === 'sexual_content' ? 0.93 : 0.12) : 0.08 }; });
        return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }) };
      } finally {
        activeRequests -= 1;
      }
    },
    performance,
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    JSON,
    Math,
    Object,
    String,
    Number,
    Boolean,
    Array,
    Map,
    Set,
    WeakSet,
    WeakMap,
    Uint8Array,
    TextEncoder,
    RegExp
  };
  vm.createContext(sandbox);
  const core = fs.readFileSync(path.join(__dirname, '..', 'src/shared/core.js'), 'utf8');
  sandbox.importScripts = () => vm.runInContext(core, sandbox);
  const background = fs.readFileSync(path.join(__dirname, '..', 'src/background.js'), 'utf8');
  vm.runInContext(background, sandbox);
  assert.equal(typeof messageListener, 'function');
  assert.equal(typeof installedListener, 'function');
  assert.equal(typeof startupListener, 'function');
  const dispatch = (message) => new Promise((resolve) => messageListener(message, {}, resolve));
  return { dispatch, requests, local, session, createdTabs, startupListener, installedListener, get maxActiveRequests() { return maxActiveRequests; } };
}

const E = require('../src/shared/core.js');

test('background classifies comments and posts, keeps the key out of the body, caches and fails open', async () => {
  const harness = createBackgroundHarness();
  await harness.dispatch({ type: E.MESSAGE.SAVE_API_KEY, payload: { apiKey: 'apikey_secret' } });

  const comment = await harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: 'reply-1', text: 'hide-me', kind: 'comment' } });
  assert.equal(comment.ok, true);
  assert.equal(comment.shouldHide, true);
  assert.equal(harness.requests.length, 1);
  assert.match(harness.requests[0].options.headers.Authorization, /^Bearer apikey_secret$/);
  assert.equal(harness.requests[0].body.state.content, 'hide-me');
  assert.equal(JSON.stringify(harness.requests[0].body).includes('apikey_secret'), false);

  const post = await harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: 'post-1', text: 'hide-me', kind: 'post' } });
  assert.equal(post.ok, true);
  assert.equal(post.shouldHide, true);
  assert.equal(post.cache, 'hit');

  const rechecked = await harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: 'post-1', text: 'hide-me', kind: 'post', force: true } });
  assert.equal(rechecked.cache, 'miss');
  assert.equal(harness.requests.length, 2);

  await harness.dispatch({ type: E.MESSAGE.SAVE_CONFIG, payload: { dailyLimit: 1 } });
  const limited = await harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: 'reply-3', text: 'another safe comment' } });
  assert.equal(limited.ok, false);
  assert.equal(limited.error, 'DAILY_LIMIT_REACHED');

  await harness.dispatch({ type: E.MESSAGE.SAVE_CONFIG, payload: { dailyLimit: 2000 } });
  const failed = await harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: 'reply-4', text: 'network-fail' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'API_UNAVAILABLE');
  assert.equal(failed.shouldHide, undefined);
});

test('kind-aware rule selection only asks questions the kind applies to', async () => {
  const harness = createBackgroundHarness();
  await harness.dispatch({ type: E.MESSAGE.SAVE_API_KEY, payload: { apiKey: 'apikey_secret' } });
  await harness.dispatch({
    type: E.MESSAGE.SAVE_CONFIG,
    payload: {
      rules: E.DEFAULT_RULES.map((rule) => ({ ...rule, applyTo: rule.id === 'sexual_content' ? ['comment'] : ['comment', 'post'] }))
    }
  });
  await harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: 'post-9', text: 'hide-me', kind: 'post' } });
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(Object.keys(harness.requests[0].body.questions).sort(), ['sexual_solicitation', 'spam_behavior']);
  // Same text as a comment asks the full set and lands on a different cache key.
  await harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: 'reply-9', text: 'hide-me', kind: 'comment' } });
  assert.equal(harness.requests.length, 2);
  assert.ok(harness.requests[1].body.questions.sexual_content);
});

test('background queue never exceeds the configured concurrency', async () => {
  const harness = createBackgroundHarness();
  await harness.dispatch({ type: E.MESSAGE.SAVE_API_KEY, payload: { apiKey: 'apikey_secret' } });
  await harness.dispatch({ type: E.MESSAGE.SAVE_CONFIG, payload: { maxConcurrency: 2 } });
  const results = await Promise.all(Array.from({ length: 7 }, (_, index) => harness.dispatch({ type: E.MESSAGE.CLASSIFY_TARGET, payload: { tweetId: `reply-${index}`, text: `safe-${index}` } })));
  assert.ok(results.every((result) => result.ok));
  assert.ok(harness.maxActiveRequests <= 2, `observed ${harness.maxActiveRequests} concurrent requests`);
});

test('install migrates elons-work storage instead of opening onboarding', async () => {
  const harness = createBackgroundHarness();
  harness.local.values[E.LEGACY_CONFIG_KEY] = {
    typesafeApiKey: 'apikey_legacy',
    enabled: true,
    rules: [{ id: 'sexual_content', name: 'old', enabled: true, threshold: 0.8 }]
  };
  harness.local.values[E.LEGACY_STATS_KEY] = { totalChecked: 12, totalHidden: 5 };
  await harness.installedListener({ reason: 'install' });
  assert.equal(harness.createdTabs.length, 0);
  const state = await harness.dispatch({ type: E.MESSAGE.GET_STATE });
  assert.equal(state.hasApiKey, true);
  assert.equal(state.apiKeyMask.includes('apik'), true);
  assert.equal(state.stats.totalChecked, 12);
  assert.equal(state.stats.totalHidden, 5);
  assert.ok(state.config.rules.some((rule) => rule.id === 'sexual_content' && rule.threshold === 0.8));
});

test('unconfigured startup opens the onboarding page as a fallback', async () => {
  const harness = createBackgroundHarness();
  await harness.startupListener();
  assert.equal(harness.createdTabs.length, 1);
  assert.equal(harness.createdTabs[0].url, 'chrome-extension://test/src/onboarding.html');
});

test('batched target events accumulate per-kind totals across pages', async () => {
  const harness = createBackgroundHarness();
  await harness.dispatch({
    type: E.MESSAGE.RECORD_TARGET_EVENT,
    payload: { deltas: { checked: 2, hidden: 1, postsChecked: 3, postsHidden: 2 }, page: { checked: 5, hidden: 3, postChecked: 3, postHidden: 2 } }
  });
  await harness.dispatch({
    type: E.MESSAGE.RECORD_TARGET_EVENT,
    payload: { deltas: { checked: 1, postsHidden: 1 }, page: { checked: 6, hidden: 5, postChecked: 3, postHidden: 3 } }
  });
  const state = await harness.dispatch({ type: E.MESSAGE.GET_STATE });
  assert.equal(state.stats.totalChecked, 3);
  assert.equal(state.stats.totalHidden, 1);
  assert.equal(state.stats.totalPostsChecked, 3);
  assert.equal(state.stats.totalPostsHidden, 3);
  assert.equal(state.stats.pageChecked, 6);
  assert.equal(state.stats.pageHidden, 5);
  assert.equal(state.stats.pagePostHidden, 3);
});
