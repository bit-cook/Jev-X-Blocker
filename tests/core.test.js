const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/shared/core.js');

test('default configuration exposes three builtin rules applied to both kinds', () => {
  const config = E.createDefaultConfig();
  assert.equal(config.rules.length, 3);
  assert.deepEqual(config.rules.map((rule) => rule.id), ['sexual_content', 'sexual_solicitation', 'spam_behavior']);
  assert.ok(config.rules[0].enabled && config.rules[0].builtin && config.rules[0].threshold === 0.65);
  assert.ok(config.rules[1].enabled && config.rules[1].builtin && config.rules[1].threshold === 0.75);
  assert.equal(config.rules[2].threshold, 0.78);
  for (const rule of config.rules) assert.deepEqual(rule.applyTo, ['comment', 'post']);
  assert.equal(config.lazyScan, true);
  assert.equal(config.showMonitor, true);
  assert.equal(config.showCheckControls, false);
  assert.equal(config.dailyLimit, 100000);
  assert.deepEqual(E.activeRules(config).length, 3);
  assert.deepEqual(E.activeRules(config, 'post').length, 3);
  assert.equal(E.normalizeConfig({ showMonitor: false }).showMonitor, false);
  assert.equal(E.normalizeConfig({}).showCheckControls, false);
  assert.equal(E.normalizeConfig({ showCheckControls: true }).showCheckControls, true);
});

test('default scopes enable detail replies and timeline only', () => {
  const config = E.createDefaultConfig();
  assert.deepEqual(config.scopes, {
    detailReplies: true,
    detailRoot: false,
    timeline: true,
    search: false,
    profile: false,
    explore: false
  });
  assert.equal(E.scopeActive(config, 'detailReplies'), true);
  assert.equal(E.scopeActive(config, 'timeline'), true);
  assert.equal(E.scopeActive(config, 'detailRoot'), false);
  assert.equal(E.scopeActive(config, 'search'), false);
  assert.equal(E.scopeActive({ scopes: { ...config.scopes, search: true } }, 'search'), true);
});

test('theme preference defaults to system and normalises unknown values', () => {
  assert.equal(E.createDefaultConfig().theme, 'system');
  assert.equal(E.normalizeConfig({ theme: 'light' }).theme, 'light');
  assert.equal(E.normalizeConfig({ theme: 'dark' }).theme, 'dark');
  assert.equal(E.normalizeConfig({ theme: 'sepia' }).theme, 'system');
});

test('commentsOnly=false legacy configs expand to every scope', () => {
  const config = E.normalizeConfig({ commentsOnly: false });
  assert.equal(config.scopes.detailReplies, true);
  assert.equal(config.scopes.timeline, true);
  assert.equal(config.scopes.explore, true);
  const faithful = E.normalizeConfig({ scopes: { timeline: false } });
  assert.equal(faithful.scopes.timeline, false);
});

test('rules can be restricted to one kind and the cache honours the split', async () => {
  const config = E.normalizeConfig({
    rules: [{ id: 'sexual_content', name: 'x', threshold: 0.65, enabled: true, builtin: true, applyTo: ['post'] }]
  });
  assert.equal(E.activeRules(config, 'comment').some((rule) => rule.id === 'sexual_content'), false);
  assert.equal(E.activeRules(config, 'post').some((rule) => rule.id === 'sexual_content'), true);
  const bothKinds = [{ id: 'rule', instructions: 'same', trueCriteria: 'yes', falseCriteria: 'no', applyTo: ['comment', 'post'] }];
  const postOnly = [{ ...bothKinds[0], applyTo: ['post'] }];
  assert.notEqual(await E.cacheKey('hello', bothKinds, 'jev-latest'), await E.cacheKey('hello', postOnly, 'jev-latest'));
});

