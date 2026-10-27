// Comprehensive static inspection before a release.
//   node scripts/inspect.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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

console.log('== 1. manifest 一致性 ==');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
check('name 走 i18n 占位符', manifest.name === '__MSG_extName__', manifest.name);
check('description 走 i18n 占位符', manifest.description === '__MSG_extDesc__', manifest.description);
check('default_locale 为 zh_CN', manifest.default_locale === 'zh_CN', manifest.default_locale);
const localesOk = ['en', 'zh_CN'].every((locale) => {
  try {
    const messages = JSON.parse(readFileSync(resolve(ROOT, '_locales', locale, 'messages.json'), 'utf8'));
    return messages.extName && messages.extDesc && messages.extName.message.length > 0;
  } catch (_) { return false; }
});
check('_locales/en 与 _locales/zh_CN 存在且含 extName/extDesc', localesOk);
check('版本号格式 x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
check('manifest_version 3', manifest.manifest_version === 3);
check('权限仅 storage', JSON.stringify(manifest.permissions) === '["storage"]', JSON.stringify(manifest.permissions));
check('host_permissions 仅 x.com + typesafe', manifest.host_permissions.length === 2, JSON.stringify(manifest.host_permissions));
for (const forbidden of ['tabs', 'history', 'cookies', 'webRequest', '<all_urls>']) {
  check(`无禁用权限 ${forbidden}`, !JSON.stringify(manifest).includes(forbidden));
}
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
check('package.json 版本与 manifest 一致', pkg.version === manifest.version, `${pkg.version} vs ${manifest.version}`);
const entrypoints = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts[0].js, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
for (const file of entrypoints) check(`入口存在 ${file}`, existsSync(resolve(ROOT, file)));

console.log('== 2. dist/ 与 src/ 同步 ==');
const distManifest = JSON.parse(readFileSync(resolve(ROOT, 'dist/manifest.json'), 'utf8'));
check('dist manifest 版本同步', distManifest.version === manifest.version, `${distManifest.version} vs ${manifest.version}`);
check('dist manifest 名称同步', distManifest.name === manifest.name);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = join(dir, e.name);
  return e.isDirectory() ? walk(full) : [full];
});
const srcFiles = walk(resolve(ROOT, 'src')).map((f) => relative(resolve(ROOT, 'src'), f));
for (const rel of srcFiles) {
  const src = readFileSync(resolve(ROOT, 'src', rel));
  const distFile = resolve(ROOT, 'dist/src', rel.replace(/^src[\\/]/, ''));
  if (!existsSync(distFile)) { check(`dist 缺失 ${rel}`, false); continue; }
  check(`dist 同步 ${rel}`, src.equals(readFileSync(distFile)));
}

console.log('== 3. JS 调用的元素 ID 与 HTML 定义交叉核对 ==');
const pagePairs = [
  ['src/popup.js', 'src/popup.html'],
  ['src/settings.js', 'src/settings.html'],
  ['src/onboarding.js', 'src/onboarding.html']
];
for (const [jsFile, htmlFile] of pagePairs) {
  const js = readFileSync(resolve(ROOT, jsFile), 'utf8');
  const html = readFileSync(resolve(ROOT, htmlFile), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  let missing = [];
  for (const id of ids) {
    if (!html.includes(`id="${id}"`)) missing.push(id);
  }
  check(`${jsFile} 引用的 ID 都在 ${htmlFile}`, missing.length === 0, missing.join(', '));
  // 动态创建的 ID（createCheckControl 等）不在 HTML 中属正常，这里只查 $() 直取
}

console.log('== 4. HTML 引用的本地资源存在 ==');
for (const htmlFile of ['src/popup.html', 'src/settings.html', 'src/onboarding.html']) {
  const html = readFileSync(resolve(ROOT, htmlFile), 'utf8');
  const htmlDir = dirname(resolve(ROOT, htmlFile));
  const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u) && !u.startsWith('data:'));
  for (const ref of refs) {
    const pathOnly = ref.split('?')[0];
    check(`${htmlFile} -> ${ref}`, existsSync(resolve(htmlDir, pathOnly)));
  }
}

