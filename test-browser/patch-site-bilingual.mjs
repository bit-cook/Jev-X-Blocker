// Injects the bilingual dictionary + language toggle behavior into the site
// page (idempotent patch on test-browser/artifacts/gh-pages/index.html).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(ROOT, 'test-browser/artifacts/gh-pages/index.html');
let t = readFileSync(file, 'utf8');

if (t.includes('data-i18n-key')) {
  console.log('already patched');
  process.exit(0);
}

// 1. Tag every visible string with a key.
const pairs = [
  ['<a href="#install">安装</a>', '<a href="#install" data-i18n-key="nav.install">安装</a>'],
  ['<a href="#features">功能</a>', '<a href="#features" data-i18n-key="nav.features">功能</a>'],
  ['<a href="#privacy">隐私</a>', '<a href="#privacy" data-i18n-key="nav.privacy">隐私</a>'],
  ['下载 v1.1.0', '下载 v1.1.0|Download v1.1.0|nav.download'],
  ['LOCAL-FIRST · CHROME MANIFEST V3 · TYPESAFE JEV', 'LOCAL-FIRST · CHROME MANIFEST V3 · TYPESAFE JEV|kicker'],
  ['把噪声留在视线之外。', '把噪声留在视线之外。|Keep the noise out of sight.|hero.h1'],
  ['用判断模型语义过滤 X 上的垃圾信息与噪声骚扰——<strong style="color:var(--text)">不是关键词匹配</strong>，更准确、更智能；规则用大白话定义，速度快到几乎无感。色情、引流、刷屏只是第一批内置规则，任何你想过滤的垃圾都可以一句话自定义，命中内容一键恢复。',
   'Semantic filtering of garbage and noise harassment on X with judgment models — <strong style="color:var(--text)">not keyword matching</strong>. More accurate, more intelligent; rules in plain language; fast to the point of invisible. Porn, solicitation and flooding are just the first built-in rules — any garbage you want gone is one sentence away, and every hit is one click from restore.|hero.sub'],
  ['⬇ 下载 Jev-X-Blocker-v1.1.0.zip', '⬇ 下载 Jev-X-Blocker-v1.1.0.zip|⬇ Download v1.1.0|hero.download'],
  ['GitHub 仓库 →', 'GitHub 仓库 →|GitHub repository →|hero.repo'],
  ['76 KB · 解压即用', '76 KB · 解压即用|76 KB · unzip and load|chip.unzip'],
  ['仅 storage 权限', '仅 storage 权限|storage permission only|chip.perms'],
  ['Fail-Open 容错', 'Fail-Open 容错|Fail-open safety|chip.failopen'],
  ['MIT License', 'MIT License|MIT License|chip.mit'],
  ['扩展控制台：状态、过滤范围、规则与主题一目了然', '扩展控制台：状态、过滤范围、规则与主题一目了然|Console: status, scopes, rules and theme at a glance|shot.console'],
  ['X 时间线：违规帖被隐藏为占位符，可一键恢复', 'X 时间线：违规帖被隐藏为占位符，可一键恢复|X timeline: offending posts collapsed into restorable placeholders|shot.timeline'],
  ['设置中心：范围编排、规则阈值、成本防护', '设置中心：范围编排、规则阈值、成本防护|Settings: scope orchestration, rule thresholds, cost guards|shot.settings'],
  ['功能', '功能|Features|h2.features'],
  ['帖子 + 评论双通道', '帖子 + 评论双通道|Posts + replies, dual channel|f.dual.t'],
  ['详情页评论、详情页主帖、首页时间线（含书签/列表）、搜索结果、个人主页、探索页——六个范围独立开关，默认开启详情页评论与首页时间线，其余一键可开。', 'Detail replies, the detail root post, the home timeline (incl. bookmarks/lists), search results, profiles and explore — six independently toggleable scopes. Defaults: detail replies + home timeline; everything else is one toggle away.|f.dual.d'],
  ['视口懒检查', '视口懒检查|Viewport lazy check|f.lazy.t'],
  ['时间线帖子只在滚动到视口附近时才请求分类，快速划过的帖子零 API 成本；重复内容命中本地 LRU 缓存（默认 24h）。', 'Timeline posts are classified only as they approach the viewport — quickly scrolled posts cost zero API calls; repeats hit the local LRU cache (24h default).|f.lazy.d'],
  ['Fail-Open 容错', 'Fail-Open 容错|Fail-open safety|f.failopen.t'],
  ['API 失败、超时、达到每日配额时完整放行——不在不确定时隐藏任何内容。', 'On API failure, timeout or exhausted quota everything stays visible — nothing is hidden on uncertainty.|f.failopen.d'],
  ['本地优先', '本地优先|Local-first|f.local.t'],
  ['API Key 只存浏览器本地、仅由 service worker 读取；不申请 tabs / history / cookies / webRequest 权限。', 'The API key lives in local storage, read only by the service worker; no tabs / history / cookies / webRequest permissions are requested.|f.local.d'],
  ['规则完全可定制', '规则完全可定制|Fully customizable rules|f.rules.t'],
  ['内置色情/性暗示、引流/招揽、模板刷屏三条规则只是第一批；阈值可调（0.5–0.99），支持自定义自然语言规则并可限定"仅评论 / 仅帖子"——任何你想过滤的垃圾，一句话就是一条规则。', 'The built-in porn/innuendo, solicitation and template-flooding rules are just the first batch; thresholds are adjustable (0.5–0.99), custom natural-language rules are supported, and each rule can target replies only or posts only — any garbage you want gone is one sentence per rule.|f.rules.d'],
  ['深色 / 浅色 / 跟随系统', '深色 / 浅色 / 跟随系统|Dark / light / follow system|f.theme.t'],
  ['主题设置同步作用于扩展页面与 X 内的占位符、检查弹层、浮动窗；版本号与设置实时可见。', 'The theme setting applies to extension pages and the placeholders, check popovers and panel inside X; the version is always visible.|f.theme.d'],
  ['安装', '安装|Install|h2.install'],
  ['下载并解压', '下载并解压|Download & unzip|s1.t'],
  ['下载 <a href="https://github.com/bit-cook/Jev-X-Blocker/releases/download/v1.1.0/Jev-X-Blocker-v1.1.0.zip">Jev-X-Blocker-v1.1.0.zip</a>（约 76 KB），解压得到一个 <code>Jev-X-Blocker</code> 文件夹。', 'Download <a href="https://github.com/bit-cook/Jev-X-Blocker/releases/download/v1.1.0/Jev-X-Blocker-v1.1.0.zip">Jev-X-Blocker-v1.1.0.zip</a> (~76 KB) and unzip it into a <code>Jev-X-Blocker</code> folder.|s1.d'],
  ['打开扩展管理页', '打开扩展管理页|Open the extensions page|s2.t'],
  ['Chrome 地址栏输入 <code>chrome://extensions</code>，Edge 输入 <code>edge://extensions</code>，打开右上角的"开发者模式"。', 'Enter <code>chrome://extensions</code> in Chrome (or <code>edge://extensions</code> in Edge) and turn on Developer mode.|s2.d'],
  ['加载扩展', '加载扩展|Load the extension|s3.t'],
  ['点"加载已解压的扩展程序"，选择解压出的 <code>Jev-X-Blocker</code> 文件夹（manifest.json 就在根部）。', 'Click "Load unpacked" and select the unzipped <code>Jev-X-Blocker</code> folder (manifest.json sits at the root).|s3.d'],
  ['连接 TypeSafe', '连接 TypeSafe|Connect TypeSafe|s4.t'],
  ['首次安装自动打开引导页，填入你的 TypeSafe API Key 并测试连接。没有 Key 时插件保持放行，不会隐藏任何内容。', 'First install opens the onboarding automatically — paste your TypeSafe API key and test the connection. Without a key, everything stays visible.|s4.d'],
  ['地区提示：', '地区提示：|Regional notice:|notice.t'],
  ['TypeSafe API 目前对部分地区不可用（返回 HTTP 451）。所在地区无法访问时，插件会保持放行，不影响正常浏览。', 'The TypeSafe API is unavailable in some regions (HTTP 451). Where it is blocked, the extension keeps everything visible and browsing is unaffected.|notice.d'],
  ['隐私边界', '隐私边界|Privacy boundary|h2.privacy'],
  ['✓ 只发送文本', '✓ 只发送文本|✓ Only text is sent|p.send.t'],
  ['命中的用户名 + 帖子/评论正文，直接发给你自己配置的 TypeSafe API。', 'The matched author name + post/reply body, sent straight to the TypeSafe API you configure.|p.send.d'],
  ['✕ 不读取', '✕ 不读取|✕ Never reads|p.noread.t'],
  ['X Cookie、登录信息、浏览历史、图片、视频、头像。', 'X cookies, login state, browsing history, images, videos or avatars.|p.noread.d'],
  ['✕ 不经过第三方', '✕ 不经过第三方|✕ No third party|p.nothird.t'],
  ['没有后端服务器，插件开发者收不到任何数据；缓存只存哈希不存原文。', 'There is no backend — the developer receives nothing; the cache stores hashes, never raw text.|p.nothird.d'],
  ['✓ 一切可恢复', '✓ 一切可恢复|✓ Everything restorable|p.restore.t'],
  ['每条隐藏内容都可点击查看；可随时删除 Key 与全部本地数据。', 'Every hidden item can be viewed with a click; the key and all local data can be deleted anytime.|p.restore.d'],
];
let applied = 0;
for (const [zh, replacement] of pairs) {
  if (t.includes(zh)) {
    const [zhText, enText, key] = replacement.includes('|') ? splitLast(replacement) : [replacement, '', ''];
    t = t.split(zh).join(`data-i18n-key="${key}" data-i18n-zh="${zhText.replace(/"/g, '&quot;')}" data-i18n-en="${enText.replace(/"/g, '&quot;')}"`);
    applied += 1;
  }
}
function splitLast(s) {
  const i1 = s.indexOf('|');
  const i2 = s.indexOf('|', i1 + 1);
  return [s.slice(0, i1), s.slice(i1 + 1, i2), s.slice(i2 + 1)];
}
console.log(`tagged ${applied}/${pairs.length} strings`);

// 2. Language toggle script.
const script = `<script>
(function () {
  'use strict';
  const nodes = document.querySelectorAll('[data-i18n-key]');
  let lang = 'zh';
  const apply = () => {
    nodes.forEach((el) => {
      el.innerHTML = lang === 'en' ? el.dataset.i18nEn : el.dataset.i18nZh;
    });
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.getElementById('langToggle').textContent = lang === 'en' ? '中文' : 'EN';
  };
  document.getElementById('langToggle').addEventListener('click', () => { lang = lang === 'en' ? 'zh' : 'en'; apply(); });
  apply();
})();
</script>
</body>`;
t = t.replace('</body>', script);

writeFileSync(file, t);
console.log('site bilingual patch complete');
