// Creates a GitHub release and uploads the built ZIP.
//   GH_TOKEN=... node test-browser/publish-release.mjs [--tag=v1.1.0]
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GH_TOKEN;
const OWNER = 'bit-cook';
const REPO = 'Jev-X-Blocker';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

if (!TOKEN) { console.error('missing GH_TOKEN'); process.exit(1); }

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dist/manifest.json'), 'utf8'));
const tag = arg('tag', `v${manifest.version}`);
const zipPath = resolve(ROOT, `release/Jev-X-Blocker-${tag}.zip`);
const size = statSync(zipPath).size;

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'jev-x-blocker-release',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28'
};

const BODY = `## Jev X Blocker ${tag}

本地优先的 Chrome / Edge（Manifest V3）扩展：用你自己的 TypeSafe Jev API Key，对 X 上高置信度的**色情、性暗示与引流内容**显示可恢复的隐藏占位符——**帖子和评论都能屏蔽**。

### 安装（解压后加载即可）

1. 下载下方的 \`Jev-X-Blocker-${tag}.zip\` 并解压，得到一个 \`Jev-X-Blocker\` 文件夹；
2. 浏览器地址栏输入 \`chrome://extensions\`（Edge 用 \`edge://extensions\`）；
3. 打开右上角的**开发者模式**；
4. 点**加载已解压的扩展程序**，选择刚才解压出的 \`Jev-X-Blocker\` 文件夹；
5. 首次安装会自动打开引导页，填入你的 TypeSafe API Key 即可（没有 Key 时插件保持放行，不会隐藏任何内容）。

### 使用

- 打开 X 的时间线或任意帖子详情页，命中的帖子和评论会被替换为占位符，点"查看帖子 / 查看评论"可原地恢复；
- 悬停任意帖子或评论会出现"检查"按钮，可查看每条规则的概率或强制重查；
- 过滤范围、规则阈值、外观主题都在设置中心调整。

### 功能要点

- **双通道过滤**：详情页评论、详情页主帖、首页时间线、搜索结果、个人主页、探索页（默认关闭）均可单独开关；
- **视口懒检查**：时间线帖子只有滚动到视口附近才请求分类，快速划过的帖子零 API 成本；
- **Fail-Open**：API 失败、超时或达到每日配额时完整放行，不在不确定时隐藏；
- **本地优先**：API Key 只存在浏览器本地，仅由 service worker 读取，不经过任何第三方服务器；不申请 \`tabs\` / \`history\` / \`cookies\` / \`webRequest\` 权限。

### 注意事项

- 文本判断由 TypeSafe Jev API 完成，该服务目前对部分地区不可用（返回 HTTP 451）。所在地区无法访问时，插件会保持放行，不影响浏览。
- 从源码构建：\`node scripts/build.mjs\`（需要 Node.js 20+），测试 \`node --test\`。

### 校验

- ZIP 内含 19 个文件（manifest.json 位于文件夹根部），约 ${(size / 1024).toFixed(0)} KB；
- 源码与标签 \`${tag}\` 一致，MIT 许可。`;

async function api(url, method = 'GET', body, headers = {}) {
  // Buffers are binary payloads (asset uploads); everything else is JSON.
  const payload = body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const response = await fetch(url, { method, headers: { ...H, ...headers }, body: payload });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

// Reuse an existing release for this tag if we already published one.
const existing = await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`).catch(() => null);
const release = existing || await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, 'POST', {
  tag_name: tag,
  name: `Jev X Blocker ${tag}`,
  body: BODY,
  target_commitish: 'main',
  draft: false,
  prerelease: false
});
console.log(`release ${release.tag_name} (${existing ? '已存在，复用' : '已创建'}) id=${release.id}`);

const assetName = basename(zipPath);
const already = (release.assets || []).find((a) => a.name === assetName);
if (already) {
  await api(already.url, 'DELETE');
  console.log(`删除旧附件 ${assetName}`);
}

const uploadUrl = release.upload_url.replace(/\{.*$/, '');
const buffer = readFileSync(zipPath);
const uploaded = await api(`${uploadUrl}?name=${encodeURIComponent(assetName)}`, 'POST', buffer, {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/zip',
  Accept: 'application/vnd.github+json',
  'User-Agent': 'jev-x-blocker-release'
});
console.log(`附件已上传: ${uploaded.name} | ${(uploaded.size / 1024).toFixed(1)} KB | state=${uploaded.state}`);
console.log(`下载地址: ${uploaded.browser_download_url}`);
console.log(`发布页: ${release.html_url}`);

// Round-trip check: download the published asset and confirm it is the same
// bytes we uploaded (guards against transport/encoding mistakes).
const downloaded = await fetch(uploaded.browser_download_url, { headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'jev-x-blocker-release' } });
const remote = Buffer.from(await downloaded.arrayBuffer());
const local = readFileSync(zipPath);
const isZip = remote.length >= 4 && remote[0] === 0x50 && remote[1] === 0x4B && remote[2] === 0x03 && remote[3] === 0x04;
console.log(`\n回读校验: 远端 ${remote.length} 字节 / 本地 ${local.length} 字节 | ZIP 签名: ${isZip ? 'OK' : 'FAIL'} | 字节一致: ${remote.equals(local) ? 'OK' : 'FAIL'}`);
if (!isZip || !remote.equals(local)) process.exitCode = 1;
