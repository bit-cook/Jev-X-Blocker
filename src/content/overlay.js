(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Overlay UI: hidden-content placeholders, per-article hover check controls
  // and the page monitor widget. All nodes carry jxb- classes / data-jxb-*
  // attributes so the MutationObserver in main.js can ignore its own writes.
  // All user-facing strings resolve through JevI18n; refreshTexts() re-renders
  // live nodes when the interface language changes.
  // ---------------------------------------------------------------------------

  const core = root.JevXBlocker;
  const i18n = root.JevI18n;
  const t = (key, vars) => i18n.t(key, vars);

  const controls = new Map();      // identity -> control
  const boundAnchors = new WeakSet();
  const anchorControls = new WeakMap();
  const hideTimers = new WeakMap();
  let monitor = null;
  let positionFrame = null;

  function pipeline() { return root.JevXBlocker.pipeline; }
  function adapter() { return root.JevXBlocker.adapter; }

  function injectStyles() {
    if (document.querySelector('link[data-jxb-style]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.jxbStyle = 'true';
    link.href = root.chrome.runtime.getURL('src/styles/content.css');
    (document.head || document.documentElement).appendChild(link);
  }

  // --------------------------------------------------------------------------
  // Placeholders
  // --------------------------------------------------------------------------

  const EYE_OFF_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function ruleDisplayName(match) {
    if (match.ruleId === 'combined_risk') return t('rule.combinedRisk');
    const rule = (pipeline().getConfig() && pipeline().getConfig().rules || []).find((candidate) => candidate.id === match.ruleId);
    if (rule && !rule.builtin) return rule.name;
    return i18n.has(`rule.${match.ruleId}.name`) ? t(`rule.${match.ruleId}.name`) : (match.name || match.ruleId);
  }

  function fillPlaceholder(placeholder, target, matches) {
    const config = pipeline().getConfig() || {};
    const compact = config.showPlaceholder === false;
    const isPost = target.kind === 'post';
    placeholder.__jxbMatches = matches || [];
    placeholder.__jxbKind = target.kind;
    if (compact) placeholder.classList.add('compact');
    else placeholder.classList.remove('compact');

    const title = placeholder.querySelector('.jxb-placeholder-copy strong');
    const details = placeholder.querySelector('.jxb-placeholder-details');
    const restore = placeholder.querySelector('.jxb-restore');
    title.textContent = compact
      ? t(isPost ? 'overlay.hiddenPostCompact' : 'overlay.hiddenCommentCompact')
      : t(isPost ? 'overlay.hiddenPost' : 'overlay.hiddenComment');
    details.textContent = compact
      ? t('overlay.compactHint')
      : (matches || []).map((match) => {
          if (config.showConfidence === false) return ruleDisplayName(match);
          const score = match.source === 'combined-risk-signal'
            ? t('overlay.combinedScore', { n: Math.round(match.combinedScore * 100) })
            : ` · ${Math.round(match.probability * 100)}%`;
          return ruleDisplayName(match) + score;
        }).join('  ') || t('overlay.noDisplayRule', { noun: t(isPost ? 'overlay.nounPost' : 'overlay.nounComment') });
    restore.textContent = t(isPost ? 'overlay.viewPost' : 'overlay.viewComment');
  }

  function createPlaceholder(article, target, matches) {
    const config = pipeline().getConfig() || {};
    const placeholder = document.createElement('div');
    placeholder.dataset.jxbPlaceholder = 'true';
    placeholder.className = 'jxb-placeholder';
    if (config.showPlaceholder === false) placeholder.classList.add('compact');
    placeholder.setAttribute('role', 'status');

    const icon = document.createElement('span');
    icon.className = 'jxb-placeholder-icon';
    icon.innerHTML = EYE_OFF_SVG;
    placeholder.appendChild(icon);

    const copy = document.createElement('div');
    copy.className = 'jxb-placeholder-copy';
    copy.appendChild(document.createElement('strong'));
    const details = document.createElement('div');
    details.className = 'jxb-placeholder-details';
    copy.appendChild(details);
    placeholder.appendChild(copy);

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'jxb-restore';
    restore.addEventListener('click', () => {
      pipeline().revealTarget(article, target);
    });
    placeholder.appendChild(restore);

    fillPlaceholder(placeholder, target, matches);
    return placeholder;
  }

  function removePlaceholder(article) {
    const placeholder = article.previousElementSibling;
    if (placeholder && placeholder.matches('[data-jxb-placeholder]')) placeholder.remove();
    article.classList.remove('jxb-hidden', 'jxb-pending');
    article.style.removeProperty('display');
    article.style.removeProperty('visibility');
    setControlsSuppressed(article, false);
  }

  function clearAppliedStates() {
    document.querySelectorAll('[data-jxb-state="hidden"], [data-jxb-state="pending"]').forEach((article) => {
      removePlaceholder(article);
      article.removeAttribute('data-jxb-state');
      setControlsSuppressed(article, false);
    });
    document.querySelectorAll('[data-jxb-placeholder]').forEach((placeholder) => placeholder.remove());
  }

  function applySafe(article) {
    if (article.classList.contains('jxb-hidden') || article.style.display === 'none') removePlaceholder(article);
    article.dataset.jxbState = 'safe';
    article.classList.remove('jxb-pending');
    article.style.removeProperty('visibility');
    setControlsSuppressed(article, false);
    syncControlsForArticle(article);
  }

  function applyHidden(article, target, matches) {
    article.dataset.jxbState = 'hidden';
    article.classList.remove('jxb-pending');
    article.classList.add('jxb-hidden');
    article.style.display = 'none';
    if (!article.previousElementSibling || !article.previousElementSibling.matches('[data-jxb-placeholder]')) {
      article.parentNode && article.parentNode.insertBefore(createPlaceholder(article, target, matches), article);
    } else {
      fillPlaceholder(article.previousElementSibling, target, matches);
    }
    setControlsSuppressed(article, true);
    syncControlsForArticle(article);
  }

  // --------------------------------------------------------------------------
  // Hover check controls
  // --------------------------------------------------------------------------

  function getControlAnchor(control) {
    if (!control || !control.article || !control.article.isConnected) return null;
    const hidden = control.article.classList.contains('jxb-hidden') || control.article.style.display === 'none';
    if (hidden) return null;
    return control.article.querySelector(adapter().SELECTORS.userName) || control.article;
  }

  function getHoverAnchor(control) {
    if (!control || !control.article || !control.article.isConnected) return null;
    const hidden = control.article.classList.contains('jxb-hidden') || control.article.style.display === 'none';
    return hidden ? null : control.article;
  }

  function setControlsSuppressed(article, suppressed) {
    const disabled = suppressed || Boolean(pipeline().getConfig() && pipeline().getConfig().showCheckControls === false);
    for (const control of controls.values()) {
      if (control.article !== article) continue;
      control.host.hidden = disabled;
      control.host.setAttribute('aria-hidden', String(disabled));
      if (disabled) control.host.classList.remove('is-visible');
    }
  }

  function clearHideTimer(host) {
    const timer = hideTimers.get(host);
    if (timer) clearTimeout(timer);
    hideTimers.delete(host);
  }

  function showControl(control) {
    if (!control) return;
    clearHideTimer(control.host);
    control.host.classList.add('is-visible');
    positionCheckHost(control);
  }

  function hideControl(control) {
    if (!control) return;
    clearHideTimer(control.host);
    const timer = setTimeout(() => {
      if (!control.host.matches(':hover') && !control.host.matches(':focus-within')) control.host.classList.remove('is-visible');
    }, 180);
    hideTimers.set(control.host, timer);
  }

  function bindAnchor(anchor, control) {
    if (!anchor) return;
    anchorControls.set(anchor, control);
    if (boundAnchors.has(anchor)) return;
    boundAnchors.add(anchor);
    anchor.addEventListener('mouseenter', () => showControl(anchorControls.get(anchor)));
    anchor.addEventListener('mouseleave', () => hideControl(anchorControls.get(anchor)));
  }

  function syncControlsForArticle(article) {
    for (const control of controls.values()) {
      if (control.article !== article) continue;
      bindAnchor(getHoverAnchor(control), control);
      positionCheckHost(control);
    }
  }

  function positionCheckHost(control) {
    if (!control || !control.host) return;
    if (control.host.hidden) return;
    const anchor = getControlAnchor(control);
    if (!anchor) {
      control.host.classList.remove('is-visible');
      return;
    }
    const rect = anchor.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      control.host.classList.remove('is-visible');
      return;
    }
    const width = 54;
    const height = 26;
    const gap = 6;
    const preferredLeft = rect.right + gap;
    const left = preferredLeft + width <= window.innerWidth - 8
      ? preferredLeft
      : Math.max(8, rect.left - width - gap);
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, rect.top + (rect.height - height) / 2));
    control.host.style.left = `${left}px`;
    control.host.style.top = `${top}px`;
  }

  function positionAllControls() {
    positionFrame = null;
    for (const control of controls.values()) positionCheckHost(control);
  }

  function requestPosition() {
    if (positionFrame) return;
    const schedule = window.requestAnimationFrame || ((callback) => setTimeout(callback, 16));
    positionFrame = schedule(positionAllControls);
  }

  function ruleName(ruleId) {
    if (ruleId === 'combined_risk') return t('rule.combinedRisk');
    const rule = (pipeline().getConfig() && pipeline().getConfig().rules || []).find((candidate) => candidate.id === ruleId);
    if (rule && !rule.builtin) return rule.name;
    if (i18n.has(`rule.${ruleId}.name`)) return t(`rule.${ruleId}.name`);
    return rule ? rule.name : ruleId;
  }

  function renderResultRows(control, result) {
    control.rows.replaceChildren();
    if (!result || !result.ok || !result.results) return;
    for (const [ruleId, probability] of Object.entries(result.results)) {
      const row = document.createElement('div');
      row.className = 'jxb-check-row';
      const name = document.createElement('span');
      name.textContent = ruleName(ruleId);
      const score = document.createElement('strong');
      score.textContent = `${Math.round(Number(probability || 0) * 100)}%`;
      row.append(name, score);
      control.rows.appendChild(row);
    }
  }

  function renderCheckControl(control) {
    if (!control) return;
    const p = pipeline();
    const result = p.getProcessed(control.identity);
    const pending = Boolean(result && result.pending);
    const noun = t(control.target && control.target.kind === 'post' ? 'overlay.nounPost' : 'overlay.nounComment');
    control.button.textContent = pending ? t('overlay.checkingBtn') : t('overlay.check');
    control.button.disabled = pending;
    control.popoverTitle.textContent = t(control.target && control.target.kind === 'post' ? 'overlay.checkTitlePost' : 'overlay.checkTitleComment');
    control.recheck.hidden = true;
    control.rows.replaceChildren();

    if (!p.getConfig() || !p.getConfig().enabled) {
      control.status.textContent = t('overlay.statusPaused');
      control.detail.textContent = t('overlay.statusPausedDesc');
    } else if (!p.getHasApiKey()) {
      control.status.textContent = t('overlay.statusNoKey');
      control.detail.textContent = t('overlay.statusNoKeyDesc');
      control.recheck.hidden = false;
      control.recheck.textContent = t('overlay.statusOpenSettings');
    } else if (!result) {
      control.status.textContent = t('overlay.statusNotChecked');
      control.detail.textContent = t('overlay.statusNotCheckedDesc');
      control.recheck.hidden = false;
      control.recheck.textContent = t('overlay.statusStartCheck');
    } else if (pending) {
      control.status.textContent = t('overlay.statusChecking');
      control.detail.textContent = t('overlay.statusWaiting');
    } else if (result.ok) {
      control.status.textContent = result.shouldHide ? t('overlay.statusHit') : t('overlay.statusBelowThreshold');
      control.detail.textContent = t(result.shouldHide ? 'overlay.statusHitDesc' : 'overlay.statusBelowDesc', { noun });
      control.recheck.hidden = false;
      control.recheck.textContent = t('overlay.recheck');
      renderResultRows(control, result);
    } else {
      control.status.textContent = t('overlay.statusFailed');
      control.detail.textContent = t('overlay.statusFailedDesc', { e: result.error || 'API_UNAVAILABLE' });
      control.recheck.hidden = false;
      control.recheck.textContent = t('overlay.recheck');
    }
  }

  function renderCheckControlFor(identity) {
    renderCheckControl(controls.get(identity));
  }

  function createCheckControl(article, target, identity, hash) {
    const host = document.createElement('div');
    host.className = 'jxb-check-host';
    host.setAttribute('aria-label', t('overlay.ariaCheck'));

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jxb-check-button';
    button.textContent = t('overlay.check');
    button.title = t('overlay.checkBtnTitle');
    host.appendChild(button);

    const popover = document.createElement('div');
    popover.className = 'jxb-check-popover';
    popover.setAttribute('role', 'dialog');
    const popoverTitle = document.createElement('strong');
    popoverTitle.className = 'jxb-check-title';
    const status = document.createElement('div');
    status.className = 'jxb-check-status';
    const detail = document.createElement('p');
    detail.className = 'jxb-check-detail';
    const rows = document.createElement('div');
    rows.className = 'jxb-check-rows';
    const recheck = document.createElement('button');
    recheck.type = 'button';
    recheck.className = 'jxb-check-recheck';
    popover.append(popoverTitle, status, detail, rows, recheck);
    host.appendChild(popover);

    const control = { host, button, popover, popoverTitle, status, detail, rows, recheck, article, target, identity, hash };
    host.addEventListener('mouseenter', () => showControl(control));
    host.addEventListener('mouseleave', () => hideControl(control));
    host.addEventListener('focusin', () => showControl(control));
    host.addEventListener('focusout', () => hideControl(control));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!pipeline().getHasApiKey()) {
        pipeline().send(core.MESSAGE.OPEN_SETTINGS);
        return;
      }
      const result = pipeline().getProcessed(control.identity);
      pipeline().classifyTarget(control.article, control.target, { force: Boolean(result && !result.pending), hash: control.hash, identity: control.identity });
    });
    recheck.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!pipeline().getHasApiKey()) {
        pipeline().send(core.MESSAGE.OPEN_SETTINGS);
        return;
      }
      pipeline().classifyTarget(control.article, control.target, { force: true, hash: control.hash, identity: control.identity });
    });
    document.body.appendChild(host);
    return control;
  }

  function ensureCheckControl(article, target, identity, hash) {
    let control = controls.get(identity);
    if (!control) {
      control = createCheckControl(article, target, identity, hash);
      controls.set(identity, control);
    } else {
      control.article = article;
      control.target = target;
      control.hash = hash;
    }
    setControlsSuppressed(article, article.classList.contains('jxb-hidden') || article.style.display === 'none');
    bindAnchor(getHoverAnchor(control), control);
    renderCheckControl(control);
    positionCheckHost(control);
    return control;
  }

  function clearControls() {
    for (const control of controls.values()) control.host.remove();
    controls.clear();
  }

  // Periodic GC: X unmounts articles constantly, so drop their fixed-position
  // hosts and orphaned placeholders before they accumulate.
  function cleanupSweep() {
    for (const [identity, control] of controls) {
      if (!control.article.isConnected) {
        control.host.remove();
        controls.delete(identity);
      }
    }
    document.querySelectorAll('[data-jxb-placeholder]').forEach((placeholder) => {
      const sibling = placeholder.nextElementSibling;
      if (!sibling || !sibling.matches('article[data-testid="tweet"]')) placeholder.remove();
    });
  }

  // --------------------------------------------------------------------------
  // Monitor widget
  // --------------------------------------------------------------------------

  function scopeSummary(config) {
    const scopes = (config && config.scopes) || core.DEFAULT_SCOPES;
    const labels = [
      scopes.detailReplies && t('scope.detailReplies'),
      scopes.detailRoot && t('scope.detailRoot'),
      scopes.timeline && t('scope.timeline'),
      scopes.search && t('scope.search'),
      scopes.profile && t('scope.profile'),
      scopes.explore && t('scope.explore')
    ].filter(Boolean);
    return labels.length ? labels.join(t('scope.summaryJoin')) : t('scope.summaryAllOff');
  }

  function renderMonitor() {
    if (!monitor) return;
    const p = pipeline();
    const state = p.state;
    const config = p.getConfig();
    // The monitor can be dismissed from the widget itself; the settings
    // toggle brings it back.
    monitor.root.style.display = config && config.showMonitor === false ? 'none' : '';
    const context = adapter().pageContext();
    const active = adapter().pageInScope(config, context);
    const detail = !active
      ? t('overlay.monitorNoScope')
      : !config || !config.enabled
        ? t('overlay.monitorPaused')
        : !p.getHasApiKey()
          ? t('overlay.monitorNoKey')
          : state.pagePending
            ? t('overlay.monitorBusy')
            : state.pageErrors
              ? t('overlay.monitorErrors')
              : t('overlay.monitorDone');
    monitor.status.textContent = detail;
    monitor.summary.textContent = t('overlay.monitorSummary', { checked: state.pageChecked, hidden: state.pageHidden });
    monitor.scopes.textContent = scopeSummary(config);
    monitor.checked.textContent = String(state.pageChecked);
    monitor.hidden.textContent = String(state.pageHidden);
    monitor.pending.textContent = String(state.pagePending);
    monitor.safe.textContent = String(state.pageSafe);
    monitor.posts.textContent = String(state.pagePostHidden);
    monitor.latency.textContent = state.pageLastLatency ? `${state.pageLastLatency}ms` : '—';
    monitor.api.textContent = p.getHasApiKey() ? t('common.connected') : t('common.disconnected');
    monitor.dot.className = `jxb-monitor-dot ${state.pagePending ? 'is-busy' : p.getHasApiKey() && config && config.enabled ? 'is-ready' : 'is-warn'}`;
  }

  function createMonitor() {
    if (monitor || !document.body) return;
    const rootEl = document.createElement('aside');
    rootEl.className = 'jxb-monitor';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jxb-monitor-button';
    button.setAttribute('aria-expanded', 'false');
    const dot = document.createElement('span');
    dot.className = 'jxb-monitor-dot';
    const label = document.createElement('span');
    const summary = document.createElement('small');
    summary.className = 'jxb-monitor-summary';
    button.append(dot, label, summary);

    const panel = document.createElement('div');
    panel.className = 'jxb-monitor-panel';
    const title = document.createElement('strong');
    const status = document.createElement('p');
    status.className = 'jxb-monitor-status';
    const grid = document.createElement('div');
    grid.className = 'jxb-monitor-grid';
    const metric = (captionKey) => {
      const item = document.createElement('div');
      const value = document.createElement('strong');
      const caption = document.createElement('span');
      item.append(value, caption);
      grid.appendChild(item);
      return { value, caption, captionKey };
    };
    const metrics = {
      checked: metric('overlay.metricChecked'),
      hidden: metric('overlay.metricHidden'),
      pending: metric('overlay.metricPending'),
      safe: metric('overlay.metricSafe'),
      posts: metric('overlay.metricPostsHidden'),
      latency: metric('overlay.metricLatency')
    };
    const scopes = document.createElement('p');
    scopes.className = 'jxb-monitor-scopes';
    const api = document.createElement('p');
    api.className = 'jxb-monitor-api';
    const actions = document.createElement('div');
    actions.className = 'jxb-monitor-actions';
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'jxb-monitor-settings';
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'jxb-monitor-settings jxb-monitor-hide';
    hide.addEventListener('click', async () => {
      monitor.root.style.display = 'none';
      await pipeline().send(core.MESSAGE.SAVE_CONFIG, { showMonitor: false });
    });
    actions.append(settings, hide);
    panel.append(title, status, grid, scopes, api, actions);
    rootEl.append(button, panel);
    button.addEventListener('click', () => {
      const open = !rootEl.classList.contains('is-open');
      rootEl.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
    });
    settings.addEventListener('click', () => pipeline().send(core.MESSAGE.OPEN_SETTINGS));
    document.body.appendChild(rootEl);
    monitor = { root: rootEl, button, dot, summary, status, scopes, api, settings, hide, title, label, ...metrics };
    fillMonitorTexts();
    renderMonitor();
  }

  function fillMonitorTexts() {
    if (!monitor) return;
    monitor.label.textContent = t('overlay.monitorButton');
    monitor.title.textContent = t('overlay.monitorTitle');
    monitor.settings.textContent = t('overlay.monitorOpenSettings');
    monitor.hide.textContent = t('overlay.monitorHide');
    monitor.hide.title = t('overlay.monitorHideTitle');
    for (const { caption, captionKey } of [monitor.checked, monitor.hidden, monitor.pending, monitor.safe, monitor.posts, monitor.latency]) {
      caption.textContent = t(captionKey);
    }
  }

  // Re-render every live text node after the interface language changes.
  function refreshTexts() {
    document.querySelectorAll('[data-jxb-placeholder]').forEach((placeholder) => {
      const article = placeholder.nextElementSibling;
      if (article && article.matches('article[data-testid="tweet"]')) {
        fillPlaceholder(placeholder, { kind: placeholder.__jxbKind || 'comment' }, placeholder.__jxbMatches || []);
      }
    });
    for (const control of controls.values()) renderCheckControl(control);
    if (monitor) {
      // Rebuild the widget so static labels re-resolve, preserving state.
      const wasOpen = monitor.root.classList.contains('is-open');
      const display = monitor.root.style.display;
      monitor.root.remove();
      monitor = null;
      createMonitor();
      monitor.root.classList.toggle('is-open', wasOpen);
      monitor.root.style.display = display;
      renderMonitor();
    }
  }

  root.JevXBlocker = Object.assign(root.JevXBlocker || {}, {
    overlay: {
      injectStyles,
      createMonitor,
      renderMonitor,
      refreshTexts,
      ensureCheckControl,
      renderCheckControl,
      renderCheckControlFor,
      applySafe,
      applyHidden,
      removePlaceholder,
      clearAppliedStates,
      setControlsSuppressed,
      clearControls,
      cleanupSweep,
      requestPosition,
      controls: () => controls.entries()
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
