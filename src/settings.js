(function () {
  'use strict';
  const E = globalThis.JevXBlocker;
  const I = globalThis.JevI18n;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let editingId = null;

  function send(type, payload) {
    return new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, (response) => resolve(response || { ok: false, error: 'NO_RESPONSE' })));
  }

  function applyTheme(theme) {
    const resolved = theme === 'light' || theme === 'dark'
      ? theme
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.jxbTheme = resolved;
  }

  function applyUiLang(lang) {
    I.setOverride(lang);
    I.applyDocument();
    if (state) render();
  }

  function renderVersion() {
    const version = 'v' + chrome.runtime.getManifest().version;
    const badge = $('versionBadge');
    if (badge) badge.textContent = version;
    const footer = $('footerVersion');
    if (footer) footer.textContent = I.t('settings.footerRight', { v: version });
  }

  function renderThemeSeg() {
    const seg = $('themeSeg');
    if (!seg || !state) return;
    seg.querySelectorAll('button').forEach((btn) => btn.classList.toggle('active', btn.dataset.themeValue === state.config.theme));
  }

  function renderUiLangSeg() {
    const seg = $('uiLangSeg');
    if (!seg || !state) return;
    seg.querySelectorAll('button').forEach((btn) => btn.classList.toggle('active', btn.dataset.langValue === state.config.uiLang));
  }

  document.querySelectorAll('#themeSeg button').forEach((btn) => btn.addEventListener('click', async () => {
    applyTheme(btn.dataset.themeValue);
    if (await persist({ theme: btn.dataset.themeValue })) {
      showToast(I.t(btn.dataset.themeValue === 'system' ? 'settings.toastThemeSystem' : btn.dataset.themeValue === 'dark' ? 'settings.toastThemeDark' : 'settings.toastThemeLight'), 'success');
    }
  }));
  document.querySelectorAll('#uiLangSeg button').forEach((btn) => btn.addEventListener('click', async () => {
    applyUiLang(btn.dataset.langValue);
    if (await persist({ uiLang: btn.dataset.langValue })) {
      showToast(btn.dataset.langValue === 'zh' ? '界面语言已切换为中文' : btn.dataset.langValue === 'en' ? 'Interface language set to English' : I.t('settings.langSystem'), 'success');
    }
  }));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state && state.config.theme === 'system') applyTheme('system');
  });

  function showToast(message, kind) {
    const node = $('toast'); node.textContent = message; node.className = `jxb-toast ${kind || ''}`;
    setTimeout(() => node.classList.add('jxb-hidden'), 2500);
  }

  async function persist(patch) {
    const response = await send(E.MESSAGE.SAVE_CONFIG, patch);
    if (!response.ok) { showToast(I.t('common.saveFailed', { e: response.error || 'UNKNOWN_ERROR' }), 'error'); return false; }
    await refresh();
    showToast(I.t('common.saved'), 'success');
    return true;
  }

  const SCOPE_TOGGLE_IDS = {
    detailReplies: 'detailRepliesToggle',
    detailRoot: 'detailRootToggle',
    timeline: 'timelineToggle',
    search: 'searchToggle',
    profile: 'profileToggle',
    explore: 'exploreToggle'
  };

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

  function applyToLabel(rule) {
    if (rule.applyTo.length === 2) return '';
    return I.t(rule.applyTo[0] === 'post' ? 'rule.postsOnly' : 'rule.commentsOnly');
  }

  function createRuleCard(rule) {
    const card = document.createElement('div'); card.className = 'jxb-rule-card';
    const copy = document.createElement('div'); copy.className = 'jxb-rule-card-copy';
    const title = document.createElement('div'); title.className = 'jxb-rule-card-title';
    const name = document.createElement('span'); name.textContent = ruleDisplayName(rule); title.append(name);
    const kind = document.createElement('span'); kind.className = 'jxb-chip'; kind.textContent = rule.builtin ? I.t('settings.ruleChipBuiltin') : I.t('settings.ruleChipCustom'); title.append(kind);
    const scope = applyToLabel(rule);
    if (scope) { const chip = document.createElement('span'); chip.className = 'jxb-chip'; chip.textContent = scope; title.append(chip); }
    const threshold = document.createElement('span'); threshold.className = `jxb-chip ${rule.threshold < .7 ? 'amber' : ''}`; threshold.textContent = I.t('settings.ruleThreshold', { n: Math.round(rule.threshold * 100) }); title.append(threshold);
    const desc = document.createElement('div'); desc.className = 'jxb-rule-card-desc'; desc.textContent = ruleDisplayDesc(rule); copy.append(title, desc);
    const actions = document.createElement('div'); actions.className = 'jxb-rule-actions';
    const edit = document.createElement('button'); edit.className = 'jxb-button ghost small'; edit.textContent = I.t('settings.ruleEdit'); edit.addEventListener('click', () => openRuleModal(rule)); actions.append(edit);
    if (!rule.builtin) { const remove = document.createElement('button'); remove.className = 'jxb-button danger small'; remove.textContent = I.t('settings.ruleDelete'); remove.addEventListener('click', async () => { if (window.confirm(I.t('settings.confirmDeleteRule', { name: ruleDisplayName(rule) }))) await persist({ rules: state.config.rules.filter((item) => item.id !== rule.id) }); }); actions.append(remove); }
    const toggle = document.createElement('label'); toggle.className = 'jxb-toggle'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = rule.enabled; const track = document.createElement('span'); toggle.append(input, track); input.addEventListener('change', async () => { const rules = state.config.rules.map((item) => item.id === rule.id ? { ...item, enabled: input.checked } : item); await persist({ rules }); }); actions.append(toggle);
    card.append(copy, actions); return card;
  }

  function renderRules() {
    const list = $('settingsRuleList'); list.replaceChildren(...state.config.rules.map(createRuleCard));
    const active = state.config.rules.filter((rule) => rule.enabled).length;
    $('sideRuleCount').textContent = I.t('settings.sideActive', { n: active });
  }

  function render() {
    const config = state.config; const stats = state.stats;
    I.setOverride(config.uiLang);
    I.applyDocument();
    applyTheme(config.theme);
    $('headerStatus').innerHTML = state.hasApiKey ? '<span class="jxb-dot"></span>' + I.t('common.ready') : '<span class="jxb-dot warn"></span>' + I.t('common.keyRequired');
    $('enabledToggle').checked = config.enabled; $('failOpenToggle').checked = config.failOpen;
    $('placeholderToggle').checked = config.showPlaceholder; $('checkControlsToggle').checked = config.showCheckControls; $('monitorToggle').checked = config.showMonitor; $('confidenceToggle').checked = config.showConfidence; $('preloadToggle').checked = config.preload; $('debugToggle').checked = config.debug; $('lazyScanToggle').checked = config.lazyScan;
    for (const [scope, id] of Object.entries(SCOPE_TOGGLE_IDS)) $(id).checked = config.scopes[scope] !== false;
    $('sideScopeCount').textContent = I.t('settings.sideScopes', { n: Object.values(config.scopes).filter(Boolean).length });
    $('apiKeyField').value = state.apiKeyMask || '';
    $('apiBadge').textContent = state.hasApiKey ? I.t('settings.apiConnected') + (stats.latencyMs ? ` · ${stats.latencyMs}ms` : '') : I.t('settings.apiNotConnected'); $('apiBadge').className = `jxb-chip ${state.hasApiKey ? 'green' : 'amber'}`;
    $('sideHiddenCount').textContent = String((stats.totalHidden || 0) + (stats.totalPostsHidden || 0));
    $('quotaLabel').textContent = `${(stats.requests || 0).toLocaleString()} / ${(config.dailyLimit || 0).toLocaleString()}`;
    $('quotaProgress').style.width = `${Math.min(100, ((stats.requests || 0) / Math.max(1, config.dailyLimit)) * 100)}%`;
    $('concurrencySelect').value = String(config.maxConcurrency); $('dailyLimitInput').value = String(config.dailyLimit); $('cacheTtlSelect').value = String(config.cacheTtlHours);
    $('requestPreview').textContent = JSON.stringify({ model: config.model, state: { content: '<post or comment text>' }, questions: E.buildQuestions(E.activeRules(config, 'post')) }, null, 2);
    renderRules();
    renderVersion();
    renderThemeSeg();
    renderUiLangSeg();
  }

  async function refresh() { const response = await send(E.MESSAGE.GET_STATE); if (response.ok) { state = response; render(); } }

  function openRuleModal(rule) {
    editingId = rule ? rule.id : null; $('modalTitle').textContent = rule ? I.t('settings.modalEditTitle', { name: ruleDisplayName(rule) }) : I.t('settings.modalAddTitle');
    $('ruleName').value = rule ? rule.name : ''; $('ruleDescription').value = rule ? rule.description : ''; $('ruleFalseCriteria').value = rule ? (rule.falseCriteria || '') : '';
    $('applyComments').checked = rule ? rule.applyTo.includes('comment') : true;
    $('applyPosts').checked = rule ? rule.applyTo.includes('post') : true;
    $('ruleThreshold').value = rule ? Math.round(rule.threshold * 100) : 80; $('thresholdValue').textContent = `${$('ruleThreshold').value}%`;
    $('ruleName').readOnly = Boolean(rule && rule.builtin); $('ruleDescription').readOnly = Boolean(rule && rule.builtin); $('ruleFalseCriteria').readOnly = Boolean(rule && rule.builtin);
    $('modalBackdrop').classList.remove('jxb-hidden'); $('ruleName').focus();
  }

  function closeRuleModal() { $('modalBackdrop').classList.add('jxb-hidden'); editingId = null; }

  $('enabledToggle').addEventListener('change', (event) => persist({ enabled: event.target.checked }));
  $('failOpenToggle').addEventListener('change', (event) => persist({ failOpen: event.target.checked }));
  for (const [scope, id] of Object.entries(SCOPE_TOGGLE_IDS)) {
    $(id).addEventListener('change', async (event) => {
      const scopes = { ...state.config.scopes, [scope]: event.target.checked };
      await persist({ scopes });
    });
  }
  $('lazyScanToggle').addEventListener('change', (event) => persist({ lazyScan: event.target.checked }));
  $('placeholderToggle').addEventListener('change', (event) => persist({ showPlaceholder: event.target.checked }));
  $('checkControlsToggle').addEventListener('change', (event) => persist({ showCheckControls: event.target.checked }));
  $('monitorToggle').addEventListener('change', (event) => persist({ showMonitor: event.target.checked }));
  $('confidenceToggle').addEventListener('change', (event) => persist({ showConfidence: event.target.checked }));
  $('preloadToggle').addEventListener('change', (event) => persist({ preload: event.target.checked }));
  $('debugToggle').addEventListener('change', (event) => persist({ debug: event.target.checked }));
  $('concurrencySelect').addEventListener('change', (event) => persist({ maxConcurrency: Number(event.target.value) }));
  $('dailyLimitInput').addEventListener('change', (event) => persist({ dailyLimit: Number(event.target.value) }));
  $('cacheTtlSelect').addEventListener('change', (event) => persist({ cacheTtlHours: Number(event.target.value) }));
  $('ruleThreshold').addEventListener('input', (event) => { $('thresholdValue').textContent = `${event.target.value}%`; });
  $('addRuleButton').addEventListener('click', () => openRuleModal()); $('closeModalButton').addEventListener('click', closeRuleModal); $('cancelRuleButton').addEventListener('click', closeRuleModal); $('modalBackdrop').addEventListener('click', (event) => { if (event.target === $('modalBackdrop')) closeRuleModal(); });
  $('ruleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('ruleName').value.trim(); const description = $('ruleDescription').value.trim(); const falseCriteria = $('ruleFalseCriteria').value.trim(); const threshold = Number($('ruleThreshold').value) / 100;
    const applyTo = [$('applyComments').checked && 'comment', $('applyPosts').checked && 'post'].filter(Boolean);
    if (!name || !description) return;
    if (!applyTo.length) { showToast(I.t('settings.errApplyTo'), 'error'); return; }
    let rules;
    if (editingId) rules = state.config.rules.map((rule) => rule.id === editingId ? { ...rule, name, description, trueCriteria: description, falseCriteria, threshold, applyTo, instructions: rule.builtin ? rule.instructions : I.t('settings.customRuleInstruction', { d: description }) } : rule);
    else { const id = `custom_${Date.now().toString(36)}`; rules = [...state.config.rules, { id, name, description, instructions: I.t('settings.customRuleInstruction', { d: description }), trueCriteria: description, falseCriteria, threshold, enabled: true, builtin: false, applyTo }]; }
    if (await persist({ rules })) closeRuleModal();
  });

  $('testKeyButton').addEventListener('click', async () => { const message = $('apiMessage'); message.classList.add('jxb-hidden'); const result = await send(E.MESSAGE.TEST_CONNECTION); if (result.ok) { showToast(I.t('popup.toastConnected', { ms: result.latencyMs }), 'success'); } else { message.textContent = I.t('settings.errConnect', { e: result.error || 'API_UNAVAILABLE' }); message.classList.remove('jxb-hidden'); } });
  let editingKey = false;
  $('changeKeyButton').addEventListener('click', async () => { const field = $('apiKeyField'); if (!editingKey) { editingKey = true; field.readOnly = false; field.value = ''; field.placeholder = 'apikey_…'; field.focus(); $('changeKeyButton').textContent = I.t('settings.save'); return; } const key = field.value.trim(); const result = await send(E.MESSAGE.TEST_CONNECTION, { apiKey: key }); if (!result.ok) { $('apiMessage').textContent = I.t('settings.errConnect', { e: result.error || 'API_UNAVAILABLE' }); $('apiMessage').classList.remove('jxb-hidden'); return; } await send(E.MESSAGE.SAVE_API_KEY, { apiKey: key }); await send(E.MESSAGE.SAVE_CONFIG, { onboardingCompleted: true }); editingKey = false; field.readOnly = true; $('changeKeyButton').textContent = I.t('settings.apiChange'); showToast(I.t('settings.toastKeySaved'), 'success'); await refresh(); });
  $('revokeKeyButton').addEventListener('click', async () => { if (!window.confirm(I.t('settings.confirmRevokeKey'))) return; await send(E.MESSAGE.SAVE_API_KEY, { apiKey: '' }); showToast(I.t('settings.toastKeyRevoked'), 'success'); await refresh(); });
  $('clearCacheButton').addEventListener('click', async () => { await send(E.MESSAGE.CLEAR_CACHE); showToast(I.t('settings.clearCacheToast'), 'success'); });
  $('saveAllButton').addEventListener('click', () => showToast(I.t('settings.saveAllToast'), 'success'));
  $('exportButton').addEventListener('click', () => { const safe = E.sanitizeConfig(state.config); const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), config: safe }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'jev-x-blocker-config.json'; link.click(); URL.revokeObjectURL(url); showToast(I.t('settings.toastExported'), 'success'); });
  document.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => { document.getElementById(button.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelectorAll('[data-target]').forEach((node) => node.classList.toggle('active', node === button)); }));
  refresh();
})();
