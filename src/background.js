importScripts('shared/core.js');
importScripts('shared/i18n.js');

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Service worker. Sole reader of the TypeSafe API key; the only process
  // that talks to api.typesafe.ai. Refactor highlights over elons-job:
  //   * in-memory LRU mirror over the session-storage cache (zero-latency
  //     hits while the worker is alive, hydration on cold start);
  //   * batched stats writes: deltas coalesce in memory and flush on a short
  //     timer instead of hitting chrome.storage per classified item;
  //   * one-shot migration from elons-work storage on install;
  //   * kind-aware rule selection (posts vs comments share the cache key
  //     space through the rules fingerprint).
  // ---------------------------------------------------------------------------

  const E = globalThis.JevXBlocker;
  const runtime = globalThis.chrome;

  let reservedRequests = 0;
  let quotaGate = Promise.resolve();
  let statsGate = Promise.resolve();
  let pendingStats = null;
  let statsFlushTimer = null;
  let liveRequests = null;   // requests counted this worker life (storage + unflushed)
  let liveDay = '';

  const FLUSH_STATS_MS = 1200;
  const CACHE_MAX_ENTRIES = 600;

  // --------------------------------------------------------------------------
  // Stats: accumulate deltas in memory, flush under a serialising gate.
  // --------------------------------------------------------------------------

  const DELTA_TOTALS = {
    checked: 'totalChecked',
    hidden: 'totalHidden',
    postsChecked: 'totalPostsChecked',
    postsHidden: 'totalPostsHidden'
  };

  function queueStats(changes) {
    if (!pendingStats) pendingStats = {};
    for (const [key, value] of Object.entries(changes || {})) {
      if (key.endsWith('Delta')) {
        // Deltas from multiple events must accumulate, never overwrite.
        pendingStats[key] = (Number(pendingStats[key]) || 0) + (Number(value) || 0);
      } else {
        pendingStats[key] = value;
      }
    }
    if (!statsFlushTimer) {
      statsFlushTimer = setTimeout(() => {
        statsFlushTimer = null;
        flushStats();
      }, FLUSH_STATS_MS);
    }
  }

  function flushStats() {
    if (statsFlushTimer) {
      clearTimeout(statsFlushTimer);
      statsFlushTimer = null;
    }
    const changes = pendingStats;
    pendingStats = null;
    if (!changes) return Promise.resolve();
    const previous = statsGate;
    let release;
    statsGate = new Promise((resolve) => { release = resolve; });
    return previous.then(async () => {
      try {
        const current = await E.getStats(runtime);
        const next = { ...changes };
        for (const key of ['requests', 'cacheHits', 'errors', 'checked', 'hidden', 'postsChecked', 'postsHidden']) {
          const deltaKey = `${key}Delta`;
          if (Object.prototype.hasOwnProperty.call(next, deltaKey)) {
            const delta = Number(next[deltaKey] || 0);
            next[key] = (Number(current[key]) || 0) + delta;
            if (DELTA_TOTALS[key]) next[DELTA_TOTALS[key]] = (Number(current[DELTA_TOTALS[key]]) || 0) + delta;
            delete next[deltaKey];
          }
        }
        return await E.updateStats(runtime, next);
      } finally {
        release();
      }
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function jitteredDelay(base) {
    return delay(Math.round(base * (0.8 + Math.random() * 0.4)));
  }

  function withTimeoutSignal(milliseconds) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), milliseconds);
    return { signal: controller.signal, dispose: () => clearTimeout(timeout) };
  }

  // --------------------------------------------------------------------------
  // TypeSafe client
  // --------------------------------------------------------------------------

  class TypeSafeClient {
    constructor(endpoint, model) {
      this.endpoint = endpoint || E.API_ENDPOINT;
      this.model = model || E.MODEL_VERSION;
    }

    async request(apiKey, body, options) {
      if (!apiKey) throw Object.assign(new Error('API key is missing'), { code: 'API_KEY_MISSING' });
      const config = options || {};
      const attempts = Number(config.attempts) || 2;
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const timeout = withTimeoutSignal(Number(config.timeoutMs) || 12000);
        try {
          const response = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model: this.model, ...body }),
            signal: timeout.signal
          });
          const text = await response.text();
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
          if (response.ok) return data;
          const error = Object.assign(new Error(`TypeSafe request failed (${response.status})`), { status: response.status, data });
          if (response.status === 401 || response.status === 403) throw error;
          lastError = error;
          if (response.status !== 429 && response.status < 500) throw error;
          await jitteredDelay(response.status === 429 ? 350 * (attempt + 1) : 200 * (attempt + 1));
        } catch (error) {
          lastError = error;
          const code = E.cleanError(error);
          if (code === 'API_KEY_INVALID') throw error;
          const status = Number(error && error.status);
          const retryable = !status || status === 429 || status >= 500 || (error && error.name === 'AbortError');
          if (!retryable) throw error;
          if (attempt + 1 < attempts) await jitteredDelay(180 * (attempt + 1));
        } finally {
          timeout.dispose();
        }
      }
      throw lastError || Object.assign(new Error('TypeSafe unavailable'), { code: 'API_UNAVAILABLE' });
    }

    async testConnection(apiKey) {
      const started = performance.now();
      await this.request(apiKey, {
        state: { content: 'connection test' },
        questions: {
          connection_ok: {
            type: 'noul',
            instructions: 'Is this a connection test?',
            criteria: { true: 'The request is a connection test.', false: 'The request is not a connection test.' }
          }
        }
      }, { attempts: 1, timeoutMs: 10000 });
      return Math.round(performance.now() - started);
    }

    async classify(apiKey, questions, content) {
      const started = performance.now();
      const response = await this.request(apiKey, {
        state: { content },
        questions
      }, { attempts: 2, timeoutMs: 12000 });
      return { response, latencyMs: Math.round(performance.now() - started) };
    }
  }

  // --------------------------------------------------------------------------
  // Concurrency queue with per-key in-flight dedupe
  // --------------------------------------------------------------------------

  class RequestQueue {
    constructor(concurrency) {
      this.concurrency = Math.max(1, Number(concurrency) || 3);
      this.active = 0;
      this.pending = [];
      this.inFlight = new Map();
    }

    setConcurrency(value) {
      this.concurrency = Math.max(1, Math.min(8, Number(value) || 3));
      this.pump();
    }

    get(key) {
      return this.inFlight.get(key) || null;
    }

    enqueue(key, task) {
      if (this.inFlight.has(key)) return this.inFlight.get(key);
      const promise = new Promise((resolve, reject) => {
        this.pending.push({ key, task, resolve, reject });
        this.pump();
      });
      this.inFlight.set(key, promise);
      promise.then(() => this.inFlight.delete(key), () => this.inFlight.delete(key));
      return promise;
    }

    pump() {
      while (this.active < this.concurrency && this.pending.length) {
        const item = this.pending.shift();
        this.active += 1;
        Promise.resolve()
          .then(item.task)
          .then(item.resolve, item.reject)
          .finally(() => {
            this.active -= 1;
            this.pump();
          });
      }
    }
  }

  const queue = new RequestQueue(3);

  // --------------------------------------------------------------------------
  // Cache: in-memory LRU mirrored into chrome.storage.session so results
  // survive service-worker restarts without paying storage reads per hit.
  // --------------------------------------------------------------------------

  class LruCache {
    constructor(max) {
      this.max = max;
      this.map = new Map();
    }

    get(key) {
      if (!this.map.has(key)) return null;
      const value = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }

    set(key, value) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, value);
      while (this.map.size > this.max) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    }
  }

  const memoryCache = new LruCache(CACHE_MAX_ENTRIES);
  let sessionCacheHydrated = false;

  async function cacheGet(key) {
    const local = memoryCache.get(key);
    if (local) return local;
    if (sessionCacheHydrated) return null;
    const stored = await E.storageGet(runtime, 'session', E.CACHE_KEY);
    sessionCacheHydrated = true;
    const cache = stored[E.CACHE_KEY] || {};
    const entries = Object.entries(cache).slice(-CACHE_MAX_ENTRIES);
    for (const [entryKey, value] of entries) memoryCache.set(entryKey, value);
    return memoryCache.get(key);
  }

  async function cacheSet(key, value) {
    memoryCache.set(key, value);
    const stored = await E.storageGet(runtime, 'session', E.CACHE_KEY);
    const cache = stored[E.CACHE_KEY] || {};
    const entries = Object.entries({ ...cache, [key]: value });
    const bounded = Object.fromEntries(entries.slice(-CACHE_MAX_ENTRIES));
    await E.storageSet(runtime, 'session', { [E.CACHE_KEY]: bounded });
  }

  // --------------------------------------------------------------------------
  // Quota guard: never let the extension silently burn API budget
  // --------------------------------------------------------------------------

  async function reserveRequest(limit) {
    let release;
    const previous = quotaGate;
    quotaGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const stats = await E.getStats(runtime);
      if (liveRequests === null || liveDay !== stats.day) {
        // Batched deltas lag behind storage; flush first so the quota check
        // sees every request this worker has already made.
        await flushStats();
        const fresh = await E.getStats(runtime);
        liveDay = fresh.day;
        liveRequests = fresh.day === stats.day ? (Number(fresh.requests) || 0) : 0;
      }
      if (liveRequests + reservedRequests >= limit) return false;
      liveRequests += 1;
      reservedRequests += 1;
      queueStats({ requestsDelta: 1 });
      return true;
    } finally {
      release();
    }
  }

  async function classify(payload) {
    const config = await E.loadConfig(runtime, true);
    if (globalThis.JevI18n) globalThis.JevI18n.setOverride(config.uiLang);
    const kind = payload && payload.kind === 'post' ? 'post' : 'comment';
    const rules = E.activeRules(config, kind);
    const text = E.normalizeText(payload && payload.text);
    if (!config.enabled || !rules.length) return { ok: true, shouldHide: false, matches: [], results: {} };
    if (!text || text.length < 2) return { ok: true, shouldHide: false, matches: [], results: {} };
    if (!config.typesafeApiKey) return { ok: false, error: 'API_KEY_MISSING' };

    const key = await E.cacheKey(text, rules, config.model);
    const force = payload && payload.force === true;
    const cached = force ? null : await cacheGet(key);
    if (!force && cached && Date.now() - cached.createdAt < config.cacheTtlHours * 60 * 60 * 1000) {
      queueStats({ cacheHitsDelta: 1 });
      return { ok: true, ...cached.decision, cache: 'hit' };
    }

    queue.setConcurrency(config.maxConcurrency);
    const existing = queue.get(key);
    if (existing) return existing;
    const fingerprint = await E.rulesFingerprint(rules);
    const questions = E.buildQuestions(rules);
    const client = new TypeSafeClient(config.apiEndpoint, config.model);
    const queued = queue.enqueue(key, async () => {
      const reserved = await reserveRequest(config.dailyLimit);
      if (!reserved) return { ok: false, error: 'DAILY_LIMIT_REACHED' };
      try {
        const result = await client.classify(config.typesafeApiKey, questions, text);
        const decision = E.buildDecision(result.response, rules, { content: text });
        await cacheSet(key, { createdAt: Date.now(), model: config.model, fingerprint, decision });
        queueStats({ latencyMs: result.latencyMs, lastError: '' });
        E.debugLog(config, 'classified', { tweetId: payload && payload.tweetId, kind, contentHash: key, latencyMs: result.latencyMs, cache: 'miss' });
        return { ok: true, ...decision, latencyMs: result.latencyMs, cache: 'miss' };
      } catch (error) {
        const code = E.cleanError(error);
        queueStats({ errorsDelta: 1, lastError: code });
        E.debugLog(config, 'classification_error', { tweetId: payload && payload.tweetId, kind, contentHash: key, error: code });
        return { ok: false, error: code };
      } finally {
        reservedRequests = Math.max(0, reservedRequests - 1);
      }
    });
    return queued;
  }

  async function openOnboarding() {
    await runtime.tabs.create({ url: runtime.runtime.getURL('src/onboarding.html') });
    return { ok: true };
  }

  async function state() {
    await flushStats();
    const config = await E.loadConfig(runtime, true);
    const stats = await E.getStats(runtime);
    return {
      config: E.sanitizeConfig(config),
      hasApiKey: Boolean(config.typesafeApiKey),
      needsOnboarding: !config.typesafeApiKey && config.onboardingCompleted !== true,
      apiKeyMask: E.maskSecret(config.typesafeApiKey),
      stats
    };
  }

  async function handleMessage(message) {
    const type = message && message.type;
    const payload = message && message.payload;
    if (type === E.MESSAGE.GET_STATE) return { ok: true, ...(await state()) };
    if (type === E.MESSAGE.SAVE_API_KEY) {
      const apiKey = String(payload && payload.apiKey || '').trim();
      if (apiKey.length > 512) return { ok: false, error: 'API_KEY_INVALID_FORMAT' };
      await E.saveConfig(runtime, { typesafeApiKey: apiKey });
      return { ok: true, hasApiKey: Boolean(apiKey), apiKeyMask: E.maskSecret(apiKey) };
    }
    if (type === E.MESSAGE.TEST_CONNECTION) {
      const config = await E.loadConfig(runtime, true);
      const apiKey = String(payload && payload.apiKey || config.typesafeApiKey || '').trim();
      if (!apiKey) return { ok: false, error: 'API_KEY_MISSING' };
      try {
        const latencyMs = await new TypeSafeClient(config.apiEndpoint, config.model).testConnection(apiKey);
        return { ok: true, latencyMs };
      } catch (error) {
        return { ok: false, error: E.cleanError(error) };
      }
    }
    if (type === E.MESSAGE.OPEN_ONBOARDING) return openOnboarding();
    if (type === E.MESSAGE.CLASSIFY_TARGET) return classify(payload || {});
    if (type === E.MESSAGE.SAVE_CONFIG) {
      const saved = await E.saveConfig(runtime, payload || {});
      return { ok: true, config: E.sanitizeConfig(saved) };
    }
    if (type === E.MESSAGE.RECORD_TARGET_EVENT) {
      const deltas = payload && payload.deltas || {};
      const page = payload && payload.page;
      const changes = {};
      if (Number(deltas.checked)) changes.checkedDelta = Number(deltas.checked);
      if (Number(deltas.hidden)) changes.hiddenDelta = Number(deltas.hidden);
      if (Number(deltas.postsChecked)) changes.postsCheckedDelta = Number(deltas.postsChecked);
      if (Number(deltas.postsHidden)) changes.postsHiddenDelta = Number(deltas.postsHidden);
      if (page) {
        if (Number.isFinite(page.checked)) changes.pageChecked = Math.max(0, Number(page.checked));
        if (Number.isFinite(page.hidden)) changes.pageHidden = Math.max(0, Number(page.hidden));
        if (Number.isFinite(page.safe)) changes.pageSafe = Math.max(0, Number(page.safe));
        if (Number.isFinite(page.pending)) changes.pagePending = Math.max(0, Number(page.pending));
        if (Number.isFinite(page.errors)) changes.pageErrors = Math.max(0, Number(page.errors));
        if (Number.isFinite(page.latencyMs)) changes.pageLatencyMs = Math.max(0, Number(page.latencyMs));
        if (Number.isFinite(page.postChecked)) changes.pagePostChecked = Math.max(0, Number(page.postChecked));
        if (Number.isFinite(page.postHidden)) changes.pagePostHidden = Math.max(0, Number(page.postHidden));
      }
      queueStats(changes);
      return { ok: true };
    }
    if (type === E.MESSAGE.CLEAR_CACHE) {
      memoryCache.map.clear();
      sessionCacheHydrated = true;
      await E.storageRemove(runtime, 'session', E.CACHE_KEY);
      await E.storageRemove(runtime, 'local', E.CACHE_KEY);
      return { ok: true };
    }
    if (type === E.MESSAGE.OPEN_SETTINGS) {
      await runtime.runtime.openOptionsPage();
      return { ok: true };
    }
    return { ok: false, error: 'UNKNOWN_MESSAGE' };
  }

  runtime.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch(async (error) => {
        await flushStats().catch(() => {});
        sendResponse({ ok: false, error: E.cleanError(error) });
      });
    return true;
  });

  runtime.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
      // Upgraders from elons-job keep their API key, custom rules and totals.
      await E.migrateLegacy(runtime).catch(() => null);
      const config = await E.loadConfig(runtime, true);
      if (!config.typesafeApiKey) {
        await E.saveConfig(runtime, E.createDefaultConfig());
        await openOnboarding();
      }
      return;
    }
    if (details.reason === 'update') {
      const config = await E.loadConfig(runtime, true);
      if (!config.typesafeApiKey && config.onboardingCompleted !== true) await openOnboarding();
    }
  });

  runtime.runtime.onStartup.addListener(async () => {
    const config = await E.loadConfig(runtime, true);
    if (!config.typesafeApiKey && config.onboardingCompleted !== true) await openOnboarding();
  });
})();
