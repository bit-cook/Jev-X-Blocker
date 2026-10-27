// Deep inspection — goes beyond scripts/inspect.mjs:
//   1. text hygiene (mojibake, TODO/FIXME, stray debug leftovers)
//   2. behaviour contracts (fail-open paths, migration idempotence)
//   3. performance assumptions (observer debounce, cache bounds)
//   4. doc/site consistency (README vs pages vs package vs manifest)
//   5. dependency health (no node_modules drift, scripts referenced exist)
//   node scripts/deep-check.mjs
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); problems.push(`${name}: ${detail}`); }
};
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

console.log('== A. 文本卫生 ==');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = join(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});
const sourceFiles = [...walk(resolve(ROOT, 'src')), ...walk(resolve(ROOT, 'tests')), ...walk(resolve(ROOT, 'scripts'))]
  .filter((f) => /\.(js|mjs|html|css|json)$/.test(f) && !f.endsWith('deep-check.mjs'));
const mojibake = [];
const todoMarks = [];
for (const f of sourceFiles) {
  const text = readFileSync(f, 'utf8');
  if (/Ã|â€|ï¼|ë‹|æå|\uFFFD/.test(text)) mojibake.push(relative(ROOT, f));
  const m = text.match(/\/\/\s*(TODO|FIXME|HACK|XXX)[: ]/g);
  if (m) todoMarks.push(`${relative(ROOT, f)}: ${m.length}`);
}
check('无乱码字符', mojibake.length === 0, mojibake.join(', '));
check('无 TODO/FIXME/HACK 遗留', todoMarks.length === 0, todoMarks.join(', '));
check('无 console.log 遗留在 src/', !sourceFiles.filter((f) => f.includes(`${resolve(ROOT, 'src')}`)).some((f) => /console\.log/.test(readFileSync(f, 'utf8'))));

console.log('== B. 行为契约 ==');
const core = read('src/shared/core.js');
const background = read('src/background.js');
const pipeline = read('src/content/pipeline.js');
const main = read('src/content/main.js');
const overlay = read('src/content/overlay.js');

check('消息通道有超时兜底（防 MV3 悬挂）', /SEND_TIMEOUT_MS/.test(pipeline) && /NO_RESPONSE/.test(pipeline));
check('SW 分类返回 ok:false 时内容脚本放行（fail-open）', /applySafe\(article\)/.test(pipeline));
check('dailyLimit 门控存在', /DAILY_LIMIT_REACHED/.test(background) && /reserveRequest/.test(background));
check('缓存带 TTL 校验', /cacheTtlHours/.test(background) && /createdAt/.test(background));
check('迁移幂等（已有配置则跳过）', /if \(existing\[STORAGE_KEY\]\) return null/.test(core));
check('SW 侧分类缓存有界（≤600）', /CACHE_MAX_ENTRIES = 600/.test(background) && /slice\(-CACHE_MAX_ENTRIES\)/.test(background));
check('SW 空闲挂起后内存缓存可冷启动回灌', /sessionCacheHydrated/.test(background));
check('统计写入串行化（statsGate）', /statsGate/.test(background));
check('IO 观察在路由切换后重新武装（防漏分类）', /io\.unobserve\(article\)/.test(main) && /io\.observe\(article\)/.test(main));
check('DOM 清扫存在（防长会话内存增长）', /cleanupSweep/.test(overlay) && /sweep/.test(main));
check('页面隐藏时 flush 统计（pagehide/visibilitychange）', /pagehide/.test(main) && /visibilitychange/.test(main));
check('X SPA 路由切换重置状态', /resetRouteIfNeeded/.test(main));
check('批量统计上报（1200ms 合并）', /scheduleReport/.test(pipeline) && /1200/.test(pipeline));
check('主题 system 模式跟随 OS 变化', /addEventListener\('change', onThemeChange\)|addListener\(onThemeChange\)/.test(main));

