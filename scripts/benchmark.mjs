import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const core = await import(`${pathToFileURL(resolve(root, 'src/shared/core.js')).href}?benchmark=${Date.now()}`).then((m) => m.default || globalThis.JevXBlocker);

function readDotEnv(source) {
  return source.split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return env;
    const separator = trimmed.indexOf('=');
    if (separator < 1) return env;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
    return env;
  }, {});
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const dotenv = readDotEnv(await readFile(resolve(root, '.env'), 'utf8').catch(() => ''));
const apiKey = process.env.TYPESAFE_API_KEY || dotenv.TYPESAFE_API_KEY;
const endpoint = process.env.TYPESAFE_API_URL || dotenv.TYPESAFE_API_URL || core.API_ENDPOINT;
const limit = Number(arg('limit', '0')) || 0;
const concurrency = Math.max(1, Math.min(8, Number(arg('concurrency', '3')) || 3));
const kindFilter = String(arg('kind', 'all'));
const requestedIds = new Set(String(arg('id', '') || arg('ids', '')).split(',').map((value) => value.trim()).filter(Boolean));
const jsonOutput = process.argv.includes('--json');

if (!apiKey) {
  console.error('Missing TYPESAFE_API_KEY. Put it in .env or the environment.');
  process.exit(2);
}

const corpus = JSON.parse(await readFile(resolve(root, 'tests/fixtures/corpus.json'), 'utf8'));
const byKind = kindFilter === 'all' ? corpus : corpus.filter((item) => (item.kind || 'comment') === kindFilter);
const selected = requestedIds.size ? byKind.filter((item) => requestedIds.has(item.id)) : byKind;
if (requestedIds.size && selected.length !== requestedIds.size) {
  const found = new Set(selected.map((item) => item.id));
  const missing = [...requestedIds].filter((id) => !found.has(id));
  console.error(`Unknown corpus id: ${missing.join(', ')}`);
  process.exit(2);
}
const rows = limit > 0 ? selected.slice(0, limit) : selected;
const rules = core.DEFAULT_RULES;
const questions = core.buildQuestions(rules);
// Template fingerprints only count within the same kind: page template
// signals never mix comments with posts.
const spamTemplateCounts = new Map();
for (const item of byKind) {
  const fingerprint = core.templateFingerprint(item.text);
  if (fingerprint) spamTemplateCounts.set(`${item.kind || 'comment'}|${fingerprint}`, (spamTemplateCounts.get(`${item.kind || 'comment'}|${fingerprint}`) || 0) + 1);
}
const results = [];
let cursor = 0;

async function classify(item) {
  const started = Date.now();
  const kind = item.kind || 'comment';
  const templateCount = spamTemplateCounts.get(`${kind}|${core.templateFingerprint(item.text)}`) || 0;
  try {
    const inspectionContent = core.composeContent({ kind, username: item.username, text: item.text, templateCount });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: core.MODEL_VERSION, state: { content: inspectionContent }, questions }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return { id: item.id, kind, error: `HTTP_${response.status}`, latencyMs: Date.now() - started };
    const payload = await response.json();
    const decision = core.buildDecision(payload, rules, { content: inspectionContent });
    return { id: item.id, kind, expected: item.label, spam: Boolean(item.spam), predicted: decision.shouldHide ? 'HIDE' : 'ALLOW', results: decision.results, combinedRisk: decision.combinedRisk, matches: decision.matches.map((match) => ({ ruleId: match.ruleId, probability: match.probability, combinedScore: match.combinedScore, source: match.source || 'typesafe' })), latencyMs: Date.now() - started };
  } catch (error) {
    return { id: item.id, kind, error: error.name === 'TimeoutError' ? 'API_TIMEOUT' : 'API_UNAVAILABLE', latencyMs: Date.now() - started };
  }
}

async function worker() {
  while (cursor < rows.length) {
    const index = cursor;
    cursor += 1;
    results[index] = await classify(rows[index]);
  }
}

