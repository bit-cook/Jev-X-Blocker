(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Overlay UI: hidden-content placeholders, per-article hover check controls
  // and the page monitor widget. All nodes carry jxb- classes / data-jxb-*
  // attributes so the MutationObserver in main.js can ignore its own writes.
  // ---------------------------------------------------------------------------

  const core = root.JevXBlocker;

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

  const KIND_NOUN = { comment: '评论', post: '帖子' };

  const EYE_OFF_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function createPlaceholder(article, target, matches) {
    const config = pipeline().getConfig() || {};
    const compact = config.showPlaceholder === false;
    const noun = KIND_NOUN[target.kind] || '内容';
    const placeholder = document.createElement('div');
    placeholder.dataset.jxbPlaceholder = 'true';
    placeholder.className = 'jxb-placeholder';
    if (compact) placeholder.classList.add('compact');
    placeholder.setAttribute('role', 'status');

    const icon = document.createElement('span');
    icon.className = 'jxb-placeholder-icon';
    icon.innerHTML = EYE_OFF_SVG;
    placeholder.appendChild(icon);

    const copy = document.createElement('div');
    copy.className = 'jxb-placeholder-copy';
    const title = document.createElement('strong');
    title.textContent = compact ? `已隐藏一条${noun}` : `Jev X Blocker 隐藏了一条${noun}`;
    copy.appendChild(title);
    const details = document.createElement('div');
    details.className = 'jxb-placeholder-details';
    details.textContent = compact ? '点击"查看"恢复' : (matches || []).map((match) => {
      if (config.showConfidence === false) return match.name;
      const score = match.source === 'combined-risk-signal'
        ? ` · 合计 ${Math.round(match.combinedScore * 100)}%`
        : ` · ${Math.round(match.probability * 100)}%`;
      return `${match.name}${score}`;
    }).join('  ') || `未命中展示规则 · ${noun}`;
    copy.appendChild(details);
    placeholder.appendChild(copy);

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'jxb-restore';
    restore.textContent = `查看${noun}`;
    restore.addEventListener('click', () => {
      pipeline().revealTarget(article, target);
    });
    placeholder.appendChild(restore);
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
    const rule = (pipeline().getConfig() && pipeline().getConfig().rules || []).find((candidate) => candidate.id === ruleId);
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
    const target = control.target;
    const noun = KIND_NOUN[target && target.kind] || '内容';
    control.button.textContent = pending ? '检查中' : '检查';
    control.button.disabled = pending;
    control.popoverTitle.textContent = `${noun}检查`;
    control.recheck.hidden = true;
    control.rows.replaceChildren();

    if (!p.getConfig() || !p.getConfig().enabled) {
      control.status.textContent = '保护已暂停';
      control.detail.textContent = '打开插件后可恢复检查。';
    } else if (!p.getHasApiKey()) {
      control.status.textContent = '等待 API Key';
      control.detail.textContent = '先连接 TypeSafe，内容会保持显示。';
      control.recheck.hidden = false;
      control.recheck.textContent = '打开设置';
    } else if (!result) {
      control.status.textContent = '尚未检查';
      control.detail.textContent = '点击按钮开始检查。';
      control.recheck.hidden = false;
      control.recheck.textContent = '开始检查';
    } else if (pending) {
      control.status.textContent = '正在检查…';
      control.detail.textContent = 'TypeSafe 正在返回结果。';
    } else if (result.ok) {
      control.status.textContent = result.shouldHide ? '命中隐藏规则' : '未命中隐藏阈值';
      control.detail.textContent = result.shouldHide ? `这条${noun}已按当前规则处理。` : `这条${noun}当前保持显示。`;
      control.recheck.hidden = false;
      control.recheck.textContent = '重新检查';
      renderResultRows(control, result);
    } else {
      control.status.textContent = '检查失败，保持显示';
      control.detail.textContent = `错误：${result.error || 'API_UNAVAILABLE'}（Fail Open）`;
      control.recheck.hidden = false;
      control.recheck.textContent = '重新检查';
    }
  }

  function renderCheckControlFor(identity) {
    renderCheckControl(controls.get(identity));
  }

  function createCheckControl(article, target, identity, hash) {
    const host = document.createElement('div');
    host.className = 'jxb-check-host';
    host.setAttribute('aria-label', '内容检查');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jxb-check-button';
    button.textContent = '检查';
    button.title = '检查这条内容';
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
      scopes.detailReplies && '评论',
      scopes.detailRoot && '主帖',
      scopes.timeline && '时间线',
      scopes.search && '搜索',
      scopes.profile && '主页',
      scopes.explore && '探索'
    ].filter(Boolean);
    return labels.length ? labels.join(' · ') : '所有范围已关闭';
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
      ? '当前页面不在过滤范围'
      : !config || !config.enabled
        ? '保护已暂停'
        : !p.getHasApiKey()
          ? '等待配置 TypeSafe API Key'
          : state.pagePending
            ? '正在检查当前页面'
            : state.pageErrors
              ? '部分检查失败，内容保持显示'
              : '当前页面检查完成';
    monitor.status.textContent = detail;
    monitor.summary.textContent = `已检查 ${state.pageChecked} · 隐藏 ${state.pageHidden}`;
    monitor.scopes.textContent = scopeSummary(config);
    monitor.checked.textContent = String(state.pageChecked);
    monitor.hidden.textContent = String(state.pageHidden);
    monitor.pending.textContent = String(state.pagePending);
    monitor.safe.textContent = String(state.pageSafe);
    monitor.posts.textContent = String(state.pagePostHidden);
    monitor.latency.textContent = state.pageLastLatency ? `${state.pageLastLatency}ms` : '—';
    monitor.api.textContent = p.getHasApiKey() ? 'TypeSafe 已连接' : '未连接 TypeSafe';
    monitor.dot.className = `jxb-monitor-dot ${state.pagePending ? 'is-busy' : p.getHasApiKey() && config && config.enabled ? 'is-ready' : 'is-warn'}`;
  }

  function createMonitor() {
    if (monitor || !document.body) return;
    const root = document.createElement('aside');
    root.className = 'jxb-monitor';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jxb-monitor-button';
    button.setAttribute('aria-expanded', 'false');
    const dot = document.createElement('span');
    dot.className = 'jxb-monitor-dot';
    const label = document.createElement('span');
    label.textContent = '检查情况';
    const summary = document.createElement('small');
    summary.className = 'jxb-monitor-summary';
    button.append(dot, label, summary);

    const panel = document.createElement('div');
    panel.className = 'jxb-monitor-panel';
    const title = document.createElement('strong');
    title.textContent = '当前检查情况';
    const status = document.createElement('p');
    status.className = 'jxb-monitor-status';
    const grid = document.createElement('div');
    grid.className = 'jxb-monitor-grid';
    const metric = (name) => {
      const item = document.createElement('div');
      const value = document.createElement('strong');
      const caption = document.createElement('span');
      caption.textContent = name;
      item.append(value, caption);
      grid.appendChild(item);
      return value;
    };
    const checked = metric('已检查');
    const hidden = metric('已隐藏');
    const pending = metric('待处理');
    const safe = metric('已放行');
    const posts = metric('帖子已隐藏');
    const latency = metric('最近延迟');
    const scopes = document.createElement('p');
    scopes.className = 'jxb-monitor-scopes';
    const api = document.createElement('p');
    api.className = 'jxb-monitor-api';
    const actions = document.createElement('div');
    actions.className = 'jxb-monitor-actions';
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'jxb-monitor-settings';
    settings.textContent = '打开设置';
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'jxb-monitor-settings jxb-monitor-hide';
    hide.textContent = '隐藏浮窗';
    hide.title = '隐藏后仍会正常过滤，可在设置的“显示与交互”里重新打开';
    hide.addEventListener('click', async () => {
      monitor.root.style.display = 'none';
      await pipeline().send(core.MESSAGE.SAVE_CONFIG, { showMonitor: false });
    });
    actions.append(settings, hide);
    panel.append(title, status, grid, scopes, api, actions);
    root.append(button, panel);
    button.addEventListener('click', () => {
      const open = !root.classList.contains('is-open');
      root.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
    });
    settings.addEventListener('click', () => pipeline().send(core.MESSAGE.OPEN_SETTINGS));
    document.body.appendChild(root);
    monitor = { root, button, dot, summary, status, scopes, checked, hidden, pending, safe, posts, latency, api };
    renderMonitor();
  }

  root.JevXBlocker = Object.assign(root.JevXBlocker || {}, {
    overlay: {
      injectStyles,
      createMonitor,
      renderMonitor,
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
