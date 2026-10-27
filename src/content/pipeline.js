(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Classification pipeline (content-script side).
  //
  // Owns: dedupe identities, per-page status counters, the reveal set, hash
  // memoisation and batched stat reporting. Storage secrets and network
  // access live exclusively in the service worker; every hop goes through it.
  // ---------------------------------------------------------------------------

  const core = root.JevXBlocker;
  const adapter = core.adapter;

  const state = {
    config: core.createDefaultConfig(),
    hasApiKey: false,
    processed: new Map(),      // identity -> last classify response
    statuses: new Map(),       // articleKey -> { kind, result }
    revealed: new Set(),       // articleKeys the user manually restored
    pageChecked: 0,
    pageHidden: 0,
    pageSafe: 0,
    pagePending: 0,
    pageErrors: 0,
    pagePostChecked: 0,
    pagePostHidden: 0,
    pageLastLatency: 0,
    deltas: null,              // lazily created { checked, hidden, postsChecked, postsHidden }
    reportTimer: null,
    hashMemo: new Map()
  };

  // Hard ceiling for a message round-trip. The service worker's worst case
  // is two 12s fetch attempts plus backoff (~24.5s); past that the channel
  // is considered lost (classic MV3 sendMessage hang) and we resolve
  // fail-open so hidden content can never stay stuck on "pending".
  const SEND_TIMEOUT_MS = 26000;

  function send(type, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'NO_RESPONSE' }), SEND_TIMEOUT_MS);
      try {
        root.chrome.runtime.sendMessage({ type, payload }, (response) => {
          finish(response || { ok: false, error: 'NO_RESPONSE' });
        });
      } catch (_) {
        finish({ ok: false, error: 'RUNTIME_UNAVAILABLE' });
      }
    });
  }

  function articleKey(target) {
    return `${target.tweetId}:${target.author || ''}:${target.text}`;
  }

  // SHA-256 per composed content, memoised: the same reply text remounts many
  // times while X virtualises its feed, and every scan pass re-hashes it.
  function memoizedHash(content) {
    const cached = state.hashMemo.get(content);
    if (cached) return cached;
    const promise = core.hashText(content).catch(() => `fnv-${content.length}`);
    state.hashMemo.set(content, promise);
    if (state.hashMemo.size > 800) {
      const first = state.hashMemo.keys().next().value;
      state.hashMemo.delete(first);
    }
    return promise;
  }

  function getConfig() { return state.config; }
  function getHasApiKey() { return state.hasApiKey; }
  function getProcessed(identity) { return state.processed.get(identity); }

  // Resolves the configured theme (system/dark/light) onto <html> so
  // content.css can flip the injected UI between palettes.
  function setRuntime(config, hasApiKey) {
    state.config = config;
    state.hasApiKey = Boolean(hasApiKey);
    const preference = config && config.theme;
    const resolved = preference === 'light' || preference === 'dark'
      ? preference
      : (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.document.documentElement.dataset.jxbTheme = resolved;
  }

  function statusOf(entry) {
    if (!entry) return null;
    const result = entry.result;
    if (!result) return null;
    if (result.pending) return 'pending';
    if (result.ok) return result.shouldHide ? 'hidden' : 'safe';
    return 'error';
  }

  function transitionStatus(key, kind, next) {
    const previous = state.statuses.get(key);
    const oldStatus = statusOf(previous);
    const newStatus = next ? (next.pending ? 'pending' : next.ok ? (next.shouldHide ? 'hidden' : 'safe') : 'error') : null;
    // Count against the kind the entry was FIRST registered with, so a
    // re-entrant call (same tweet seen as post on one route and comment on
    // another) cannot double-count or strand a post/comment delta.
    const trackedKind = previous ? previous.kind : kind;
    if (!oldStatus && newStatus) {
      state.pageChecked += 1;
      if (trackedKind === 'post') state.pagePostChecked += 1;
      if (!state.deltas) state.deltas = { checked: 0, hidden: 0, postsChecked: 0, postsHidden: 0 };
      if (trackedKind === 'post') state.deltas.postsChecked += 1;
      else state.deltas.checked += 1;
    }
    if (oldStatus && !newStatus) {
      state.pageChecked = Math.max(0, state.pageChecked - 1);
      if (previous.kind === 'post') state.pagePostChecked = Math.max(0, state.pagePostChecked - 1);
    }
    if (oldStatus === 'hidden') {
      state.pageHidden = Math.max(0, state.pageHidden - 1);
      if (previous.kind === 'post') state.pagePostHidden = Math.max(0, state.pagePostHidden - 1);
    }
    if (oldStatus === 'safe') state.pageSafe = Math.max(0, state.pageSafe - 1);
    if (oldStatus === 'pending') state.pagePending = Math.max(0, state.pagePending - 1);
    if (oldStatus === 'error') state.pageErrors = Math.max(0, state.pageErrors - 1);
    if (newStatus === 'hidden') {
      state.pageHidden += 1;
      if (kind === 'post') state.pagePostHidden += 1;
    }
    if (newStatus === 'safe') state.pageSafe += 1;
    if (newStatus === 'pending') state.pagePending += 1;
    if (newStatus === 'error') state.pageErrors += 1;
    if (next) state.statuses.set(key, { kind, result: next });
    else state.statuses.delete(key);
  }

  function flushReport() {
    if (state.reportTimer) {
      clearTimeout(state.reportTimer);
      state.reportTimer = null;
    }
    const deltas = state.deltas;
    state.deltas = null;
    if (!deltas) return;
    send(core.MESSAGE.RECORD_TARGET_EVENT, {
      deltas,
      page: {
        checked: state.pageChecked,
        hidden: state.pageHidden,
        safe: state.pageSafe,
        pending: state.pagePending,
        errors: state.pageErrors,
        latencyMs: state.pageLastLatency,
        postChecked: state.pagePostChecked,
        postHidden: state.pagePostHidden
      }
    });
    core.adapter && root.JevXBlocker.overlay && root.JevXBlocker.overlay.renderMonitor();
  }

  function scheduleReport() {
    if (state.reportTimer) return;
    state.reportTimer = setTimeout(flushReport, 1200);
  }

  // Called when a classify response turns a previously-unreported item into
  // "hidden". The matching checked delta may already have been flushed (the
  // pending transition happened earlier), so record both here to keep the
  // cumulative totals consistent with what the page counters show.
  function markHiddenDelta(kind) {
    if (!state.deltas) state.deltas = { checked: 0, hidden: 0, postsChecked: 0, postsHidden: 0 };
    if (kind === 'post') state.deltas.postsHidden += 1;
    else state.deltas.hidden += 1;
    scheduleReport();
  }

  function resetPage() {
    flushReport();
    state.processed.clear();
    state.statuses.clear();
    state.revealed.clear();
    state.pageChecked = 0;
    state.pageHidden = 0;
    state.pageSafe = 0;
    state.pagePending = 0;
    state.pageErrors = 0;
    state.pagePostChecked = 0;
    state.pagePostHidden = 0;
    state.pageLastLatency = 0;
  }

  // Entry point for scan/IO: guarantees the hover control exists, then
  // classifies when the current config actually allows this target.
  async function presentTarget(article, target) {
    const overlay = root.JevXBlocker.overlay;
    const config = state.config;
    const hash = await memoizedHash(core.composeContent(target));
    const identity = `${articleKey(target)}:${hash}`;
    overlay.ensureCheckControl(article, target, identity, hash);
    if (!config || config.enabled === false || !state.hasApiKey) {
      overlay.renderCheckControlFor(identity);
      return;
    }
    if (!adapter.targetAllowed(config, target)) {
      overlay.renderCheckControlFor(identity);
      return;
    }
    await classifyTarget(article, target, { hash, identity });
  }

  async function classifyTarget(article, target, options) {
    const overlay = root.JevXBlocker.overlay;
    const config = state.config;
    const opts = options || {};
    const kind = target.kind === 'post' ? 'post' : 'comment';
    const key = articleKey(target);
    const inspectionContent = core.composeContent(target);
    const hash = opts.hash || await memoizedHash(inspectionContent);
    const identity = opts.identity || `${key}:${hash}`;
    const control = overlay.ensureCheckControl(article, target, identity, hash);
    const previous = state.processed.get(identity);

    if (opts.force) {
      state.revealed.delete(key);
      article.removeAttribute('data-jxb-revealed');
    } else if (state.revealed.has(key) || article.dataset.jxbRevealed === 'true') {
      overlay.renderCheckControl(control);
      return;
    }
    if (!opts.force && previous) {
      if (previous.ok && previous.shouldHide) overlay.applyHidden(article, target, previous.matches || []);
      else if (previous.ok) overlay.applySafe(article);
      overlay.renderCheckControl(control);
      return;
    }
    if (opts.force && previous && previous.pending) return;

    const pending = { pending: true };
    transitionStatus(key, kind, pending);
    state.processed.set(identity, pending);
    article.dataset.jxbState = 'pending';
    if (config.preload) article.classList.add('jxb-pending');
    overlay.renderCheckControl(control);
    overlay.renderMonitor();
    scheduleReport();

    const response = await send(core.MESSAGE.CLASSIFY_TARGET, {
      tweetId: target.tweetId,
      text: inspectionContent,
      kind,
      force: Boolean(opts.force)
    });
    transitionStatus(key, kind, response);
    state.processed.set(identity, response || { ok: false, error: 'NO_RESPONSE' });
    if (response && Number.isFinite(response.latencyMs)) state.pageLastLatency = response.latencyMs;
    overlay.renderCheckControl(control);
    if (response && response.ok && response.shouldHide) markHiddenDelta(kind);
    else if (!response || !response.ok) scheduleReport();
    overlay.renderMonitor();
    if (!article.isConnected) return;
    const current = adapter.extractTarget(article);
    if (!current || articleKey(current) !== key) return;
    if (response && response.ok && response.shouldHide) overlay.applyHidden(article, target, response.matches || []);
    else overlay.applySafe(article);
  }

  function revealTarget(article, target) {
    const key = articleKey(target);
    state.revealed.add(key);
    const overlay = root.JevXBlocker.overlay;
    let identity = null;
    for (const [candidate, control] of overlay.controls()) {
      if (control.article === article) { identity = candidate; break; }
    }
    const previous = identity ? state.processed.get(identity) : null;
    const revealedResult = { ok: true, shouldHide: false, results: previous && previous.results || {}, matches: [] };
    if (identity) state.processed.set(identity, revealedResult);
    transitionStatus(key, target.kind, revealedResult);
    overlay.applySafe(article);
    article.dataset.jxbRevealed = 'true';
    article.dataset.jxbState = 'safe';
    scheduleReport();
  }

  root.JevXBlocker = Object.assign(root.JevXBlocker || {}, {
    pipeline: {
      state,
      send,
      articleKey,
      memoizedHash,
      getConfig,
      getHasApiKey,
      getProcessed,
      setRuntime,
      transitionStatus,
      presentTarget,
      classifyTarget,
      revealTarget,
      resetPage,
      flushReport,
      scheduleReport
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
