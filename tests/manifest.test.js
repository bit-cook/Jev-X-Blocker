const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('manifest stays within the permission boundary and references shipped entrypoints', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.ok(manifest.host_permissions.includes('https://x.com/*'));
  assert.ok(manifest.host_permissions.includes('https://api.typesafe.ai/*'));
  for (const forbidden of ['tabs', 'history', 'cookies', 'webRequest', '<all_urls>']) {
    assert.equal(JSON.stringify(manifest).includes(forbidden), false, `forbidden permission ${forbidden}`);
  }
  const referenced = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts[0].js, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const file of referenced) assert.equal(fs.existsSync(path.join(root, file)), true, file);
  // Content scripts load in dependency order: core -> adapter -> pipeline -> overlay -> main.
  assert.deepEqual(manifest.content_scripts[0].js, [
    'src/shared/core.js',
    'src/content/adapter.js',
    'src/content/pipeline.js',
    'src/content/overlay.js',
    'src/content/main.js'
  ]);
  for (const resource of manifest.web_accessible_resources.flatMap((entry) => entry.resources)) assert.equal(fs.existsSync(path.join(root, resource)), true, resource);
});

test('extension pages do not load remote scripts or remote fonts', () => {
  for (const file of ['src/popup.html', 'src/settings.html', 'src/onboarding.html']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(/<(script|link)[^>]+https?:\/\//i.test(source), false, file);
  }
});

test('public privacy policy documents the TypeSafe data flow and user controls', () => {
  const privacy = fs.readFileSync(path.join(root, 'privacy.html'), 'utf8');
  assert.match(privacy, /TypeSafe/);
  assert.match(privacy, /帖子与评论/);
  assert.match(privacy, /API Key/);
  assert.match(privacy, /GitHub Issues/);
});

test('content modules never read storage secrets or call TypeSafe directly', () => {
  for (const file of ['src/content/adapter.js', 'src/content/pipeline.js', 'src/content/overlay.js', 'src/content/main.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(source.includes('chrome.storage'), false, file);
    assert.equal(source.includes('typesafeApiKey'), false, file);
    assert.equal(source.includes('fetch('), false, file);
  }
});

test('service worker resolves its shared dependency relative to src/', () => {
  const source = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8');
  assert.match(source, /importScripts\(['"]shared\/core\.js['"]\)/);
  assert.equal(source.includes("importScripts('src/shared/core.js')"), false);
});

test('X-injected CSS is scoped to extension placeholder classes', () => {
  const css = fs.readFileSync(path.join(root, 'src/styles/content.css'), 'utf8');
  assert.equal(/(^|[,{\s])(?:html|body|\*)\s*[{,]/m.test(css), false);
  assert.match(css, /\.jxb-placeholder/);
  assert.match(css, /\.jxb-check-host \{[\s\S]*width: 54px;/);
  assert.match(css, /\.jxb-check-popover \{[\s\S]*left: 54px;/);
  assert.match(css, /\.jxb-monitor/);
  assert.match(css, /\.jxb-monitor-scopes/);
  assert.equal(css.includes('elon-work'), false);
});

test('content pipeline supports kinds, batched reporting and reveal', () => {
  const source = fs.readFileSync(path.join(root, 'src/content/pipeline.js'), 'utf8');
  assert.match(source, /CLASSIFY_TARGET/);
  assert.match(source, /kind/);
  assert.match(source, /postsHidden/);
  assert.match(source, /revealTarget/);
  assert.match(source, /memoizedHash/);
  const main = fs.readFileSync(path.join(root, 'src/content/main.js'), 'utf8');
  assert.match(main, /IntersectionObserver/);
  assert.match(main, /watchWithIO/);
  assert.match(main, /invalidatePageContext/);
});

test('popup and onboarding put first-time API setup first with the TypeSafe key prefix', () => {
  const popup = fs.readFileSync(path.join(root, 'src/popup.html'), 'utf8');
  assert.ok(popup.indexOf('id="connectPanel"') < popup.indexOf('id="statusTitle"'));
  assert.match(popup, /placeholder="apikey_…"/);
  assert.match(popup, /href="https:\/\/typesafe\.ai\//);
  assert.match(popup, /id="hiddenBreakdown"/);
  // The console page shares the settings chrome and hosts the theme switch.
  assert.match(popup, /jxb-page-header/);
  assert.match(popup, /jxb-page-footer/);
  assert.match(popup, /id="themeSeg"/);
  assert.match(popup, /data-theme-value="light"/);
  const onboarding = fs.readFileSync(path.join(root, 'src/onboarding.html'), 'utf8');
  assert.match(onboarding, /placeholder="apikey_…"/);
  assert.match(onboarding, /href="https:\/\/typesafe\.ai\//);
  assert.match(onboarding, /id="onboardingScopes"/);
});

test('settings expose every post/comment scope toggle plus the rule applyTo editor', () => {
  const settings = fs.readFileSync(path.join(root, 'src/settings.html'), 'utf8');
  for (const id of ['detailRepliesToggle', 'detailRootToggle', 'timelineToggle', 'searchToggle', 'profileToggle', 'exploreToggle', 'lazyScanToggle', 'monitorToggle', 'themeSeg', 'applyComments', 'applyPosts']) {
    assert.match(settings, new RegExp(`id="${id}"`), id);
  }
  assert.match(fs.readFileSync(path.join(root, 'src/content/overlay.js'), 'utf8'), /jxb-monitor-hide/);
  assert.match(fs.readFileSync(path.join(root, 'src/styles/content.css'), 'utf8'), /jxb-monitor-actions/);
  assert.match(fs.readFileSync(path.join(root, 'src/styles/content.css'), 'utf8'), /html\[data-jxb-theme='light'\] \.jxb-placeholder/);
  assert.match(settings, /href="https:\/\/typesafe\.ai\//);
  // Console nav link carries the standalone flag the popup uses.
  assert.match(settings, /popup\.html\?view=console/);
  const script = fs.readFileSync(path.join(root, 'src/settings.js'), 'utf8');
  assert.match(script, /scopes/);
  assert.match(script, /applyTo/);
  assert.match(script, /applyTheme/);
});