test('normalizeText removes zero-width characters and whitespace only while preserving signals', () => {
  const source = '  骚\u200b🖤❤️  1789699386154\nhttps://x.com/a  ';
  assert.equal(E.normalizeText(source), '骚🖤❤️ 1789699386154 https://x.com/a');
});

test('normalizeText removes the broader invisible-character table', () => {
  const dirty = '\u200d比\u2060\u2060\u200c\u2060\u2060我\u200d\u2060\u200c\u200c\u200d好\u200c\u200d\u200c\u2060\u200c\u200c的\u200c\u2060\u200c\u2060\u200d没\u200d\u200d\u2060\u200d\u200c我\u200c\u200d骚\u2060\u2060\u2060\u2060\u200c\u2060\u200d😟\u200c\u200c\u200c\u2060比\u200c\u200c\u2060\u200c\u2060\u200c\u200d我\u200d\u200d\u2060骚\u200d\u200d\u200d\u200c\u200c的\u200c\u2060\u200d\u200d没\u200c\u200c\u2060我\u200c\u200c\u200d\u200c好\u200c\u200c\u200d看\u200c\u200c\u2060\u200c🌀\u2060\u200c';
  assert.equal(E.normalizeText(dirty), '比我好的没我骚😟比我骚的没我好看🌀');
});

test('composeContent labels the body per kind and keeps structural signals', () => {
  const comment = E.composeContent({ author: '卫潼笑♥处男免费♥ @example', text: '恭喜发财，祝你有美好的一天' });
  assert.match(comment, /\[评论正文\] 恭喜发财，祝你有美好的一天/);
  assert.match(comment, /username_emoji_count=2/);
  assert.match(comment, /body_emoji_count=0/);
  const post = E.composeContent({ kind: 'post', author: 'A @a', text: '只进身体不进生活🖤❤️' });
  assert.match(post, /\[帖子正文\] 只进身体不进生活🖤❤️/);
  assert.match(post, /body_emoji_count=2/);
});

test('buildQuestions compiles enabled rules into Jev noul questions', () => {
  const questions = E.buildQuestions(E.DEFAULT_RULES);
  assert.equal(questions.sexual_content.type, 'noul');
  assert.match(questions.sexual_content.instructions, /性暗示/);
  assert.match(questions.sexual_content.instructions, /用户名/);
  assert.match(questions.sexual_content.instructions, /emoji/);
  assert.match(questions.sexual_solicitation.instructions, /用户名/);
  assert.equal(questions.spam_behavior.type, 'noul');
  assert.match(questions.spam_behavior.instructions, /模板刷屏|模板化 spam|批量模板/);
  assert.equal(questions.sexual_content.criteria.false.length > 0, true);
});

test('config upgrades persisted builtin prompts while always preserving user thresholds', () => {
  const config = E.normalizeConfig({ rules: [{ ...E.DEFAULT_RULES[0], instructions: 'old prompt', threshold: 0.91, enabled: false }, { ...E.DEFAULT_RULES[1], threshold: 0.8 }] });
  assert.match(config.rules[0].instructions, /emoji/);
  assert.equal(config.rules[0].threshold, 0.91);
  assert.equal(config.rules[0].enabled, false);
  // Unlike elons-job's v1->v2 silent threshold rewrite, Jev X Blocker keeps
  // whatever threshold the user (or the legacy importer) explicitly stored.
  assert.equal(config.rules[1].threshold, 0.8);
});

test('decision uses pTrue/noul probabilities and local thresholds', () => {
  const rules = [
    { id: 'a', name: 'A', threshold: 0.8, enabled: true },
    { id: 'b', name: 'B', threshold: 0.8, enabled: true },
    { id: 'c', name: 'C', threshold: 0.8, enabled: true }
  ];
  const result = E.buildDecision({ answers: { a: { noul: 0.93 }, b: { pTrue: 0.79 }, c: { probabilities: { true: 0.81 } } } }, rules);
  assert.equal(result.shouldHide, true);
  assert.deepEqual(result.matches.map((item) => item.ruleId), ['a', 'c']);
  assert.equal(result.results.b, 0.79);
});

