(function () {
  'use strict';
  const E = globalThis.JevXBlocker;
  const $ = (id) => document.getElementById(id);
  let currentState;

  // popup.html doubles as the standalone 扩展控制台 page (opened from the
  // settings nav with ?view=console); that mode shows the shared header.
  if (new URLSearchParams(location.search).get('view') === 'console') {
    document.body.classList.add('jxb-standalone');
  }

  function applyTheme(theme) {
    const resolved = theme === 'light' || theme === 'dark'
      ? theme
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.jxbTheme = resolved;
  }

  function renderThemeSeg() {
    const seg = $('themeSeg');
    if (!seg || !currentState) return;
    seg.querySelectorAll('button').forEach((btn) => btn.classList.toggle('active', btn.dataset.themeValue === currentState.config.theme));
  }

  document.querySelectorAll('#themeSeg button').forEach((btn) => btn.addEventListener('click', async () => {
    applyTheme(btn.dataset.themeValue);
    const response = await send(E.MESSAGE.SAVE_CONFIG, { theme: btn.dataset.themeValue });
    if (response.ok) { await refresh(); toast(btn.dataset.themeValue === 'system' ? '已跟随系统主题' : btn.dataset.themeValue === 'dark' ? '已切换到深色' : '已切换到浅色', 'success'); }
  }));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentState && currentState.config.theme === 'system') applyTheme('system');
  });

  function send(type, payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, (response) => resolve(response || { ok: false, error: 'NO_RESPONSE' })));
  }

  function toast(message, kind) {
    const node = $('toast');
    node.textContent = message;
    node.className = `jxb-toast ${kind || ''}`;
    setTimeout(() => node.classList.add('jxb-hidden'), 2600);
  }

  const SCOPE_LABELS = [
    ['detailReplies', '评论'],
    ['detailRoot', '主帖'],
    ['timeline', '时间线'],
    ['search', '搜索'],
    ['profile', '主页'],
    ['explore', '探索']
  ];

  function scopeSummary(config) {
    const labels = SCOPE_LABELS.filter(([key]) => config.scopes[key]).map(([, label]) => label);
    return labels.length ? `过滤范围：${labels.join(' · ')}` : '所有过滤范围已关闭';
  }

  function renderRules(config) {
    const enabled = config.rules.filter((rule) => rule.enabled);
    $('ruleCount').textContent = String(enabled.length).padStart(2, '0');
    $('ruleList').replaceChildren(...config.rules.map((rule) => {
      const row = document.createElement('div');
      row.className = 'jxb-rule-row';
      const icon = document.createElement('span'); icon.className = 'jxb-rule-icon'; icon.textContent = rule.builtin ? '◈' : '＋';
      const copy = document.createElement('span'); copy.className = 'jxb-rule-copy';
      const name = document.createElement('strong'); name.className = 'jxb-rule-name'; name.textContent = rule.name;
      const applies = rule.applyTo.length === 2 ? '' : rule.applyTo[0] === 'post' ? ' · 仅帖子' : ' · 仅评论';
      const meta = document.createElement('span'); meta.className = 'jxb-rule-meta'; meta.textContent = rule.enabled ? rule.description + applies : '规则已停用';
      copy.append(name, meta);
      const chip = document.createElement('span'); chip.className = `jxb-chip ${rule.enabled ? 'green' : ''}`; chip.textContent = rule.enabled ? `${Math.round(rule.threshold * 100)}%` : 'OFF';
      row.append(icon, copy, chip);
      row.style.opacity = rule.enabled ? '1' : '.55';
      return row;
    }));
  }

  function render(state) {
    currentState = state;
    const config = state.config;
    const stats = state.stats;
    applyTheme(config.theme);
    const headerStatus = $('headerStatus');
    if (headerStatus) headerStatus.innerHTML = state.hasApiKey ? '<span class="jxb-dot"></span> 防护已就绪' : '<span class="jxb-dot warn"></span> 需要 API Key';
    $('enabledToggle').checked = config.enabled;
    $('shield').classList.toggle('off', !config.enabled || !state.hasApiKey);
    $('statusTitle').textContent = config.enabled ? '保护状态' : '保护已暂停';
    $('statusBadge').textContent = !state.hasApiKey ? 'KEY REQUIRED' : config.enabled ? 'SHIELD ON' : 'PAUSED';
    $('statusBadge').className = `jxb-chip ${state.hasApiKey && config.enabled ? 'green' : 'amber'}`;
    $('checkedCount').textContent = String((stats.totalChecked || 0) + (stats.totalPostsChecked || 0));
    $('hiddenCount').textContent = String((stats.totalHidden || 0) + (stats.totalPostsHidden || 0));
    $('hiddenBreakdown').textContent = `评论 ${stats.totalHidden || 0} · 帖子 ${stats.totalPostsHidden || 0}`;
    $('requestCount').textContent = String(stats.requests || 0);
    $('scopeSummary').textContent = scopeSummary(config);
    const apiStatus = $('apiStatus'); apiStatus.replaceChildren(); const dot = document.createElement('span'); dot.className = `jxb-dot ${state.hasApiKey ? '' : 'warn'}`; apiStatus.append(dot, document.createTextNode(state.hasApiKey ? ` TypeSafe 已连接${stats.latencyMs ? ` · ${stats.latencyMs}ms` : ''}` : ' 未连接 TypeSafe'));
    $('connectPanel').classList.toggle('jxb-hidden', state.hasApiKey);
    renderRules(config);
    renderThemeSeg();
  }

  async function refresh() {
    const response = await send(E.MESSAGE.GET_STATE);
    if (response.ok) render(response);
  }

  $('enabledToggle').addEventListener('change', async (event) => {
    const response = await send(E.MESSAGE.SAVE_CONFIG, { enabled: event.target.checked });
    if (response.ok) { await refresh(); toast(event.target.checked ? '保护已开启' : '保护已暂停', 'success'); }
  });

  $('settingsButton').addEventListener('click', () => send(E.MESSAGE.OPEN_SETTINGS));
  $('onboardingButton').addEventListener('click', () => send(E.MESSAGE.OPEN_ONBOARDING));

  $('saveKeyButton').addEventListener('click', async () => {
    const apiKey = $('apiKeyInput').value.trim();
    const message = $('connectMessage');
    message.classList.add('jxb-hidden');
    if (!apiKey) { message.textContent = '请输入 API Key。'; message.classList.remove('jxb-hidden'); return; }
    $('saveKeyButton').disabled = true;
    $('saveKeyButton').textContent = '测试中…';
    const test = await send(E.MESSAGE.TEST_CONNECTION, { apiKey });
    if (!test.ok) {
      message.textContent = `连接失败：${test.error || 'API_UNAVAILABLE'}。插件会保持放行。`;
      message.classList.remove('jxb-hidden');
    } else {
      await send(E.MESSAGE.SAVE_API_KEY, { apiKey });
      await send(E.MESSAGE.SAVE_CONFIG, { onboardingCompleted: true });
      $('apiKeyInput').value = '';
      toast(`连接成功 · ${test.latencyMs}ms`, 'success');
      await refresh();
    }
    $('saveKeyButton').disabled = false;
    $('saveKeyButton').textContent = '连接';
  });

  refresh();
})();
