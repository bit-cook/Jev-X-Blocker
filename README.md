# Jev X Blocker

> **More Signal, Less Noise, Better Living.**

一个本地优先的 Chrome Manifest V3 扩展：基于 [TypeSafe Jev](https://typesafe.ai/) 判断模型，对 X (`x.com`) 上的垃圾信息与噪声骚扰做语义级过滤——**用判断模型分析，而不是关键词匹配**，更准确、更智能；过滤规则可以用大白话定义；速度快到几乎无感。帖子和评论区同时覆盖，命中内容显示可恢复的隐藏占位符。

## 为什么做这个

X 的评论区是个粪坑，我们都在里面淘金。这个扩展的目标很简单：**过滤一切想要过滤掉的垃圾信息和噪声骚扰，减少人脑粪坑淘金的痛苦。**

- **判断模型，不是关键词** — 每条规则由 Jev 返回校准过的概率，本地决定是否隐藏。它理解"小马开大车"式的黑话和 emoji 暗语，而不是死磕词表；
- **大白话定义规则** — "隐藏推广加密货币的评论"，一句话就是一条规则，true/false 评分细则还能深度定制；
- **快到无感** — 时间线帖子滚动到视口附近才分类，重复内容命中本地缓存，API 异常自动放行（Fail-Open），不卡滚动、不错杀；
- **一切可恢复** — 隐藏 ≠ 删除，每条被隐藏的帖子和评论都能原地查看。

> 现在还比较简单，但是够用，以后再逐渐完善。路线图：接入更多判断模型；扩展规则包覆盖更多场景（噪声、骚扰、诈骗、AI 水军……）；按语言分治过滤。

本项目是 [elons-job](https://github.com/bugkiwi/elons-job) 的重构与强化版：原版只能处理帖子详情页的评论，Jev X Blocker 把同一套规则引擎扩展到了帖子本身（时间线、搜索、个人主页、详情页主帖），并做了大规模的性能与架构优化。

[官网](https://osome.work/Jev-X-Blocker/) · [隐私政策](privacy.html) · [MIT License](LICENSE)

## 下载安装（推荐）

不想编译？直接下构建好的包，解压后加载即可：

1. 打开 [Releases 发布页](https://github.com/bit-cook/Jev-X-Blocker/releases)，下载最新版本的 `Jev-X-Blocker-v*.zip`；
2. 解压，得到一个 `Jev-X-Blocker` 文件夹（`manifest.json` 就在文件夹根部）；
3. 浏览器地址栏输入 `chrome://extensions`（Edge 用 `edge://extensions`），打开右上角的**开发者模式**；
4. 点**加载已解压的扩展程序**，选择刚才解压出的 `Jev-X-Blocker` 文件夹。

首次安装会自动打开引导页，填入你自己的 TypeSafe API Key 即可。没有 Key 时插件保持放行，不会隐藏任何内容。

> TypeSafe API 目前对部分地区不可用（返回 HTTP 451）。所在地区无法访问时，插件会保持放行，不影响正常浏览。

当前最新版本：[v1.0.2](https://github.com/bit-cook/Jev-X-Blocker/releases/tag/v1.0.2)（[直接下载 ZIP](https://github.com/bit-cook/Jev-X-Blocker/releases/download/v1.0.2/Jev-X-Blocker-v1.0.2.zip)，约 69 KB）

## 从源码构建

环境要求：Node.js 20 或更高版本。

```bash
npm test       # 全量测试（确定性 mock，不产生 API 成本）
npm run check  # 语法检查所有入口
npm run build  # 产出 dist/ 目录
npm run benchmark -- --limit=6   # 可选：真实 API 小样本冒烟
```

构建完成后打开 `chrome://extensions`，开启"开发者模式"，"加载已解压的扩展程序"，选择 `dist/` 目录。首次安装会自动打开 onboarding；如果本机装过 elons-job，API Key、自定义规则和累计统计会自动迁移过来。

打包发布用：`node scripts/package-release.mjs` 生成 `release/Jev-X-Blocker-v<version>.zip`。

## 使用

1. 在 onboarding 输入 TypeSafe API Key（[typesafe.ai](https://typesafe.ai/) 获取）并测试连接；
2. 确认默认规则与过滤范围（默认只开启**详情页评论**与**首页时间线**，其余范围按需打开）；
3. 打开 X：命中的帖子和评论会被替换为占位符，点击"查看帖子 / 查看评论"可恢复；
4. 悬停检查按钮默认关闭（设置 → 显示与交互可打开）；打开后悬停任意帖子和评论会出现"检查"按钮，可查看每条规则的概率或强制重查。

### 过滤范围与成本

- 时间线帖子默认启用**视口懒检查**：只有滚动到视口附近（700px 缓冲）的帖子才请求分类，快速划过的帖子不产生 API 调用；
- 相同内容（规则指纹一致）命中本地缓存（session 存储 + worker 内存 LRU，TTL 默认 24h）；
- 每日请求上限默认 100,000，达到后停止 AI 过滤并保持内容显示。

## 安全边界

- API Key 只由 service worker 读取，存于 `chrome.storage.local`；popup、设置页只通过消息协议保存/测试；content script 完全接触不到 Key。
- content script 只向 service worker 发送 `{ tweetId, text, kind }`，其中 `text` 合并了用户名与正文；不读取 cookie、history、X 登录信息。
- TypeSafe 请求使用 `https://api.typesafe.ai/v1/systemone`；API 异常、超时、401、429 或 5xx 时 **Fail Open**（保持显示）。
- 缓存 key 只使用内容哈希 + 规则 fingerprint + 模型版本，不保存原文。
- `manifest.json` 未申请 `tabs`、`history`、`cookies`、`webRequest` 或 `<all_urls>`。

## 架构

```text
src/
├── shared/core.js        # 纯逻辑：配置/规则/决策引擎/页面分类/迁移（node 可测）
├── background.js         # service worker：TypeSafe 客户端、并发队列、LRU 缓存、
|                         #   配额门控、批量统计、elons-job 迁移
├── content/
│   ├── adapter.js        # X DOM 适配：selector 集中、URL→页面上下文、帖子/评论提取
│   ├── pipeline.js       # 分类编排：身份去重、hash 记忆化、页面状态、批量上报
│   ├── overlay.js        # 占位符 / 检查控件 / 监视器 UI（jxb-* 命名空间）
│   └── main.js           # MutationObserver + IntersectionObserver + 路由跟踪
├── popup / settings / onboarding
└── styles/               # app.css（扩展页）+ content.css（注入 X 的样式）
```

数据流：`X DOM → adapter → pipeline（去重/缓存身份）→ service worker → TypeSafe Jev → 概率 → 本地规则引擎 → 隐藏/放行`。模型只返回概率，隐藏决策完全在本地（含模板 spam、emoji 混淆、综合风险等多路信号）。

## 测试与语料

`tests/` 覆盖：默认规则与双通道 applyTo、规则编译、文本 normalize、页面分类（9 类 X 路由）、帖子/评论提取与范围门控、SHA-256 cache key（含 applyTo 分裂）、阈值决策、API 响应解析、后台集成（并发上限、缓存命中、配额、Fail-Open、elons-job 迁移、分类别统计）、manifest 权限边界与静态安全检查。

语料库 `tests/fixtures/corpus.json` 包含 73 条评论样本与 16 条时间线帖子样本（正常内容、医学/教育、隐晦性暗示、引流、emoji spam、不可见字符污染、帖子场景）。配置 `.env` 中的 `TYPESAFE_API_KEY` 后：

```bash
npm run benchmark -- --kind=all            # 全量
npm run benchmark -- --kind=post           # 只测帖子语料
npm run benchmark -- --id=post-hide-004    # 单条详细评估
npm run benchmark -- --limit=10 --json     # 机器可读输出
```

脚本只输出 Precision / Recall / F1 / FP rate / 延迟与样本 ID，绝不输出 API Key。

## 真实浏览器端到端测试

`test-browser/` 提供一套真实浏览器验证工具（当 x.com / TypeSafe 在当前网络不可达时仍可完整验证）：

```bash
node scripts/build.mjs                  # 先产出 dist/
node test-browser/make-dist-test.mjs    # 生成 dist-test（manifest 追加 127.0.0.1 匹配）
node test-browser/mock-server.mjs       # 本地 mock X 页面 + mock TypeSafe API（带 CORS）
# 用 Edge/Chrome 加载 dist-test 并开 --remote-debugging-port=9223 打开 http://127.0.0.1:8788/home
node test-browser/run-e2e.mjs           # 15 项 CDP 断言 + 截图
```

断言覆盖：安装自动打开 onboarding → 时间线 3 帖中 2 篇违规帖被隐藏（含置信度占位符）→ 恢复按钮就地还原 → SPA 切换到详情页后主帖（detailRoot）与违规评论分别隐藏且文案区分帖子/评论 → API 端点失效时强制重查全部放行（Fail-Open）→ 端点恢复后重新隐藏。

注意：帖子懒检查依赖 IntersectionObserver，浏览器窗口/标签页必须可见（后台标签不渲染、不分类——这是省 API 成本的设计行为）。

## 致谢

基于 [bugkiwi/elons-job](https://github.com/bugkiwi/elons-job)（MIT）重构，规则提示词与本地信号决策引擎沿用了其经过语料验证的设计。