test('repeated emoji template forces the spam rule into the hide decision', () => {
  const spamRule = E.DEFAULT_RULES.find((rule) => rule.id === 'spam_behavior');
  const content = E.composeContent({ username: 'A @a', text: '恭喜发财🍭 Respectful，祝福你有美好的一天', templateCount: 3 });
  const result = E.buildDecision({ answers: { spam_behavior: { noul: 0.12 } } }, [spamRule], { content });
  assert.equal(result.localSignals.spam.matched, true);
  assert.equal(result.shouldHide, true);
  assert.equal(result.matches[0].ruleId, 'spam_behavior');
  assert.equal(result.matches[0].source, 'page-template-signal');
});

test('emoji substitutions share one page template fingerprint', () => {
  assert.equal(
    E.templateFingerprint('没人比我玩的开了吧🐼我福不黑不信你看🐵'),
    E.templateFingerprint('没人比我玩的开了吧🍂我福不黑不信你看⛺')
  );
});

test('spam score alone does not hide a plain single comment', () => {
  const spamRule = E.DEFAULT_RULES.find((rule) => rule.id === 'spam_behavior');
  const result = E.buildDecision({ answers: { spam_behavior: { noul: 0.99 } } }, [spamRule], { content: '我发的不是普通内容，想看完整版就进群。' });
  assert.equal(result.shouldHide, false);
});

test('emoji cluster structure catches a single suspicious template with moderate model support', () => {
  const spamRule = E.DEFAULT_RULES.find((rule) => rule.id === 'spam_behavior');
  const content = E.composeContent({ text: '应该没人比我玩的开了吧🌺🙂我福不黑不信你看' });
  const result = E.buildDecision({ answers: {
    sexual_content: { noul: 0.48 },
    sexual_solicitation: { noul: 0.06 },
    spam_behavior: { noul: 0.20 }
  } }, [spamRule, E.DEFAULT_RULES[0], E.DEFAULT_RULES[1]], { content });
  assert.equal(result.localSignals.spam.emojiClusterTemplate, true);
  assert.equal(result.shouldHide, true);
  assert.equal(result.matches.some((match) => match.source === 'emoji-cluster-signal'), true);
});

test('invisible-character pollution is a spam signal after the text is cleaned', () => {
  const spamRule = E.DEFAULT_RULES.find((rule) => rule.id === 'spam_behavior');
  const dirty = '\u200d比\u2060我\u200c骚😟\u2060比\u200d我骚🌀';
  const content = E.composeContent({ text: dirty });
  const result = E.buildDecision({ answers: { spam_behavior: { noul: 0.1 } } }, [spamRule], { content });
  assert.match(content, /invisible_char_count=5/);
  assert.equal(result.localSignals.spam.matched, true);
  assert.equal(result.shouldHide, true);
});

test('emoji-obfuscated representative sexual phrase forces the sexual rule', () => {
  const sexualRule = E.DEFAULT_RULES.find((rule) => rule.id === 'sexual_content');
  const content = E.composeContent({ username: '有腿🔥 @a', text: '是💼这个出处吧🚀啊啊小马开🍀大车!', templateCount: 0 });
  const result = E.buildDecision({ answers: { sexual_content: { noul: 0.43 } } }, [sexualRule], { content });
  assert.equal(result.localSignals.sexualObfuscation.matched, true);
  assert.equal(result.shouldHide, true);
  assert.equal(result.matches[0].source, 'emoji-obfuscation-signal');
});