function printDetailedResult(item, result) {
  console.log('\n详细评估结果（默认规则）');
  console.log(`id: ${item.id}`);
  console.log(`kind: ${item.kind || 'comment'}`);
  console.log(`category: ${item.category || '—'}`);
  console.log(`expected: ${item.label || '—'}${item.spam ? ' · spam=true' : ''}`);
  console.log(`username: ${item.username || '—'}`);
  console.log(`text: ${item.text || '—'}`);
  const usernameEmoji = core.emojiSignals(item.username || '');
  const bodyEmoji = core.emojiSignals(item.text || '');
  const templateCount = spamTemplateCounts.get(`${item.kind || 'comment'}|${core.templateFingerprint(item.text)}`) || 0;
  console.log(`emoji: username=${JSON.stringify(usernameEmoji)} body=${JSON.stringify(bodyEmoji)} templateMatches=${templateCount || '—'}`);
  console.log(`latency: ${result.latencyMs}ms`);
  if (result.error) {
    console.log(`error: ${result.error}`);
    return;
  }
  console.log(`predicted: ${result.predicted}`);
  console.log('rules:');
  for (const rule of rules) {
    const probability = Number(result.results[rule.id] || 0);
    const matched = probability >= rule.threshold;
    const localMatch = result.matches.find((match) => match.ruleId === rule.id && match.source);
    const status = localMatch ? `MATCH · ${localMatch.source}` : matched ? 'MATCH' : 'PASS';
    console.log(`  - ${rule.name}: probability=${(probability * 100).toFixed(1)}% threshold=${(rule.threshold * 100).toFixed(0)}% ${status}`);
  }
  console.log(`matches: ${result.matches.length ? result.matches.map((match) => `${match.ruleId} ${(match.probability * 100).toFixed(1)}%`).join(', ') : 'none'}`);
  if (result.combinedRisk) console.log(`combined-risk: score=${result.combinedRisk.score.toFixed(2)} threshold=${result.combinedRisk.threshold.toFixed(2)} qualifying=${result.combinedRisk.qualifyingRuleIds.join(',') || 'none'} ${result.combinedRisk.matched ? 'MATCH' : 'PASS'}`);
  console.log(`sent-content:\n${core.composeContent({ kind: item.kind || 'comment', username: item.username, text: item.text, templateCount })}`);
}

const colorEnabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const ansi = (code, value) => colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : value;
const bold = (value) => ansi('1', value);
const green = (value) => ansi('32', value);
const red = (value) => ansi('31', value);
const yellow = (value) => ansi('33', value);
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const short = (value, width) => {
  const text = String(value || '');
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
};
const progress = (value, width = 12) => {
  const filled = Math.max(0, Math.min(width, Math.round(value * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};

function metricsFor(group) {
  const positives = group.filter((result) => result.predicted === 'HIDE');
  const expectedPositives = group.filter((result) => result.expected === 'HIDE');
  const truePositives = group.filter((result) => result.expected === 'HIDE' && result.predicted === 'HIDE').length;
  const falsePositives = group.filter((result) => result.expected === 'ALLOW' && result.predicted === 'HIDE');
  const falseNegatives = group.filter((result) => result.expected === 'HIDE' && result.predicted === 'ALLOW');
  const precision = positives.length ? truePositives / positives.length : 0;
  const recall = expectedPositives.length ? truePositives / expectedPositives.length : 0;
  return {
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    falsePositiveRate: falsePositives.length / Math.max(1, group.filter((result) => result.expected === 'ALLOW').length),
    cases: group.length,
    falsePositives,
    falseNegatives
  };
}

function printMetricRow(name, metric, note) {
  const status = metric.recall === 1 && metric.falsePositiveRate === 0 ? green('PASS') : red('FAIL');
  console.log(`│ ${name.padEnd(16)} ${String(metric.cases).padStart(5)}  ${pct(metric.precision).padStart(8)}  ${pct(metric.recall).padStart(7)}  ${pct(metric.f1).padStart(7)}  ${pct(metric.falsePositiveRate).padStart(7)}  ${status.padEnd(colorEnabled ? 14 : 4)} ${note || ''}`);
}

function printMisses(items, label) {
  if (!items.length) return;
  console.log(`\n${bold(`漏检详情 · ${label}`)}`);
  console.log('┌──────────┬──────────┬──────────────────────────┬────────────┬────────────┐');
  console.log('│ ID       │ Kind     │ Category                 │ 性色情况   │ 引流情况   │');
  console.log('├──────────┼──────────┼──────────────────────────┼────────────┼────────────┤');
  for (const result of items) {
    const item = byKind.find((candidate) => candidate.id === result.id) || {};
    const content = Number(result.results && result.results.sexual_content || 0);
    const solicitation = Number(result.results && result.results.sexual_solicitation || 0);
    console.log(`│ ${result.id.padEnd(8)} │ ${short(item.kind || 'comment', 8).padEnd(8)} │ ${short(item.category, 24).padEnd(24)} │ ${pct(content).padStart(10)} │ ${pct(solicitation).padStart(10)} │`);
  }
  console.log('└──────────┴──────────┴──────────────────────────┴────────────┴────────────┘');
}

await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
const completed = results.filter((result) => !result.error);
const errors = results.filter((result) => result.error);
const scored = completed.filter((result) => !result.spam);
const spamSamples = completed.filter((result) => result.spam);
const overall = metricsFor(scored);
const commentTrack = metricsFor(scored.filter((result) => (result.kind || 'comment') === 'comment'));
const postTrack = metricsFor(scored.filter((result) => result.kind === 'post'));
const spamMetric = metricsFor(spamSamples);
const averageLatency = completed.length ? completed.reduce((sum, result) => sum + result.latencyMs, 0) / completed.length : 0;
const filter = requestedIds.size ? ` · ids=${[...requestedIds].join(',')}` : ` · kind=${kindFilter}`;

if (jsonOutput) {
  console.log(JSON.stringify({
    endpoint,
    corpusSize: rows.length,
    completed: completed.length,
    scored: scored.length,
    spamSamples: spamSamples.length,
    errors,
    metrics: { ...overall, averageLatencyMs: Math.round(averageLatency) },
    commentMetrics: commentTrack,
    postMetrics: postTrack,
    spamMetrics: spamMetric,
    predictions: results
  }, (key, value) => key === 'results' || key === 'matches' ? undefined : value, 2));
  process.exitCode = errors.length ? 1 : 0;
} else {
  if (requestedIds.size === 1 && rows.length === 1) {
    printDetailedResult(rows[0], results[0]);
    process.exitCode = errors.length ? 1 : 0;
    process.exit();
  }

  console.log('');
  console.log(bold('╭─ JEV-X-BLOCKER BENCHMARK ───────────────────────────────────╮'));
  console.log(`│ ${bold('Endpoint')}  ${short(endpoint, 53)}`);
  console.log(`│ ${bold('Samples')}   ${completed.length}/${rows.length} completed${filter}`);
  console.log(`│ ${bold('Split')}     ${scored.length} rule-scored · ${spamSamples.length} spam · ${errors.length} errors`);
  console.log(`│ ${bold('Latency')}   ${Math.round(averageLatency)}ms average`);
  console.log('╰─────────────────────────────────────────────────────────────╯');

  console.log(`\n${bold('规则轨道')}`);
  console.log('┌────────────────┬───────┬──────────┬─────────┬─────────┬─────────┬────────┐');
  console.log('│ Track          │ Cases │ Prec.    │ Recall  │ F1      │ FP rate │ Status │');
  console.log('├────────────────┼───────┼──────────┼─────────┼─────────┼─────────┼────────┤');
  printMetricRow('all', overall, '默认规则');
  if (commentTrack.cases) printMetricRow('comments', commentTrack, '评论语料');
  if (postTrack.cases) printMetricRow('posts', postTrack, '帖子语料（新）');
  if (spamSamples.length) printMetricRow('spam-samples', spamMetric, '模型 + 页面信号');
  console.log('└────────────────┴───────┴──────────┴─────────┴─────────┴─────────┴────────┘');

  console.log(`\n${bold('指标概览')}`);
  console.log(`  overall recall ${progress(overall.recall)} ${pct(overall.recall)}`);
  if (postTrack.cases) console.log(`  posts recall   ${progress(postTrack.recall)} ${pct(postTrack.recall)}  ${postTrack.recall === 1 && postTrack.falsePositiveRate === 0 ? green('通过') : red('需关注')}`);
  if (spamSamples.length) console.log(`  spam recall    ${progress(spamMetric.recall)} ${pct(spamMetric.recall)}  ${spamMetric.recall === 1 && spamMetric.falsePositiveRate === 0 ? green('通过') : yellow('待实现')}`);
  if (errors.length) console.log(`\n${red('Errors')}  ${errors.map((result) => `${result.id}:${result.error}`).join(', ')}`);
  printMisses(overall.falseNegatives, 'sexual rules');
  printMisses(spamMetric.falseNegatives.map((result) => ({ ...result, spam: true })), 'spam samples');
  if (overall.falsePositives.length) printMisses(overall.falsePositives, 'false positives');
  process.exitCode = errors.length ? 1 : 0;
}