console.log('== C. 性能假设 ==');
check('scan 有防抖（避免 MutationObserver 风暴）', /SCAN_DEBOUNCE_MS = 150/.test(main) && /scheduleScan/.test(main));
check('hash 记忆化（避免重复 SHA-256）', /memoizedHash/.test(pipeline) && /hashMemo/.test(pipeline));
check('IO 注册表有界（清扫时删除）', /ioTargets\.delete/.test(main));
check('SW 缓存写入不超过存储配额（bounded）', /bounded/.test(background));
check('内容脚本不持有大 DOM 引用（WeakMap/WeakSet）', /WeakMap|WeakSet/.test(overlay) || /WeakSet|WeakMap/.test(pipeline));

console.log('== D. 文档/站点一致性 ==');
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('manifest.json'));
const readme = read('README.md');
check('README 版本 == manifest', readme.includes(`v${manifest.version}`));
check('README 不引用已删除的章节', !readme.includes('与 elons-job 的区别'));
const site = read('test-browser/artifacts/gh-pages/index.html');
check('官网版本 == manifest', site.includes(`v${manifest.version}`) && !site.includes(`v${pkg.version === manifest.version ? '0.0.0' : pkg.version}`));
check('官网标语存在', site.includes('More Signal, Less Noise, Better Living.'));
check('官网截图引用存在且无竖屏遗留', site.includes('shots/console.png') && !site.includes('shots/popup.png'));
for (const asset of ['assets/icon128.png', 'shots/console.png', 'shots/settings.png', 'shots/content.png']) {
  check(`官网资产存在 ${asset}`, existsSync(resolve(ROOT, 'test-browser/artifacts/gh-pages', asset)));
}
check('隐私政策无远端脚本', !/<(script|link)[^>]+https?:\/\//i.test(read('privacy.html')));
check('gitignore 覆盖 .env/dist/release/docs/测试产物', ['.env', 'dist/', 'release/', 'docs/', 'test-browser/artifacts/', '.edge-profile'].every((p) => read('.gitignore').includes(p)));

console.log('== D2. I18N 双语键一致 ==');
try {
  const i18nPath = resolve(ROOT, 'src/shared/i18n.js');
  const tmp = { exports: null };
  const moduleShim = { exports: {} };
  const fn = new Function('module', 'globalThis', readFileSync(i18nPath, 'utf8'));
  fn(moduleShim, { JevXBlocker: {} });
  const dict = moduleShim.exports.MESSAGES;
  const zhKeys = Object.keys(dict.zh).sort();
  const enKeys = Object.keys(dict.en).sort();
  check('I18N 双语键一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), 'diff: ' + zhKeys.filter(k => !enKeys.includes(k)).concat(enKeys.filter(k => !zhKeys.includes(k))).join(', ').slice(0, 200));
  check('I18N 内置规则名齐全', ['sexual_content', 'sexual_solicitation', 'spam_behavior'].every((id) => zhKeys.includes(`rule.${id}.name`) && enKeys.includes(`rule.${id}.name`) && zhKeys.includes(`rule.${id}.desc`) && enKeys.includes(`rule.${id}.desc`)));
  check('I18N 无空值', zhKeys.every(k => String(dict.zh[k]).trim()) && enKeys.every(k => String(dict.en[k]).trim()));
} catch (e) {
  check('I18N 字典可加载', false, e.message.slice(0, 120));
}

console.log('== E. 依赖健康 ==');
check('无 node_modules 依赖（零依赖项目）', !existsSync(resolve(ROOT, 'node_modules')));
check('package.json 无 dependencies', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
const scriptsDir = readdirSync(resolve(ROOT, 'scripts'));
const referenced = [...readme.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
for (const r of referenced) check(`README 引用的脚本存在 ${r}`, scriptsDir.includes(r.replace('scripts/', '')));

console.log('== F. git 状态 ==');
try {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  check('工作区干净', dirty.length === 0, dirty.split('\n').slice(0, 5).join(' | '));
} catch (e) {
  check('git 可用', false, e.message.slice(0, 80));
}

console.log('\n' + (problems.length ? `发现问题 ${problems.length} 个：` : '全部通过 ✅'));
for (const p of problems) console.log('  - ' + p);
process.exitCode = problems.length ? 1 : 0;