test('combined builtin risk hides multiple moderate signals', () => {
  const result = E.buildDecision({ answers: {
    sexual_content: { noul: 0.57 },
    sexual_solicitation: { noul: 0.13 },
    spam_behavior: { noul: 0.41 }
  } }, E.DEFAULT_RULES, { content: E.composeContent({ text: '那一夜你☝没有拒绝我🔥😍不是人机 - L' }) });
  assert.ok(Math.abs(result.combinedRisk.score - 1.11) < 1e-9);
  assert.equal(result.combinedRisk.matched, true);
  assert.equal(result.matches.some((match) => match.source === 'combined-risk-signal'), true);
  assert.equal(result.shouldHide, true);
});

test('combined builtin risk does not hide one moderate signal', () => {
  const result = E.buildDecision({ answers: {
    sexual_content: { noul: 0.57 },
    sexual_solicitation: { noul: 0.13 },
    spam_behavior: { noul: 0.39 }
  } }, E.DEFAULT_RULES, { content: E.composeContent({ text: '那一夜你☝没有拒绝我🔥😍不是人机 - L' }) });
  assert.equal(result.combinedRisk.matched, false);
});

test('disabled rules never produce a match', () => {
  const result = E.buildDecision({ answers: { muted: { noul: 1 } } }, [{ id: 'muted', name: 'Muted', threshold: 0.5, enabled: false }]);
  assert.equal(result.shouldHide, false);
  assert.deepEqual(result.matches, []);
});

test('cache key changes with normalized content, rule instructions, or model but not threshold', async () => {
  const base = [{ id: 'rule', instructions: 'same', trueCriteria: 'yes', falseCriteria: 'no', threshold: 0.8, enabled: true }];
  const thresholdOnly = [{ ...base[0], threshold: 0.9 }];
  const instructionChange = [{ ...base[0], instructions: 'changed' }];
  assert.equal(await E.cacheKey(' hello ', base, 'jev-latest'), await E.cacheKey('hello', thresholdOnly, 'jev-latest'));
  assert.notEqual(await E.cacheKey('hello', base, 'jev-latest'), await E.cacheKey('hello', instructionChange, 'jev-latest'));
  assert.notEqual(await E.cacheKey('hello', base, 'jev-latest'), await E.cacheKey('hello', base, 'jev-next'));
});

test('classifyPage routes every X surface and extracts the root tweet id', () => {
  assert.equal(E.classifyPage('https://x.com/home').type, 'home');
  assert.equal(E.classifyPage('https://x.com/search?q=x&f=live').type, 'search');
  assert.equal(E.classifyPage('https://x.com/explore/tabs/trending').type, 'explore');
  assert.equal(E.classifyPage('https://x.com/elonmusk').type, 'profile');
  assert.equal(E.classifyPage('https://x.com/elonmusk/with_replies').type, 'profile');
  assert.equal(E.classifyPage('https://x.com/i/bookmarks').type, 'bookmarks');
  assert.equal(E.classifyPage('https://x.com/i/lists/12345').type, 'lists');
  assert.equal(E.classifyPage('https://x.com/notifications').type, 'notifications');
  assert.equal(E.classifyPage('https://x.com/messages').type, 'messages');
  const detail = E.classifyPage('https://x.com/elonmusk/status/123456789?x=1');
  assert.equal(detail.type, 'detail');
  assert.equal(detail.rootTweetId, '123456789');
  assert.equal(E.rootTweetId('https://x.com/a/status/99'), '99');
  assert.equal(E.isTweetDetailUrl('https://x.com/home'), false);
  assert.equal(E.SCOPE_BY_TYPE.notifications, null);
  assert.equal(E.SCOPE_BY_TYPE.home, 'timeline');
});

