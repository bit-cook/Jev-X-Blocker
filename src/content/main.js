(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Content bootstrap: MutationObserver -> debounced scan, IntersectionObserver
  // gated classification for timeline posts, SPA route tracking, config sync.
  //
  // Cost model: detail-page replies classify immediately (bounded set), while
  // timeline posts only classify once they scroll within IO_ROOT_MARGIN of
  // the viewport — fast scrolls past dozens of posts cost zero API calls.
  // ---------------------------------------------------------------------------

  const core = root.JevXBlocker;
  const adapter = core.adapter;
  const pipeline = core.pipeline;
  const overlay = core.overlay;

  const IO_ROOT_MARGIN = '700px 0px';
  const SCAN_DEBOUNCE_MS = 150;
  const ROUTE_POLL_MS = 600;
  const CONFIG_POLL_MS = 3000;
  const CLEANUP_INTERVAL_MS = 30000;

  const state = {
    started: false,
    route: '',
    scanTimer: null,
    io: null,
    ioTargets: new Map()      // Element -> enriched target (pruned by sweep)
  };

  function isExtensionNode(node) {
    return Boolean(node && node.nodeType === 1 && (
      node.matches('.jxb-check-host, .jxb-monitor, [data-jxb-placeholder]')
      || (node.closest && node.closest('.jxb-check-host, .jxb-monitor, [data-jxb-placeholder]'))
    ));
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  function ensureIntersectionObserver() {
    if (state.io || typeof IntersectionObserver !== 'function') return state.io;
    state.io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = state.ioTargets.get(entry.target);
        if (target) pipeline.presentTarget(entry.target, target);
      }
    }, { rootMargin: IO_ROOT_MARGIN });
    return state.io;
  }

  function watchWithIO(article, target) {
    const io = ensureIntersectionObserver();
    if (!io) {
      pipeline.presentTarget(article, target);
      return;
    }
    // Always re-arm: unobserve+observe forces a fresh initial IO callback,
    // which the route-change reset (unobserve + clear) depends on. Without
    // this, an article that stayed intersecting across a route change would
    // never be presented again.
    io.unobserve(article);
    io.observe(article);
    state.ioTargets.set(article, target);
  }

  async function scan() {
    if (!state.started) return;
    const config = pipeline.getConfig();
    const context = adapter.pageContext();
    if (!adapter.pageInScope(config, context)) {
      overlay.renderMonitor();
      return;
    }

    const articles = document.querySelectorAll(adapter.SELECTORS.tweet);
    const candidates = [];
    const templateCounts = new Map();
    for (const article of articles) {
      const target = adapter.extractTarget(article, context);
      if (!target) continue;
      const templateKey = core.templateFingerprint(target.text);
      if (templateKey) templateCounts.set(templateKey, (templateCounts.get(templateKey) || 0) + 1);
      candidates.push({ article, target, templateKey });
    }

    const lazy = config.lazyScan !== false;
    for (const candidate of candidates) {
      const { article, target, templateKey } = candidate;
      const enriched = templateKey
        ? { ...target, templateCount: templateCounts.get(templateKey) || 1 }
        : target;
      // Comments (bounded detail page) classify immediately; timeline posts
      // wait for the viewport unless lazyScan is off.
      if (enriched.kind === 'post' && lazy) {
        watchWithIO(article, enriched);
      } else {
        pipeline.presentTarget(article, enriched);
      }
    }
    overlay.renderMonitor();
  }

  function resetRouteIfNeeded() {
    const next = root.location.href;
    if (next === state.route) return;
    state.route = next;
    adapter.invalidatePageContext();
    pipeline.resetPage();
    overlay.clearControls();
    overlay.clearAppliedStates();
    if (state.io) {
      for (const article of state.ioTargets.keys()) state.io.unobserve(article);
    }
    state.ioTargets.clear();
    overlay.renderMonitor();
    scheduleScan();
  }

  function applyUiLang(config) {
    if (!root.JevI18n) return;
    root.JevI18n.setOverride(config.uiLang);
    const current = root.JevI18n.lang();
    if (root.__jxbLastLang === current) return;
    root.__jxbLastLang = current;
    overlay.refreshTexts();
  }

  async function syncConfig() {
    const response = await pipeline.send(core.MESSAGE.GET_STATE);
    if (!response || !response.config) return;
    const p = pipeline;
    const changed = JSON.stringify(response.config) !== JSON.stringify(p.getConfig())
      || Boolean(response.hasApiKey) !== p.getHasApiKey();
    if (!changed) return;
    p.setRuntime(response.config, response.hasApiKey);
    applyUiLang(response.config);
    p.state.processed.clear();
    if (!response.config.enabled || !response.hasApiKey) overlay.clearAppliedStates();
    for (const [, control] of overlay.controls()) {
      const hidden = control.article.classList.contains('jxb-hidden') || control.article.style.display === 'none';
      overlay.setControlsSuppressed(control.article, hidden);
      overlay.renderCheckControl(control);
    }
    overlay.renderMonitor();
    scheduleScan();
  }

  function sweep() {
    // X recycles article nodes constantly; drop IO registrations and overlay
    // hosts that outlived their article so long sessions stay flat on memory.
    if (state.io) {
      for (const [article, target] of state.ioTargets) {
        if (!article.isConnected) {
          state.io.unobserve(article);
          state.ioTargets.delete(article);
          void target;
        }
      }
    }
    overlay.cleanupSweep();
  }

  async function start() {
    overlay.injectStyles();
    overlay.createMonitor();
    const response = await pipeline.send(core.MESSAGE.GET_STATE);
    pipeline.setRuntime(
      response && response.config ? response.config : core.createDefaultConfig(),
      Boolean(response && response.hasApiKey)
    );
    applyUiLang(pipeline.getConfig());
    state.route = root.location.href;
    state.started = true;
    overlay.renderMonitor();
    scheduleScan();

    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        if (isExtensionNode(mutation.target)) return false;
        return Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some((node) => !isExtensionNode(node));
      });
      if (relevant) scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    root.addEventListener('scroll', overlay.requestPosition, { passive: true, capture: true });
    root.addEventListener('resize', overlay.requestPosition);
    // "跟随系统" theme tracks OS changes live.
    const themeMedia = root.matchMedia('(prefers-color-scheme: dark)');
    const onThemeChange = () => pipeline.setRuntime(pipeline.getConfig(), pipeline.getHasApiKey());
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', onThemeChange);
    else if (themeMedia.addListener) themeMedia.addListener(onThemeChange);
    setInterval(resetRouteIfNeeded, ROUTE_POLL_MS);
    setInterval(syncConfig, CONFIG_POLL_MS);
    setInterval(sweep, CLEANUP_INTERVAL_MS);
    // Flush pending stat deltas before the tab goes away so counters survive.
    root.addEventListener('pagehide', () => pipeline.flushReport());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pipeline.flushReport();
    });
  }

  start();
})(typeof globalThis !== 'undefined' ? globalThis : self);
