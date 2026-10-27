# Jev X Blocker

> **More Signal, Less Noise, Better Living.**

[English](README.en.md) | 中文

A local-first Chrome Manifest V3 extension: powered by the [TypeSafe Jev](https://typesafe.ai/) judgment model, it filters garbage and noise harassment on X (`x.com`) at the semantic level — **judgment models, not keyword matching** — more accurate, more intelligent; filter rules can be written in plain language; and it is fast to the point of being invisible. Covers both posts and replies; matched content shows a restorable hidden placeholder.

## Why this exists

The X reply section is a cesspool and we are all panning for gold in it. The goal of this extension is simple: **filter out every piece of garbage and noise harassment you want gone, and spare your brain the pain of panning through the sewer.**

- **Judgment models, not keywords** — every rule is scored by Jev with a calibrated probability; your browser decides whether to hide. It understands slang like “小马开大车” and emoji veiling instead of matching word lists;
- **Rules in plain language** — "hide replies promoting crypto" is a complete rule in one sentence; true/false rubrics can be customized in depth;
- **Invisible speed** — timeline posts are classified only as they approach the viewport, repeated content hits a local cache, and API failures fail open (everything stays visible);
- **Everything is restorable** — hidden ≠ deleted; every hidden post and reply can be viewed in place.

> It is simple for now, but good enough — it will keep improving. Roadmap: more judgment models, more rule packs (noise, harassment, scams, AI slop…), per-language filtering.

This project is a refactor and extension of [elons-job](https://github.com/bugkiwi/elons-job): the original only handled replies on post detail pages; Jev X Blocker extends the same rule engine to posts themselves (timeline, search, profiles, the detail root post) with major performance and architecture work.

[Website](https://osome.work/Jev-X-Blocker/) · [Privacy policy](privacy.html) · [MIT License](LICENSE)

## Install (recommended)

No build needed — grab the packaged zip and load it:

1. Open the [Releases page](https://github.com/bit-cook/Jev-X-Blocker/releases) and download the latest `Jev-X-Blocker-v*.zip`;
2. Unzip it into a `Jev-X-Blocker` folder (`manifest.json` sits at the folder root);
3. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge) and turn on **Developer mode**;
4. Click **Load unpacked** and select the unzipped `Jev-X-Blocker` folder.

First install opens the onboarding page automatically — paste your own TypeSafe API key. Without a key, everything stays visible; nothing gets hidden.

> The TypeSafe API is unavailable in some regions (HTTP 451). Where it is blocked, the extension keeps everything visible and browsing is unaffected.

Current release: [v1.1.0](https://github.com/bit-cook/Jev-X-Blocker/releases/tag/v1.1.0) ([direct ZIP download](https://github.com/bit-cook/Jev-X-Blocker/releases/download/v1.1.0/Jev-X-Blocker-v1.1.0.zip), ~76 KB)

The interface is bilingual: Chinese and English follow your browser language automatically, and can be switched in Settings → General → Interface language (it also applies to the overlays inside X).

## Build from source

Requires Node.js 20 or newer.

```bash
npm test       # full test suite (deterministic mocks, zero API cost)
npm run check  # syntax-check every entry point
npm run build  # produce the dist/ directory
npm run benchmark -- --limit=6   # optional: real-API smoke sample
```

After building, open `chrome://extensions`, enable "Developer mode", click "Load unpacked" and select the `dist/` directory. First install opens the onboarding automatically; if elons-job was installed before, the API key, custom rules and cumulative stats migrate over.

For packaging: `node scripts/package-release.mjs` produces `release/Jev-X-Blocker-v<version>.zip`.

## Usage

1. Enter your TypeSafe API key in onboarding (get one at [typesafe.ai](https://typesafe.ai/)) and test the connection;
2. Confirm the default rules and scopes (defaults: detail replies + home timeline; everything else is one toggle away);
3. Open X: matched posts and replies are replaced with placeholders — click "View post / View reply" to restore;
4. The hover check button is off by default (Settings → Display & interaction); when enabled, hovering any post or reply shows a "Check" button with per-rule probabilities and a forced recheck.

### Scopes & cost

- Timeline posts use the **viewport lazy check** by default: classification is requested only as a post approaches the viewport (700px buffer); quickly scrolled posts cost zero API calls;
- Repeated content hits the local cache (session storage + in-worker LRU, 24h TTL by default);
- The daily request cap defaults to 100,000 — filtering stops and content stays visible once reached.

## Safety boundary

- The API key is read only by the service worker and stored in `chrome.storage.local`; popups and settings pages only talk through the message protocol — content scripts never touch it;
- The content script only sends `{ tweetId, text, kind }` to the service worker, where `text` merges the author name and body; it never reads cookies, history or X login state;
- TypeSafe requests go to `https://api.typesafe.ai/v1/systemone`; on any API error, timeout, 401, 429 or 5xx the extension **fails open** (keeps content visible);
- The cache key uses only the content hash + rule fingerprint + model — raw text is never stored;
- `manifest.json` requests no `tabs`, `history`, `cookies`, `webRequest` or `<all_urls>`.

## Architecture

```text
src/
├── shared/core.js        # pure logic: config/rules/decision engine/page
│                         #   classification/migration (node-testable)
├── shared/i18n.js        # bilingual dictionary + resolver (zh/en)
├── background.js         # service worker: TypeSafe client, concurrency queue,
│                         #   LRU cache, quota gate, batched stats, migration
├── content/
│   ├── adapter.js        # X DOM adapter: selectors, URL→page context,
│   │                     #   post/reply extraction
│   ├── pipeline.js       # orchestration: dedupe, hash memoization, page
│   │                     #   status machine, batched reporting
│   ├── overlay.js        # placeholders / check controls / monitor UI
│   └── main.js           # MutationObserver + IntersectionObserver + routing
├── popup / settings / onboarding
└── styles/               # app.css (extension pages) + content.css (injected)
```

Data flow: `X DOM → adapter → pipeline (dedupe/cache identity) → service worker → TypeSafe Jev → probabilities → local rule engine → hide/restore`. The model only returns probabilities; the hide decision is made locally (template-spam, emoji-obfuscation and combined-risk signals included).

## Tests & corpus

`tests/` covers: defaults and the dual-channel applyTo, rule compilation, text normalization, page classification (9 X routes), post/reply extraction and scope gating, SHA-256 cache keys (incl. the applyTo split), threshold decisions, API response parsing, background integration (concurrency cap, cache hits, quota, fail-open, elons-job migration, per-kind stats), manifest permission boundaries and static security checks, plus i18n dictionary parity.

The corpus at `tests/fixtures/corpus.json` holds 73 reply samples and 16 timeline post samples (normal content, medical/education, veiled innuendo, solicitation, emoji spam, invisible-character pollution). With `TYPESAFE_API_KEY` in `.env`:

```bash
npm run benchmark -- --kind=all            # everything
npm run benchmark -- --kind=post           # post corpus only
npm run benchmark -- --id=hide-004         # single-sample detail
npm run benchmark -- --limit=10 --json     # machine-readable output
```

The script reports Precision / Recall / F1 / FP rate / latency and sample IDs only — never the API key.

## Real-browser e2e

`test-browser/` ships a real-browser verification harness (works even when x.com / TypeSafe are unreachable from the network):

```bash
node scripts/build.mjs                  # produce dist/
node test-browser/make-dist-test.mjs    # dist-test adds a 127.0.0.1 match
node test-browser/mock-server.mjs       # local mock X page + mock TypeSafe API (CORS)
# load dist-test in Edge/Chrome with --remote-debugging-port=9223, open http://127.0.0.1:8788/home
node test-browser/run-e2e.mjs           # 19 CDP assertions + screenshot
```

Assertions cover: install opens onboarding → 2 of 3 timeline posts hidden (with confidence placeholders) → restore reveals in place → SPA navigation to a detail page hides the root post (detailRoot) and the violating reply with distinct copy → forced rechecks against a dead endpoint keep everything visible (fail-open) → a live endpoint re-hides.

Note: the lazy viewport check relies on IntersectionObserver — the browser window/tab must be visible (background tabs suspend rendering and classify nothing; that is a cost-saving design behavior).

## Acknowledgements

Built on [bugkiwi/elons-job](https://github.com/bugkiwi/elons-job) (MIT); the rule prompts and the local signal decision engine carry over its corpus-validated design.
