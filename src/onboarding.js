(function () {
  'use strict';
  const E = globalThis.JevXBlocker;
  const I = globalThis.JevI18n;
  const $ = (id) => document.getElementById(id);
  let step = 0;
  let selectedRules = E.clone(E.DEFAULT_RULES);
  let selectedScopes = E.clone(E.DEFAULT_SCOPES);

  const SCOPE_OPTIONS = [
    ['detailReplies'],
    ['detailRoot'],
    ['timeline'],
    ['search'],
    ['profile'],
    ['explore']
  ];

  function send(type, payload) { return new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, (response) => resolve(response || { ok: false, error: 'NO_RESPONSE' }))); }
  function applyTheme(theme) {
    const resolved = theme === 'light' || theme === 'dark'
      ? theme
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.jxbTheme = resolved;
  }
  send(E.MESSAGE.GET_STATE).then((response) => {
    if (response && response.config) {
      applyTheme(response.config.theme);
      I.setOverride(response.config.uiLang);
      I.applyDocument();
    }
  });
  const versionLabel = $('versionLabel');
  if (versionLabel) versionLabel.textContent = I.t('onboarding.footerVersion', { v: chrome.runtime.getManifest().version });
  function showStep(next) { step = next; document.querySelectorAll('[data-step]').forEach((node) => node.classList.toggle('active', Number(node.dataset.step) === step)); document.querySelectorAll('.jxb-stepper span').forEach((node, index) => node.classList.toggle('active', index <= step)); }
  function showError(message) { $('connectionStatus').textContent = message; $('connectionStatus').classList.remove('jxb-hidden'); }
  function ruleDisplayName(rule) {
    if (!rule.builtin) return rule.name;
    const key = `rule.${rule.id}.name`;
    return I.has(key) ? I.t(key) : rule.name;
  }
  function ruleDisplayDesc(rule) {
    if (!rule.builtin) return rule.description;
    const key = `rule.${rule.id}.desc`;
    return I.has(key) ? I.t(key) : rule.description;
  }
  function renderRules() { $('onboardingRules').replaceChildren(...selectedRules.map((rule) => { const label = document.createElement('label'); label.className = 'jxb-check'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true; input.dataset.ruleId = rule.id; const copy = document.createElement('span'); const title = document.createElement('strong'); title.textContent = ruleDisplayName(rule); const desc = document.createElement('small'); desc.textContent = ruleDisplayDesc(rule); copy.append(title, desc); label.append(input, copy); return label; })); }
  function renderScopes() { $('onboardingScopes').replaceChildren(...SCOPE_OPTIONS.map(([key]) => { const label = document.createElement('label'); label.className = 'jxb-check'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selectedScopes[key]; input.dataset.scopeId = key; const copy = document.createElement('span'); const title = document.createElement('strong'); title.textContent = I.t(`scope.${key}`); const desc = document.createElement('small'); desc.textContent = I.t(`scope.${key}Desc`); copy.append(title, desc); label.append(input, copy); return label; })); }

  $('testConnectionButton').addEventListener('click', async () => { const key = $('onboardingKey').value.trim(); if (!key) { showError(I.t('onboarding.errNoKey')); return; } $('testConnectionButton').disabled = true; $('testConnectionButton').textContent = I.t('onboarding.testing'); const result = await send(E.MESSAGE.TEST_CONNECTION, { apiKey: key }); $('testConnectionButton').disabled = false; $('testConnectionButton').textContent = I.t('onboarding.testConnection'); if (!result.ok) { showError(I.t('onboarding.errConnect', { e: result.error || 'API_UNAVAILABLE' })); return; } $('connectionStatus').className = 'jxb-help jxb-success'; $('connectionStatus').textContent = I.t('onboarding.connectOk', { ms: result.latencyMs }); });
  $('nextButton').addEventListener('click', async () => { const key = $('onboardingKey').value.trim(); if (!key) { showError(I.t('onboarding.errNoKey2')); return; } const result = await send(E.MESSAGE.TEST_CONNECTION, { apiKey: key }); if (!result.ok) { showError(I.t('onboarding.errConnectShort', { e: result.error || 'API_UNAVAILABLE' })); return; } await send(E.MESSAGE.SAVE_API_KEY, { apiKey: key }); renderRules(); renderScopes(); showStep(1); });
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
