(function () {
  'use strict';
  const E = globalThis.JevXBlocker;
  const I = globalThis.JevI18n;
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

  function ruleDisplayName(rule) {
    if (!rule.builtin) return rule.name;
    const key = `rule.${rule.id}.name`;
    return I.has(key) ? I.t(key) : rule.name;
  }

  function ruleMetaSuffix(rule) {
    if (rule.applyTo.length === 2) return '';
    return I.t(rule.applyTo[0] === 'post' ? 'rule.postsOnly' : 'rule.commentsOnly');
  }

  function renderVersion() {
    const version = 'v' + chrome.runtime.getManifest().version;
    const label = $('versionLabel');
    if (label) label.textContent = version;
    const footer = $('footerVersion');
    if (footer) footer.textContent = version + ' · TypeSafe Jev';
  }

  function renderThemeSeg() {
    const seg = $('themeSeg');
    if (!seg || !currentState) return;
    seg.querySelectorAll('button').forEach((btn) => btn.classList.toggle('active', btn.dataset.themeValue === currentState.config.theme));
  }

  document.querySelectorAll('#themeSeg button').forEach((btn) => btn.addEventListener('click', async () => {
    applyTheme(btn.dataset.themeValue);
    const response = await send(E.MESSAGE.SAVE_CONFIG, { theme: btn.dataset.themeValue });
    if (response.ok) { await refresh(); I.applyDocument(); toast(I.t(btn.dataset.themeValue === 'system' ? 'settings.toastThemeSystem' : btn.dataset.themeValue === 'dark' ? 'settings.toastThemeDark' : 'settings.toastThemeLight'), 'success'); }
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

  const SCOPE_KEYS = [
    ['detailReplies', 'scope.detailReplies'],
    ['detailRoot', 'scope.detailRoot'],
    ['timeline', 'scope.timeline'],
    ['search', 'scope.search'],
    ['profile', 'scope.profile'],
    ['explore', 'scope.explore']
  ];

  function scopeSummary(config) {
    const labels = SCOPE_KEYS.filter(([key]) => config.scopes[key]).map(([, key]) => I.t(key));
    return labels.length ? labels.join(I.t('scope.summaryJoin')) : I.t('scope.summaryAllOff');
  }

  function renderRules(config) {
    const enabled = config.rules.filter((rule) => rule.enabled);
    $('ruleCount').textContent = String(enabled.length).padStart(2, '0');
    $('ruleList').replaceChildren(...config.rules.map((rule) => {
      const row = document.createElement('div');
      row.className = 'jxb-rule-row';
      const icon = document.createElement('span'); icon.className = 'jxb-rule-icon'; icon.textContent = rule.builtin ? '◈' : '＋';
      const copy = document.createElement('span'); copy.className = 'jxb-rule-copy';
      const name = document.createElement('strong'); name.className = 'jxb-rule-name'; name.textContent = ruleDisplayName(rule);
      const desc = document.createElement('span'); desc.className = 'jxb-rule-meta';
      const descText = !rule.builtin || !I.has(`rule.${rule.id}.desc`) ? rule.description : I.t(`rule.${rule.id}.desc`);
      desc.textContent = rule.enabled ? descText + ruleMetaSuffix(rule) : I.t('popup.ruleDisabled');
      copy.append(name, desc);
      const chip = document.createElement('span'); chip.className = `jxb-chip ${rule.enabled ? 'green' : ''}`; chip.textContent = rule.enabled ? `${Math.round(rule.threshold * 100)}%` : I.t('common.off');
      row.append(icon, copy, chip);
      row.style.opacity = rule.enabled ? '1' : '.55';
      return row;
    }));
  }

  function render(state) {
    currentState = state;
    const config = state.config;
    const stats = state.stats;
    I.setOverride(config.uiLang);
    I.applyDocument();
    if (document.body.classList.contains('jxb-standalone')) document.title = 'Jev X Blocker · ' + I.t('common.console');
    applyTheme(config.theme);
    const headerStatus = $('headerStatus');
    if (headerStatus) headerStatus.innerHTML = state.hasApiKey
      ? `<span class="jxb-dot"></span>${I.t('common.ready')}`
      : `<span class="jxb-dot warn"></span>${I.t('common.keyRequired')}`;
    $('enabledToggle').checked = config.enabled;
    $('shield').classList.toggle('off', !config.enabled || !state.hasApiKey);
    $('statusTitle').textContent = I.t('popup.statusTitle');
    $('statusBadge').textContent = !state.hasApiKey ? I.t('popup.shieldKeyRequired') : config.enabled ? I.t('popup.shieldOn') : I.t('popup.shieldPaused');
    $('statusBadge').className = `jxb-chip ${state.hasApiKey && config.enabled ? 'green' : 'amber'}`;
    $('checkedCount').textContent = String((stats.totalChecked || 0) + (stats.totalPostsChecked || 0));
    $('hiddenCount').textContent = String((stats.totalHidden || 0) + (stats.totalPostsHidden || 0));
    $('hiddenBreakdown').textContent = I.t('popup.breakdown', { replies: stats.totalHidden || 0, posts: stats.totalPostsHidden || 0 });
    $('requestCount').textContent = String(stats.requests || 0);
    $('scopeSummary').textContent = scopeSummary(config);
    const apiStatus = $('apiStatus');
    apiStatus.replaceChildren();
    const dot = document.createElement('span'); dot.className = `jxb-dot ${state.hasApiKey ? '' : 'warn'}`;
    apiStatus.append(dot, document.createTextNode(state.hasApiKey
      ? (stats.latencyMs ? I.t('common.connectedWithLatency', { ms: stats.latencyMs }) : I.t('common.connected'))
      : I.t('common.disconnected')));
    $('connectPanel').classList.toggle('jxb-hidden', state.hasApiKey);
    renderRules(config);
    renderVersion();
    renderThemeSeg();
  }

  async function refresh() {
    const response = await send(E.MESSAGE.GET_STATE);
    if (response.ok) render(response);
  }

  $('enabledToggle').addEventListener('change', async (event) => {
    const response = await send(E.MESSAGE.SAVE_CONFIG, { enabled: event.target.checked });
    if (response.ok) { await refresh(); toast(I.t(event.target.checked ? 'popup.toastOn' : 'popup.toastOff'), 'success'); }
  });

  $('settingsButton').addEventListener('click', () => send(E.MESSAGE.OPEN_SETTINGS));
  $('onboardingButton').addEventListener('click', () => send(E.MESSAGE.OPEN_ONBOARDING));

  $('saveKeyButton').addEventListener('click', async () => {
    const apiKey = $('apiKeyInput').value.trim();
    const message = $('connectMessage');
    message.classList.add('jxb-hidden');
    if (!apiKey) { message.textContent = I.t('popup.errNoKey'); message.classList.remove('jxb-hidden'); return; }
    $('saveKeyButton').disabled = true;
    $('saveKeyButton').textContent = I.t('popup.testing');
    const test = await send(E.MESSAGE.TEST_CONNECTION, { apiKey });
    if (!test.ok) {
      message.textContent = I.t('popup.errConnect', { e: test.error || 'API_UNAVAILABLE' });
      message.classList.remove('jxb-hidden');
    } else {
      await send(E.MESSAGE.SAVE_API_KEY, { apiKey });
      await send(E.MESSAGE.SAVE_CONFIG, { onboardingCompleted: true });
      $('apiKeyInput').value = '';
      toast(I.t('popup.toastConnected', { ms: test.latencyMs }), 'success');
      await refresh();
    }
    $('saveKeyButton').disabled = false;
    $('saveKeyButton').textContent = I.t('popup.connect');
  });

  refresh();
})();
