(function () {
  'use strict';
  const E = globalThis.JevXBlocker;
  const $ = (id) => document.getElementById(id);
  let step = 0;
  let selectedRules = E.clone(E.DEFAULT_RULES);
  let selectedScopes = E.clone(E.DEFAULT_SCOPES);

  const SCOPE_OPTIONS = [
    ['detailReplies', '详情页评论', '原版功能：帖子详情页的回复'],
    ['detailRoot', '详情页主帖', '详情页顶部的帖子本身'],
    ['timeline', '首页时间线', 'For You / Following 信息流'],
    ['search', '搜索结果', '/search 的帖子结果'],
    ['profile', '个人主页', 'x.com/{user} 的时间线'],
    ['explore', '探索页', '/explore 热门帖子（默认关闭）']
  ];

  function send(type, payload) { return new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, (response) => resolve(response || { ok: false, error: 'NO_RESPONSE' }))); }
  function applyTheme(theme) {
    const resolved = theme === 'light' || theme === 'dark'
      ? theme
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.jxbTheme = resolved;
  }
  send(E.MESSAGE.GET_STATE).then((response) => { if (response && response.config) applyTheme(response.config.theme); });
  function showStep(next) { step = next; document.querySelectorAll('[data-step]').forEach((node) => node.classList.toggle('active', Number(node.dataset.step) === step)); document.querySelectorAll('.jxb-stepper span').forEach((node, index) => node.classList.toggle('active', index <= step)); }
  function showError(message) { $('connectionStatus').textContent = message; $('connectionStatus').classList.remove('jxb-hidden'); }
  function renderRules() { $('onboardingRules').replaceChildren(...selectedRules.map((rule) => { const label = document.createElement('label'); label.className = 'jxb-check'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true; input.dataset.ruleId = rule.id; const copy = document.createElement('span'); const title = document.createElement('strong'); title.textContent = rule.name; const desc = document.createElement('small'); desc.textContent = rule.description; copy.append(title, desc); label.append(input, copy); return label; })); }
  function renderScopes() { $('onboardingScopes').replaceChildren(...SCOPE_OPTIONS.map(([key, name, description]) => { const label = document.createElement('label'); label.className = 'jxb-check'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selectedScopes[key]; input.dataset.scopeId = key; const copy = document.createElement('span'); const title = document.createElement('strong'); title.textContent = name; const desc = document.createElement('small'); desc.textContent = description; copy.append(title, desc); label.append(input, copy); return label; })); }

  $('testConnectionButton').addEventListener('click', async () => { const key = $('onboardingKey').value.trim(); if (!key) { showError('请先输入 API Key。'); return; } $('testConnectionButton').disabled = true; $('testConnectionButton').textContent = '握手中…'; const result = await send(E.MESSAGE.TEST_CONNECTION, { apiKey: key }); $('testConnectionButton').disabled = false; $('testConnectionButton').textContent = '测试连接'; if (!result.ok) { showError(`连接失败：${result.error || 'API_UNAVAILABLE'}。请检查 Key 后重试。`); return; } $('connectionStatus').className = 'jxb-help jxb-success'; $('connectionStatus').textContent = `连接成功 · ${result.latencyMs}ms`; });
  $('nextButton').addEventListener('click', async () => { const key = $('onboardingKey').value.trim(); if (!key) { showError('请输入 TypeSafe API Key。'); return; } const result = await send(E.MESSAGE.TEST_CONNECTION, { apiKey: key }); if (!result.ok) { showError(`连接失败：${result.error || 'API_UNAVAILABLE'}。`); return; } await send(E.MESSAGE.SAVE_API_KEY, { apiKey: key }); renderRules(); renderScopes(); showStep(1); });
  $('backButton').addEventListener('click', () => showStep(0));
  $('finishButton').addEventListener('click', async () => {
    const enabledIds = new Set(Array.from(document.querySelectorAll('#onboardingRules input:checked')).map((node) => node.dataset.ruleId));
    const rules = selectedRules.map((rule) => ({ ...rule, enabled: enabledIds.has(rule.id) }));
    const scopes = { ...selectedScopes };
    for (const node of document.querySelectorAll('#onboardingScopes input:checked')) scopes[node.dataset.scopeId] = true;
    for (const node of document.querySelectorAll('#onboardingScopes input:not(:checked)')) scopes[node.dataset.scopeId] = false;
    await send(E.MESSAGE.SAVE_CONFIG, { rules, scopes, enabled: true, onboardingCompleted: true });
    showStep(2);
  });
  $('openSettingsButton').addEventListener('click', () => send(E.MESSAGE.OPEN_SETTINGS));
  $('doneButton').addEventListener('click', () => window.close());
  renderScopes();
})();