console.log('== 5. 关键 CSS 类存在 ==');
const appCss = readFileSync(resolve(ROOT, 'src/styles/app.css'), 'utf8');
const contentCss = readFileSync(resolve(ROOT, 'src/styles/content.css'), 'utf8');
const cssBoth = appCss + contentCss;
for (const cls of [
  'jxb-popup-bottom-left', 'jxb-rule-list', 'jxb-rule-row', 'jxb-theme-row', 'jxb-seg',
  'jxb-card-pad', 'jxb-popup-status', 'jxb-metric', 'jxb-badge', 'jxb-check-host',
  'jxb-placeholder', 'jxb-monitor-actions', 'jxb-monitor-scopes', 'jxb-callout',
  'jxb-page-header', 'jxb-page-footer', 'jxb-standalone'
]) {
  check(`CSS 含 .${cls}`, cssBoth.includes(`.${cls}`));
}

console.log('== 6. 密钥扫描（源码树） ==');
const SKIP = new Set(['.git', 'node_modules', 'dist', 'dist-test', 'release', 'docs', '.edge-profile', '.edge-profile-cors', '.edge-profile-docs', 'test-browser', 'assets']);
const SKIP_FILES = new Set(['.env', 'inspect.mjs']);
const secretPatterns = [/apikey_2111/i, /ghp_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{20,}/];
const scanHits = [];
const scan = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (statSync(full).isDirectory()) scan(full);
    else if (SKIP_FILES.has(e.name)) {
      notes.push(relative(ROOT, full) + ' 已忽略（.env 受 gitignore 保护 / 检查器自身含检测模式）');
    } else {
      const text = readFileSync(full, 'utf8');
      for (const p of secretPatterns) if (p.test(text)) scanHits.push(relative(ROOT, full));
    }
  }
};
scan(ROOT);
check('源码树无密钥', scanHits.length === 0, scanHits.join(', '));

console.log('== 7. 已提交内容密钥扫描（git index） ==');
try {
  const out = execFileSync('git', ['grep', '--cached', '-I', '-n', '-E', 'apikey_2111|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}', '--', ':!scripts/inspect.mjs'], { cwd: ROOT, encoding: 'utf8' });
  check('git 暂存区无密钥', false, out.slice(0, 200));
} catch (e) {
  check('git 暂存区无密钥', e.status === 1, e.message.slice(0, 100));
}

console.log('== 8. README 版本链接与最新 Release 对齐 ==');
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const linkVersions = [...readme.matchAll(/releases\/(?:tag|download)\/(v[\d.]+)/g)].map((m) => m[1]);
check('README 的 Release 链接指向当前版本', linkVersions.every((v) => v === 'v' + manifest.version), linkVersions.join(', ') || '无链接');

console.log('== 9. 语料与消息协议完整性 ==');
const corpus = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/corpus.json'), 'utf8'));
check('语料非空且字段完整', corpus.length >= 80 && corpus.every((c) => c.id && c.text && c.label), `${corpus.length} 条`);
const coreSrc = readFileSync(resolve(ROOT, 'src/shared/core.js'), 'utf8');
for (const msg of ['GET_STATE', 'SAVE_API_KEY', 'TEST_CONNECTION', 'CLASSIFY_TARGET', 'SAVE_CONFIG', 'RECORD_TARGET_EVENT', 'CLEAR_CACHE', 'OPEN_SETTINGS', 'OPEN_ONBOARDING']) {
  check(`消息协议 ${msg}`, coreSrc.includes(`${msg}: '${msg}'`));
}

console.log('\n' + (problems.length ? `发现问题 ${problems.length} 个：` : '全部通过 ✅'));
for (const p of problems) console.log('  - ' + p);
process.exitCode = problems.length ? 1 : 0;