test('legacyConfigPatch imports the elons-job key, custom rules and scope defaults', () => {
  const patch = E.legacyConfigPatch({
    typesafeApiKey: 'apikey_secret',
    enabled: false,
    commentsOnly: true,
    rules: [
      { id: 'sexual_content', name: 'old', enabled: false, threshold: 0.9 },
      { id: 'custom_crypto', name: 'Crypto spam', description: '推广加密货币', enabled: true, threshold: 0.85 }
    ]
  });
  assert.equal(patch.typesafeApiKey, 'apikey_secret');
  assert.equal(patch.onboardingCompleted, true);
  assert.equal(patch.enabled, false);
  const sexual = patch.rules.find((rule) => rule.id === 'sexual_content');
  assert.equal(sexual.enabled, false);
  assert.equal(sexual.threshold, 0.9);
  assert.match(sexual.instructions, /emoji/);
  const custom = patch.rules.find((rule) => rule.id === 'custom_crypto');
  assert.ok(custom && !custom.builtin);
  assert.equal(patch.scopes.detailReplies, true);
  assert.equal(patch.scopes.timeline, true);
  assert.equal(E.legacyConfigPatch(null), null);
});

test('storage config sanitises keys for UI and keeps keys out of normal config', async () => {
  const data = {};
  const area = {
    get(key, callback) { callback({ [key]: data[key] }); },
    set(value, callback) { Object.assign(data, value); callback(); },
    remove(key, callback) { delete data[key]; callback(); }
  };
  const fakeChrome = { storage: { local: area } };
  await E.saveConfig(fakeChrome, { typesafeApiKey: 'apikey_secret', enabled: false });
  const safe = await E.loadConfig(fakeChrome, false);
  const withSecret = await E.loadConfig(fakeChrome, true);
  assert.equal(safe.typesafeApiKey, undefined);
  assert.equal(withSecret.typesafeApiKey, 'apikey_secret');
  assert.equal(safe.enabled, false);
  assert.equal(E.maskSecret('apikey_secret'), 'apik•••••cret');
});

test('migrateLegacy copies elons-work data once and never twice', async () => {
  const data = {};
  const area = {
    get(key, callback) { callback({ [key]: data[key] }); },
    set(value, callback) { Object.assign(data, value); callback(); },
    remove(key, callback) { delete data[key]; callback(); }
  };
  const fakeChrome = { storage: { local: area } };
  data[E.LEGACY_CONFIG_KEY] = { typesafeApiKey: 'apikey_legacy' };
  data[E.LEGACY_STATS_KEY] = { totalChecked: 12, totalHidden: 5 };
  const migrated = await E.migrateLegacy(fakeChrome);
  assert.equal(migrated.typesafeApiKey, 'apikey_legacy');
  const stats = await E.getStats(fakeChrome);
  assert.equal(stats.totalChecked, 12);
  assert.equal(stats.totalHidden, 5);
  // Second run is a no-op because our own storage now exists.
  data[E.LEGACY_CONFIG_KEY] = { typesafeApiKey: 'apikey_other' };
  const again = await E.migrateLegacy(fakeChrome);
  assert.equal(again, null);
  const config = await E.loadConfig(fakeChrome, true);
  assert.equal(config.typesafeApiKey, 'apikey_legacy');
});

test('privacy-safe debug logging strips API keys and raw text', () => {
  const seen = [];
  const previous = global.console;
  global.console = { debug: (_event, payload) => seen.push(payload) };
  E.debugLog({ debug: true }, 'event', { apiKey: 'secret', content: 'private', contentHash: 'hash' });
  global.console = previous;
  assert.deepEqual(seen, [{ contentHash: 'hash' }]);
});

test('error mapping is fail-open friendly and never returns raw error text', () => {
  assert.equal(E.cleanError({ status: 401, message: 'Bearer secret' }), 'API_KEY_INVALID');
  assert.equal(E.cleanError({ status: 429 }), 'RATE_LIMITED');
  assert.equal(E.cleanError({ status: 503 }), 'API_SERVER_ERROR');
  assert.equal(E.cleanError({ name: 'AbortError', message: 'secret' }), 'API_TIMEOUT');
  assert.equal(E.cleanError({ message: 'secret endpoint=https://private' }), 'API_UNAVAILABLE');
});
