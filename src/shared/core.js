(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Jev X Blocker shared core.
  //
  // Pure logic + storage helpers shared by the service worker, the content
  // scripts and the extension pages. No DOM access, no fetch, no secrets:
  // this file must stay loadable inside node --test.
  //
  // Refactor highlights over elons-job:
  //   * every classification target carries a kind ("post" | "comment") so
  //     the same rule engine drives timeline posts AND detail-page replies;
  //   * page scope handling is data driven (SCOPES + classifyPage) instead of
  //     a single isTweetDetailUrl boolean;
  //   * rules declare applyTo so a user can restrict a rule to posts only or
  //     comments only, and the fingerprint/cache honour that split;
  //   * one-shot migration from elons-work storage so upgraders keep their
  //     API key, custom rules and totals.
  // ---------------------------------------------------------------------------

  const APP = 'JevXBlocker';
  const STORAGE_KEY = 'jevXBlockerConfig';
  const STATS_KEY = 'jevXBlockerStats';
  const CACHE_KEY = 'jevXBlockerCache';
  const LEGACY_CONFIG_KEY = 'elonsWorkConfig';
  const LEGACY_STATS_KEY = 'elonsWorkStats';
  const MODEL_VERSION = 'jev-latest';
  const DECISION_VERSION = 'decision-v3-kind-aware';
  const CONFIG_VERSION = 4;
  const COMBINED_RISK_RULE_IDS = ['sexual_content', 'sexual_solicitation', 'spam_behavior'];
  const COMBINED_RISK_THRESHOLD = 1.05;
  // Display labels resolved at decision time; i18n.js keeps these in sync
  // with the configured interface language.
  const DECISION_LABELS = { combined_risk: '综合风险' };
  const COMBINED_RISK_MIN_COMPONENT = 0.4;
  const API_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
  const MAX_CONTENT_LENGTH = 4000;
  const KINDS = ['comment', 'post'];

  const MESSAGE = {
    GET_STATE: 'GET_STATE',
    SAVE_API_KEY: 'SAVE_API_KEY',
    TEST_CONNECTION: 'TEST_CONNECTION',
    OPEN_ONBOARDING: 'OPEN_ONBOARDING',
    CLASSIFY_TARGET: 'CLASSIFY_TARGET',
    SAVE_CONFIG: 'SAVE_CONFIG',
    RECORD_TARGET_EVENT: 'RECORD_TARGET_EVENT',
    CLEAR_CACHE: 'CLEAR_CACHE',
    OPEN_SETTINGS: 'OPEN_SETTINGS'
  };

  // Page scopes. detailReplies keeps the elons-job behaviour; everything else
  // is the new post-blocking surface. Keys are stable config field names.
  const SCOPES = ['detailReplies', 'detailRoot', 'timeline', 'search', 'profile', 'explore'];

  const DEFAULT_SCOPES = {
    detailReplies: true,
    detailRoot: false,
    timeline: true,
    search: false,
    profile: false,
    explore: false
  };

  const DEFAULT_RULES = [
    {
      id: 'sexual_content',
      name: '色情 / 性暗示',
      description: '隐藏色情、明显性暗示、性挑逗、擦边或自我性化表达的帖子与评论。',
      instructions: '判断“用户名 + 正文”是否有色情、情色、明显性暗示、性挑逗、擦边或自我性化意图。用户名本身明显表达成人、福利、私密或性化招揽时，即使正文普通也判 true。先去掉 emoji 和装饰符号理解整段语义；隐晦黑话、缩写、谐音、拼音变体、只谈身体、私房内容、重复模板和性化 emoji 都可能是掩饰。代表性锚点包括“只进身体不进生活”“搞hs”“小马开大车”“比我好看的没我骚”，不是封闭关键词表。普通祝福、外貌/艺术/医学/新闻/交通讨论，以及孤立的“大车”、单个敏感词或零散 emoji 不判 true。',
      trueCriteria: '用户名或正文以性、情色、性挑逗、自我性化、成人私密内容或隐晦性暗示为核心；性化语义与密集/连续/重复 emoji 同时出现时提高置信度。',
      falseCriteria: '普通姓名、正常聊天、恋爱、外貌、时尚/艺术、医学、新闻或交通语境；单个敏感词、普通 emoji、夸张账号名或“大车”等词没有性化上下文时不算 true。',
      threshold: 0.65,
      enabled: true,
      builtin: true,
      applyTo: ['comment', 'post']
    },
    {
      id: 'sexual_solicitation',
      name: '色情引流 / 招揽',
      description: '隐藏通过色情或性暗示吸引私聊、加账号、点击链接或购买服务的帖子与评论。',
      instructions: '判断“用户名 + 正文”是否把色情、情色、成人私密内容或明显性暗示用于招揽、引流或诱导联系。成人服务、福利、私密、免费招揽或联系方式出现在用户名中时，即使正文普通也判 true。需要结合性化语义与行动号召；识别私信、Telegram/微信、点头像、进群、链接、关注、福利、写真、私密照、完整版、房间号、密码、会员、直播、长数字 ID，以及“成人会员今日特价”这类购买话术。',
      trueCriteria: '性化/成人私密内容与私聊、联系方式、外链、点头像、关注、进群、约会、会员、直播、照片、购买或访问行动组合出现；重复 emoji 只能辅助，不单独构成引流。',
      falseCriteria: '普通姓名/账号名、普通 Telegram/社群、正常链接、新闻、教育、医学、时尚内容；单独出现“私信/关注/链接/会员”或 emoji 不算 true。',
      threshold: 0.75,
      enabled: true,
      builtin: true,
      applyTo: ['comment', 'post']
    },
    {
      id: 'spam_behavior',
      name: '垃圾内容 / 模板刷屏',
      description: '隐藏重复模板、低质批量内容、异常 emoji 组合和引流式刷屏。',
      instructions: '判断 `content` 是否为垃圾内容、批量模板刷屏或低质互动诱导。`page_template_matches >= 2` 是强信号：去掉 emoji、标点和可替换 token 后句式重复时，即使表面是祝福或普通中文也判 true。`invisible_char_count >= 3` 且伴随 emoji 或模板结构时，也判为故意污染/规避检测。连续两个以上 emoji 夹在较长、无自然标点的句式中，且色情/垃圾语义得到中等支持时，也视为单条模板化 spam。重点识别复制粘贴骨架、随机 emoji 插入、空泛互动诱导和批量生成；单条自然内容、孤立 emoji 或单个不可见字符不算 spam。',
      trueCriteria: '去掉 emoji/标点/可替换 token 后的页面近重复句式，随机替换 emoji 的复制模板，或多个不可见字符污染与 emoji/模板结构同时出现；也可结合低质空泛、互动诱导、批量生成特征。',
      falseCriteria: '一次性正常内容、具体观点、真实对话、普通祝福或自然使用 emoji；没有重复/模板证据时不要仅凭短句或 emoji 判 spam。',
      threshold: 0.78,
      enabled: true,
      builtin: true,
      applyTo: ['comment', 'post']
    }
  ];

  const DEFAULT_CONFIG = {
    enabled: true,
    onboardingCompleted: false,
    rulesVersion: CONFIG_VERSION,
    theme: 'system',
    uiLang: 'system',
    failOpen: true,
    preload: false,
    lazyScan: true,
    showPlaceholder: true,
    showConfidence: true,
    showCheckControls: false,
    showMonitor: true,
    maxConcurrency: 3,
    cacheTtlHours: 24,
    dailyLimit: 100000,
    debug: false,
    model: MODEL_VERSION,
    apiEndpoint: API_ENDPOINT,
    scopes: clone(DEFAULT_SCOPES),
    rules: clone(DEFAULT_RULES)
  };

  const INVISIBLE_CHAR_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF]/gu;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeThreshold(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? clamp(numeric, 0.5, 0.99) : 0.8;
  }

  function normalizeApplyTo(value) {
    const list = Array.isArray(value) ? value : [];
    const filtered = KINDS.filter((kind) => list.includes(kind));
    return filtered.length ? filtered : KINDS.slice();
  }

  function normalizeRule(input, index) {
    const rule = input && typeof input === 'object' ? input : {};
    return {
      id: String(rule.id || `custom_rule_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_'),
      name: String(rule.name || '未命名规则').trim().slice(0, 80),
      description: String(rule.description || rule.trueCriteria || rule.instructions || '').trim().slice(0, 500),
      instructions: String(rule.instructions || '判断 `content` 是否符合以下过滤条件：' + (rule.description || rule.name || '自定义内容') + '。').trim().slice(0, 1200),
      trueCriteria: String(rule.trueCriteria || rule.description || '').trim().slice(0, 800),
      falseCriteria: String(rule.falseCriteria || '').trim().slice(0, 800),
      threshold: normalizeThreshold(rule.threshold),
      enabled: rule.enabled !== false,
      builtin: Boolean(rule.builtin),
      applyTo: normalizeApplyTo(rule.applyTo)
    };
  }

  function createDefaultConfig() {
    return clone(DEFAULT_CONFIG);
  }

  function normalizeScopes(input, legacyCommentsOnly) {
    const raw = input && typeof input === 'object' ? input : {};
    const scopes = {};
    for (const scope of SCOPES) {
      if (typeof raw[scope] === 'boolean') scopes[scope] = raw[scope];
      else scopes[scope] = DEFAULT_SCOPES[scope];
    }
    // elons-job only filtered detail replies when commentsOnly was on (the
    // default). Migrate that flag onto the scope grid instead of dropping it.
    if (typeof raw.detailReplies !== 'boolean' && legacyCommentsOnly === false) {
      for (const scope of SCOPES) if (scope !== 'detailReplies') scopes[scope] = true;
    }
    return scopes;
  }

  function normalizeConfig(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const legacyCommentsOnly = typeof raw.commentsOnly === 'boolean' ? raw.commentsOnly : null;
    const configuredRules = Array.isArray(raw.rules) && raw.rules.length
      ? raw.rules.map(normalizeRule)
      : clone(DEFAULT_RULES);
    const configuredIds = new Set(configuredRules.map((rule) => rule.id));
    const mergedRules = configuredRules.concat(DEFAULT_RULES.filter((rule) => !configuredIds.has(rule.id)).map(clone));
    const defaultsById = new Map(DEFAULT_RULES.map((rule) => [rule.id, rule]));
    const rules = mergedRules.map((rule) => {
      const builtin = defaultsById.get(rule.id);
      if (!builtin || rule.builtin !== true) return rule;
      // Upgrade persisted builtin prompts to the current wording while
      // preserving the user's enabled flag, threshold and applyTo selection.
      const applyTo = normalizeApplyTo(rule.applyTo);
      const builtinApplyTo = applyTo.length === KINDS.length && !Array.isArray(rule.applyTo)
        ? builtin.applyTo
        : applyTo;
      return { ...clone(builtin), enabled: rule.enabled, threshold: rule.threshold, applyTo: builtinApplyTo };
    });
    const legacyDailyLimit = Number(raw.rulesVersion || 0) < 3 && Number(raw.dailyLimit) === 2000;
    return {
      enabled: raw.enabled !== false,
      onboardingCompleted: raw.onboardingCompleted === true,
      rulesVersion: CONFIG_VERSION,
      theme: ['system', 'dark', 'light'].includes(raw.theme) ? raw.theme : 'system',
      uiLang: ['system', 'zh', 'en'].includes(raw.uiLang) ? raw.uiLang : 'system',
      failOpen: raw.failOpen !== false,
      preload: raw.preload === true,
      lazyScan: raw.lazyScan !== false,
      showPlaceholder: raw.showPlaceholder !== false,
      showConfidence: raw.showConfidence !== false,
      showCheckControls: raw.showCheckControls === true,
      showMonitor: raw.showMonitor !== false,
      maxConcurrency: clamp(Number(raw.maxConcurrency) || 3, 1, 8),
      cacheTtlHours: clamp(Number(raw.cacheTtlHours) || 24, 1, 168),
      dailyLimit: legacyDailyLimit ? 100000 : clamp(Number(raw.dailyLimit) || 100000, 1, 100000),
      debug: raw.debug === true,
      model: String(raw.model || MODEL_VERSION).slice(0, 80),
      apiEndpoint: String(raw.apiEndpoint || API_ENDPOINT),
      scopes: normalizeScopes(raw.scopes, legacyCommentsOnly),
      rules
    };
  }

  function sanitizeConfig(input) {
    return normalizeConfig(input);
  }

  function scopeActive(config, scope) {
    const scopes = (config && config.scopes) || DEFAULT_SCOPES;
    return scopes[scope] !== false;
  }

  function activeRules(config, kind) {
    return normalizeConfig(config).rules.filter((rule) => {
      if (rule.enabled === false) return false;
      if (kind && !rule.applyTo.includes(kind)) return false;
      return true;
    });
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(INVISIBLE_CHAR_RE, '')
      .replace(/[\t\n\r ]+/g, ' ')
      .trim()
      .slice(0, MAX_CONTENT_LENGTH);
  }

  function invisibleCharCount(value) {
    return (String(value || '').match(INVISIBLE_CHAR_RE) || []).length;
  }

  const EMOJI_TOKEN_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/gu;
  const EMOJI_RUN_RE = /(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D|\p{Emoji_Modifier})*)+/gu;
  const EMOJI_DECORATION_RE = /[\uFE0E\uFE0F\u200D\p{Emoji_Modifier}]/gu;

  function emojiSignals(value) {
    const text = normalizeText(value);
    const tokens = text.match(EMOJI_TOKEN_RE) || [];
    const runs = text.match(EMOJI_RUN_RE) || [];
    const characters = Array.from(text).length;
    const maxRun = runs.reduce((max, run) => Math.max(max, (run.match(EMOJI_TOKEN_RE) || []).length), 0);
    const uniqueTokens = new Set(tokens);
    return {
      count: tokens.length,
      ratio: Number((tokens.length / Math.max(1, characters)).toFixed(3)),
      runs: runs.length,
      maxRun,
      repeats: Math.max(0, tokens.length - uniqueTokens.size)
    };
  }

  function stripEmoji(value) {
    return normalizeText(value).replace(EMOJI_TOKEN_RE, '').replace(EMOJI_DECORATION_RE, '');
  }

  function formatEmojiSignals(label, value) {
    const signals = emojiSignals(value);
    return `${label}_emoji_count=${signals.count},${label}_emoji_ratio=${Math.round(signals.ratio * 100)}%,${label}_emoji_runs=${signals.runs},${label}_emoji_max_run=${signals.maxRun},${label}_emoji_repeats=${signals.repeats}`;
  }

  function templateFingerprint(value) {
    return stripEmoji(value)
      .toLocaleLowerCase()
      .replace(/[a-z]+/gi, '#')
      .replace(/[\p{P}\p{S}\s]+/gu, '')
      .replace(/\d+/g, '#')
      .slice(0, 160);
  }

  const BODY_LABEL = { comment: '评论正文', post: '帖子正文' };

  // Builds the exact string sent to TypeSafe. `kind` only changes the body
  // label shown to the model; the structural signal block stays identical so
  // benchmark corpora remain comparable across kinds.
  function composeContent(input) {
    const target = input && typeof input === 'object' ? input : { text: input };
    const kind = target.kind === 'post' ? 'post' : 'comment';
    const rawAuthor = String(target.author || target.username || target.userName || '');
    const rawText = String(target.text || '');
    const author = normalizeText(rawAuthor);
    const text = normalizeText(rawText);
    const bodyLabel = BODY_LABEL[kind];
    const content = !author ? text : !text ? `[用户名] ${author}` : `[用户名] ${author}\n[${bodyLabel}] ${text}`;
    const authorEmoji = emojiSignals(author);
    const bodyEmoji = emojiSignals(text);
    const templateCount = Number(target.templateCount) || 0;
    const invisibleCount = Number(target.invisibleCharCount) || invisibleCharCount(rawAuthor) + invisibleCharCount(rawText);
    if (!authorEmoji.count && !bodyEmoji.count && templateCount < 2 && invisibleCount < 1) return content;
    const strippedAuthor = stripEmoji(author);
    const strippedBody = stripEmoji(text);
    const signals = `${formatEmojiSignals('username', author)}; ${formatEmojiSignals('body', text)}; invisible_char_count=${invisibleCount}; username_without_emoji=${strippedAuthor || '—'}; body_without_emoji=${strippedBody || '—'}${templateCount >= 2 ? `; page_template_matches=${templateCount}` : ''}`;
    return `${content}\n[emoji 结构信号] ${signals}`.slice(0, MAX_CONTENT_LENGTH);
  }

  // Back-compat alias for the elons-job naming used by benchmarks/tests.
  function composeComment(input) {
    return composeContent(input);
  }

  function buildQuestions(rules) {
    return (rules || []).reduce((questions, rule) => {
      questions[rule.id] = {
        type: 'noul',
        instructions: rule.instructions,
        criteria: {
          true: rule.trueCriteria || '内容符合该规则描述。',
          false: rule.falseCriteria || '内容不符合该规则描述。'
        }
      };
      return questions;
    }, {});
  }

  function getProbability(answer) {
    if (!answer || typeof answer !== 'object') return 0;
    const candidates = [
      answer.pTrue,
      answer.noul,
      answer.probabilities && answer.probabilities.true,
      answer.probabilities && answer.probabilities['true'],
      answer.probabilities && answer.probabilities.yes
    ];
    const found = candidates.find((value) => Number.isFinite(Number(value)));
    return found === undefined ? 0 : clamp(Number(found), 0, 1);
  }

  function readAnswers(payload) {
    if (!payload || typeof payload !== 'object') return {};
    return payload.answers && typeof payload.answers === 'object' ? payload.answers : payload;
  }

  function readSignal(content, name) {
    const match = String(content || '').match(new RegExp(`${name}=([0-9]+)`));
    return match ? Number(match[1]) : 0;
  }

  function localSpamSignal(content) {
    const templateMatches = readSignal(content, 'page_template_matches');
    const bodyEmojiCount = readSignal(content, 'body_emoji_count');
    const bodyEmojiRuns = readSignal(content, 'body_emoji_runs');
    const bodyEmojiMaxRun = readSignal(content, 'body_emoji_max_run');
    const invisibleCount = readSignal(content, 'invisible_char_count');
    const bodyMatch = String(content || '').match(/body_without_emoji=([^;\n]*)/);
    const body = bodyMatch ? bodyMatch[1] : '';
    const compactBody = body.replace(/[\s\p{P}\p{S}]+/gu, '');
    const emojiClusterTemplate = bodyEmojiCount >= 2
      && bodyEmojiRuns === 1
      && bodyEmojiMaxRun >= 2
      && compactBody.length >= 16
      && !/[，。！？,.!?;；:：]/u.test(body);
    return {
      templateMatches,
      bodyEmojiCount,
      bodyEmojiRuns,
      bodyEmojiMaxRun,
      invisibleCount,
      emojiClusterTemplate,
      matched: (templateMatches >= 2 && bodyEmojiCount >= 1) || (invisibleCount >= 3 && (bodyEmojiCount >= 1 || templateMatches >= 2))
    };
  }

  function localObfuscatedSexualSignal(content) {
    const bodyEmojiCount = readSignal(content, 'body_emoji_count');
    const match = String(content || '').match(/body_without_emoji=([^;\n]*)/);
    const body = match ? match[1] : '';
    const representativeAnchor = /只进身体|搞\s*h\s*s|小马开大车|比我好看的没我骚/i.test(body);
    return { bodyEmojiCount, representativeAnchor, matched: bodyEmojiCount >= 2 && representativeAnchor };
  }

  function combinedRiskSignal(results, rules, localSignals) {
    const components = (rules || [])
      .filter((rule) => rule.enabled !== false && COMBINED_RISK_RULE_IDS.includes(rule.id))
      .map((rule) => ({ ruleId: rule.id, probability: Number(results[rule.id] || 0) }))
      .filter((item) => Number.isFinite(item.probability));
    const score = components.reduce((sum, item) => sum + item.probability, 0);
    const qualifying = components.filter((item) => item.probability >= COMBINED_RISK_MIN_COMPONENT);
    const structuralSupport = Boolean(localSignals && (
      localSignals.spam.bodyEmojiCount >= 1
      || localSignals.spam.templateMatches >= 2
      || localSignals.spam.invisibleCount >= 3
    ));
    return {
      score,
      threshold: COMBINED_RISK_THRESHOLD,
      minComponent: COMBINED_RISK_MIN_COMPONENT,
      qualifyingRuleIds: qualifying.map((item) => item.ruleId),
      structuralSupport,
      matched: structuralSupport && qualifying.length >= 2 && score >= COMBINED_RISK_THRESHOLD
    };
  }

  function buildDecision(response, rules, context) {
    const answers = readAnswers(response);
    const results = {};
    const matches = [];
    const localSignals = {
      spam: localSpamSignal(context && context.content),
      sexualObfuscation: localObfuscatedSexualSignal(context && context.content)
    };
    for (const rule of rules || []) {
      const probability = getProbability(answers[rule.id]);
      results[rule.id] = probability;
      const emojiClusterModelSupported = localSignals.spam.emojiClusterTemplate
        && ((results.sexual_content >= 0.45 && results.spam_behavior >= 0.15) || results.spam_behavior >= 0.45);
      const spamModelSupported = localSignals.spam.bodyEmojiCount >= 1 || localSignals.spam.invisibleCount >= 3 || emojiClusterModelSupported;
      if (rule.enabled !== false && probability >= normalizeThreshold(rule.threshold) && (rule.id !== 'spam_behavior' || spamModelSupported)) {
        matches.push({
          ruleId: rule.id,
          name: rule.name,
          probability,
          threshold: normalizeThreshold(rule.threshold)
        });
      }
    }
    localSignals.combinedRisk = combinedRiskSignal(results, rules, localSignals);
    const spamRule = (rules || []).find((rule) => rule.id === 'spam_behavior' && rule.enabled !== false);
    const emojiClusterModelSupported = localSignals.spam.emojiClusterTemplate
      && ((results.sexual_content >= 0.45 && results.spam_behavior >= 0.15) || results.spam_behavior >= 0.45);
    if (spamRule && (localSignals.spam.matched || emojiClusterModelSupported) && !matches.some((match) => match.ruleId === spamRule.id)) {
      matches.push({
        ruleId: spamRule.id,
        name: spamRule.name,
        probability: Math.max(results[spamRule.id] || 0, normalizeThreshold(spamRule.threshold)),
        threshold: normalizeThreshold(spamRule.threshold),
        source: localSignals.spam.matched ? 'page-template-signal' : 'emoji-cluster-signal'
      });
    }
    const sexualRule = (rules || []).find((rule) => rule.id === 'sexual_content' && rule.enabled !== false);
    if (sexualRule && localSignals.sexualObfuscation.matched && !matches.some((match) => match.ruleId === sexualRule.id)) {
      matches.push({
        ruleId: sexualRule.id,
        name: sexualRule.name,
        probability: Math.max(results[sexualRule.id] || 0, normalizeThreshold(sexualRule.threshold)),
        threshold: normalizeThreshold(sexualRule.threshold),
        source: 'emoji-obfuscation-signal'
      });
    }
    if (localSignals.combinedRisk.matched) {
      matches.push({
        ruleId: 'combined_risk',
        name: DECISION_LABELS.combined_risk,
        probability: 1,
        threshold: 1,
        combinedScore: localSignals.combinedRisk.score,
        source: 'combined-risk-signal'
      });
    }
    matches.sort((a, b) => b.probability - a.probability);
    return { results, matches, localSignals, combinedRisk: localSignals.combinedRisk, shouldHide: matches.length > 0 };
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((out, key) => {
        out[key] = stableValue(value[key]);
        return out;
      }, {});
    }
    return value;
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }

  function fallbackHash(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  async function hashText(value) {
    const source = String(value);
    if (root.crypto && root.crypto.subtle && root.TextEncoder) {
      const data = new root.TextEncoder().encode(source);
      const digest = await root.crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return fallbackHash(source);
  }

  async function rulesFingerprint(rules) {
    return hashText(stableStringify((rules || []).filter((rule) => rule.enabled !== false).map((rule) => ({
      id: rule.id,
      instructions: rule.instructions,
      trueCriteria: rule.trueCriteria,
      falseCriteria: rule.falseCriteria,
      applyTo: rule.applyTo
    }))));
  }

  async function cacheKey(text, rules, model) {
    const normalized = normalizeText(text);
    const fingerprint = await rulesFingerprint(rules);
    return hashText(stableStringify({ normalized, fingerprint, model: model || MODEL_VERSION, decisionVersion: DECISION_VERSION }));
  }

  function maskSecret(value) {
    const secret = String(value || '');
    if (!secret) return '';
    if (secret.length <= 8) return '••••••••';
    return `${secret.slice(0, 4)}${'•'.repeat(Math.min(20, secret.length - 8))}${secret.slice(-4)}`;
  }

  // ---------------------------------------------------------------------------
  // Page classification. Pure URL -> context mapping so tests can drive it
  // without a DOM. `type` feeds SCOPE_BY_TYPE; detail pages additionally
  // carry rootTweetId so the adapter can split root post from replies.
  // ---------------------------------------------------------------------------

  const PAGE_TYPES = {
    HOME: 'home',
    SEARCH: 'search',
    EXPLORE: 'explore',
    PROFILE: 'profile',
    DETAIL: 'detail',
    BOOKMARKS: 'bookmarks',
    LISTS: 'lists',
    NOTIFICATIONS: 'notifications',
    MESSAGES: 'messages',
    OTHER: 'other'
  };

  // Pages without a configurable scope map to null and are skipped entirely.
  const SCOPE_BY_TYPE = {
    home: 'timeline',
    search: 'search',
    explore: 'explore',
    profile: 'profile',
    bookmarks: 'timeline',
    lists: 'timeline',
    detail: 'detail',
    notifications: null,
    messages: null,
    other: null
  };

  const RESERVED_FIRST_SEGMENTS = new Set([
    'home', 'search', 'explore', 'notifications', 'messages', 'i', 'settings',
    'compose', 'intent', 'hashtag', 'topics', 'custom-timelines', 'logout', 'account'
  ]);

  function classifyPage(url) {
    // Strip any origin (not just x.com) so URL-based routing stays testable
    // against local mock pages; on real x.com the behaviour is identical.
    const path = String(url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].split('#')[0];
    const segments = path.split('/').filter(Boolean);
    const first = segments[0] || '';
    if (first === 'home') return { type: PAGE_TYPES.HOME, rootTweetId: null };
    if (first === 'search') return { type: PAGE_TYPES.SEARCH, rootTweetId: null };
    if (first === 'explore') return { type: PAGE_TYPES.EXPLORE, rootTweetId: null };
    if (first === 'notifications') return { type: PAGE_TYPES.NOTIFICATIONS, rootTweetId: null };
    if (first === 'messages') return { type: PAGE_TYPES.MESSAGES, rootTweetId: null };
    if (first === 'i') {
      if (segments[1] === 'bookmarks') return { type: PAGE_TYPES.BOOKMARKS, rootTweetId: null };
      if (segments[1] === 'lists') return { type: PAGE_TYPES.LISTS, rootTweetId: null };
      return { type: PAGE_TYPES.OTHER, rootTweetId: null };
    }
    if (segments[1] === 'status' && /^\d+$/.test(segments[2] || '')) {
      return { type: PAGE_TYPES.DETAIL, rootTweetId: segments[2] };
    }
    if (first && !RESERVED_FIRST_SEGMENTS.has(first)) return { type: PAGE_TYPES.PROFILE, rootTweetId: null };
    return { type: PAGE_TYPES.OTHER, rootTweetId: null };
  }

  function isTweetDetailUrl(url) {
    return classifyPage(url).type === PAGE_TYPES.DETAIL;
  }

  function rootTweetId(url) {
    return classifyPage(url).rootTweetId;
  }

  function storageArea(chromeApi, areaName) {
    return chromeApi && chromeApi.storage && (chromeApi.storage[areaName] || chromeApi.storage.local);
  }

  function storageGet(chromeApi, areaName, key) {
    const area = storageArea(chromeApi, areaName);
    if (!area) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        area.get(key, (result) => resolve(result || {}));
      } catch (_) {
        resolve({});
      }
    });
  }

  function storageSet(chromeApi, areaName, value) {
    const area = storageArea(chromeApi, areaName);
    if (!area) return Promise.resolve();
    return new Promise((resolve) => {
      try { area.set(value, resolve); } catch (_) { resolve(); }
    });
  }

  function storageRemove(chromeApi, areaName, key) {
    const area = storageArea(chromeApi, areaName);
    if (!area) return Promise.resolve();
    return new Promise((resolve) => {
      try { area.remove(key, resolve); } catch (_) { resolve(); }
    });
  }

  async function loadConfig(chromeApi, includeSecret) {
    const stored = await storageGet(chromeApi, 'local', STORAGE_KEY);
    const config = normalizeConfig(stored[STORAGE_KEY]);
    if (includeSecret) config.typesafeApiKey = String((stored[STORAGE_KEY] || {}).typesafeApiKey || '');
    return config;
  }

  async function saveConfig(chromeApi, patch) {
    const stored = await storageGet(chromeApi, 'local', STORAGE_KEY);
    const current = stored[STORAGE_KEY] || {};
    const next = { ...current, ...sanitizeConfig({ ...current, ...patch }) };
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'typesafeApiKey')) {
      next.typesafeApiKey = String(patch.typesafeApiKey || '').trim();
    } else if (current.typesafeApiKey) {
      next.typesafeApiKey = current.typesafeApiKey;
    }
    await storageSet(chromeApi, 'local', { [STORAGE_KEY]: next });
    return normalizeConfig(next);
  }

  // One-shot import from elons-job storage. Returns a patch for saveConfig or
  // null when nothing to migrate. Never deletes the legacy extension's data.
  function legacyConfigPatch(legacyRaw) {
    const legacy = legacyRaw && typeof legacyRaw === 'object' ? legacyRaw : null;
    if (!legacy) return null;
    const patch = {};
    if (legacy.typesafeApiKey) {
      patch.typesafeApiKey = String(legacy.typesafeApiKey).trim();
      patch.onboardingCompleted = true;
    } else if (legacy.onboardingCompleted === true) {
      patch.onboardingCompleted = true;
    }
    if (Array.isArray(legacy.rules) && legacy.rules.length) {
      const legacyIds = new Set(legacy.rules.map((rule) => rule && rule.id));
      const customs = legacy.rules
        .filter((rule) => rule && rule.id && !DEFAULT_RULES.some((builtin) => builtin.id === rule.id))
        .map((rule) => normalizeRule(rule));
      // Keep user's enabled/threshold on builtin rules, then refresh prompts.
      const builtins = DEFAULT_RULES.map((builtin) => {
        const stored = legacy.rules.find((rule) => rule && rule.id === builtin.id);
        return stored
          ? { ...builtin, enabled: stored.enabled !== false, threshold: normalizeThreshold(stored.threshold) }
          : clone(builtin);
      });
      // A builtin the user deleted stays deleted only if the id is absent.
      const preserved = builtins.filter((builtin) => legacyIds.size === 0 || legacyIds.has(builtin.id) || !LEGACY_BUILTIN_IDS.has(builtin.id));
      patch.rules = preserved.concat(customs);
    }
    if (typeof legacy.enabled === 'boolean') patch.enabled = legacy.enabled;
    const scopes = normalizeScopes(legacy.scopes, typeof legacy.commentsOnly === 'boolean' ? legacy.commentsOnly : null);
    patch.scopes = scopes;
    return Object.keys(patch).length ? patch : null;
  }

  const LEGACY_BUILTIN_IDS = new Set(DEFAULT_RULES.map((rule) => rule.id));

  async function migrateLegacy(chromeApi) {
    const existing = await storageGet(chromeApi, 'local', STORAGE_KEY);
    if (existing[STORAGE_KEY]) return null;
    const legacyStored = await storageGet(chromeApi, 'local', LEGACY_CONFIG_KEY);
    const patch = legacyConfigPatch(legacyStored[LEGACY_CONFIG_KEY]);
    if (!patch) return null;
    await saveConfig(chromeApi, patch);
    const legacyStats = await storageGet(chromeApi, 'local', LEGACY_STATS_KEY);
    const legacy = legacyStats[LEGACY_STATS_KEY];
    if (legacy && (Number(legacy.totalChecked) || Number(legacy.totalHidden))) {
      await storageSet(chromeApi, 'local', {
        [STATS_KEY]: {
          day: new Date().toISOString().slice(0, 10),
          totalChecked: Number(legacy.totalChecked) || 0,
          totalHidden: Number(legacy.totalHidden) || 0
        }
      });
    }
    // Return the config with the secret included: callers decide how much
    // of it to expose.
    return loadConfig(chromeApi, true);
  }

  const EMPTY_STATS = {
    day: '',
    requests: 0,
    cacheHits: 0,
    errors: 0,
    checked: 0,
    hidden: 0,
    postsChecked: 0,
    postsHidden: 0,
    totalChecked: 0,
    totalHidden: 0,
    totalPostsChecked: 0,
    totalPostsHidden: 0,
    latencyMs: 0,
    lastError: '',
    pageChecked: 0,
    pageHidden: 0,
    pageSafe: 0,
    pagePending: 0,
    pageErrors: 0,
    pageLatencyMs: 0,
    pagePostChecked: 0,
    pagePostHidden: 0
  };

  async function getStats(chromeApi) {
    const today = new Date().toISOString().slice(0, 10);
    const stored = await storageGet(chromeApi, 'local', STATS_KEY);
    const stats = stored[STATS_KEY] || {};
    const base = { ...EMPTY_STATS, totalChecked: Number(stats.totalChecked) || 0, totalHidden: Number(stats.totalHidden) || 0, totalPostsChecked: Number(stats.totalPostsChecked) || 0, totalPostsHidden: Number(stats.totalPostsHidden) || 0 };
    if (stats.day !== today) return { ...base, day: today };
    return {
      ...base,
      day: today,
      requests: Number(stats.requests) || 0,
      cacheHits: Number(stats.cacheHits) || 0,
      errors: Number(stats.errors) || 0,
      checked: Number(stats.checked) || 0,
      hidden: Number(stats.hidden) || 0,
      postsChecked: Number(stats.postsChecked) || 0,
      postsHidden: Number(stats.postsHidden) || 0,
      latencyMs: Number(stats.latencyMs) || 0,
      lastError: String(stats.lastError || ''),
      pageChecked: Number(stats.pageChecked) || 0,
      pageHidden: Number(stats.pageHidden) || 0,
      pageSafe: Number(stats.pageSafe) || 0,
      pagePending: Number(stats.pagePending) || 0,
      pageErrors: Number(stats.pageErrors) || 0,
      pageLatencyMs: Number(stats.pageLatencyMs) || 0,
      pagePostChecked: Number(stats.pagePostChecked) || 0,
      pagePostHidden: Number(stats.pagePostHidden) || 0
    };
  }

  async function updateStats(chromeApi, changes) {
    const next = { ...(await getStats(chromeApi)), ...(changes || {}) };
    await storageSet(chromeApi, 'local', { [STATS_KEY]: next });
    return next;
  }

  function cleanError(error) {
    const code = error && error.code ? String(error.code) : '';
    if (code) return code;
    const status = error && Number(error.status);
    if (status === 401 || status === 403) return 'API_KEY_INVALID';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'API_SERVER_ERROR';
    if (error && error.name === 'AbortError') return 'API_TIMEOUT';
    return 'API_UNAVAILABLE';
  }

  function debugLog(config, event, data) {
    if (!config || !config.debug || !root.console || typeof root.console.debug !== 'function') return;
    const safe = { ...(data || {}) };
    delete safe.apiKey;
    delete safe.typesafeApiKey;
    delete safe.content;
    root.console.debug(`[Jev X Blocker] ${event}`, safe);
  }

  const exported = {
    APP,
    STORAGE_KEY,
    STATS_KEY,
    CACHE_KEY,
    LEGACY_CONFIG_KEY,
    LEGACY_STATS_KEY,
    MODEL_VERSION,
    DECISION_VERSION,
    CONFIG_VERSION,
    API_ENDPOINT,
    MAX_CONTENT_LENGTH,
    KINDS,
    SCOPES,
    MESSAGE,
    DEFAULT_RULES,
    DEFAULT_CONFIG,
    DEFAULT_SCOPES,
    PAGE_TYPES,
    SCOPE_BY_TYPE,
    EMPTY_STATS,
    clone,
    clamp,
    normalizeRule,
    createDefaultConfig,
    normalizeConfig,
    sanitizeConfig,
    normalizeScopes,
    scopeActive,
    activeRules,
    normalizeText,
    invisibleCharCount,
    emojiSignals,
    stripEmoji,
    templateFingerprint,
    composeContent,
    composeComment,
    buildQuestions,
    getProbability,
    readAnswers,
    localSpamSignal,
    localObfuscatedSexualSignal,
    combinedRiskSignal,
    buildDecision,
    stableStringify,
    hashText,
    rulesFingerprint,
    cacheKey,
    maskSecret,
    classifyPage,
    isTweetDetailUrl,
    rootTweetId,
    legacyConfigPatch,
    migrateLegacy,
    storageGet,
    storageSet,
    storageRemove,
    loadConfig,
    saveConfig,
    getStats,
    updateStats,
    cleanError,
    debugLog,
    DECISION_LABELS,
  };

  root[APP] = Object.assign(root[APP] || {}, exported);
  root.JXB = root[APP];
  if (typeof module !== 'undefined' && module.exports) module.exports = root[APP];
})(typeof globalThis !== 'undefined' ? globalThis : self);
