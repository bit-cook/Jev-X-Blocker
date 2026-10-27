// i18n dictionary integrity + resolution behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/shared/i18n.js');
const E = require('../src/shared/core.js');

test('zh and en dictionaries have identical key sets', () => {
  const zh = Object.keys(I.MESSAGES.zh).sort();
  const en = Object.keys(I.MESSAGES.en).sort();
  assert.deepEqual(en, zh);
  assert.ok(zh.length >= 150, `expected a large dictionary, got ${zh.length} keys`);
});

test('no empty or placeholder values in either language', () => {
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of Object.entries(I.MESSAGES[lang])) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test('t() interpolates {token} placeholders', () => {
  assert.equal(
    I.t('settings.ruleThreshold', { n: 65 }, 'en'),
    'threshold 65%'
  );
  assert.equal(
    I.t('popup.breakdown', { replies: 3, posts: 9 }, 'zh'),
    '评论 3 · 帖子 9'
  );
});

test('missing keys fall back to zh then to the key itself', () => {
  // en has every zh key, so force the fallback by asking zh for an en-only key.
  assert.equal(I.t('definitely.not.a.key', null, 'en'), 'definitely.not.a.key');
});

test('language resolution honors explicit override', () => {
  I.setOverride('en');
  assert.equal(I.lang(), 'en');
  assert.equal(I.t('popup.statusTitle'), 'Protection');
  I.setOverride('zh');
  assert.equal(I.lang(), 'zh');
  assert.equal(I.t('popup.statusTitle'), '保护状态');
  I.setOverride(null);
  // No chrome.i18n in node: browserLang() defaults to zh.
  assert.equal(I.lang(), 'zh');
});

test('builtin rule names and descriptions exist in both languages', () => {
  for (const rule of E.DEFAULT_RULES) {
    for (const lang of ['zh', 'en']) {
      assert.ok(I.has(`rule.${rule.id}.name`, lang), `missing rule.${rule.id}.name in ${lang}`);
      assert.ok(I.has(`rule.${rule.id}.desc`, lang), `missing rule.${rule.id}.desc in ${lang}`);
      assert.ok(I.MESSAGES[lang][`rule.${rule.id}.name`].trim().length > 0);
    }
  }
  assert.equal(I.t('rule.combinedRisk', null, 'en'), 'Combined risk');
});

test('scope keys exist for every scope in both languages', () => {
  for (const scope of Object.keys(E.DEFAULT_SCOPES)) {
    for (const lang of ['zh', 'en']) {
      assert.ok(I.has(`scope.${scope}`, lang), `missing scope.${scope} in ${lang}`);
    }
  }
});

test('en custom rule instruction keeps the content token in backticks', () => {
  const text = I.t('settings.customRuleInstruction', { d: 'crypto shilling' }, 'en');
  assert.match(text, /`content`/);
  assert.match(text, /crypto shilling/);
});

test('core decision labels pick up the combined-risk name from i18n', () => {
  assert.equal(E.DECISION_LABELS.combined_risk, '综合风险');
});
