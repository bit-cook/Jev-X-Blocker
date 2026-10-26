const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/shared/core.js');
require('../src/content/adapter.js');
const adapter = globalThis.JevXBlocker.adapter;

function fakeArticle({ href = '/someone/status/123', text = '普通内容', user = 'Alice @alice' } = {}) {
  return {
    querySelector(selector) {
      if (selector.includes('/status/')) return { getAttribute: () => href };
      if (selector.includes('tweetText')) return { textContent: text };
      if (selector.includes('User-Name')) return { textContent: user };
      return null;
    }
  };
}

test('detail page splits the root tweet (post) from replies (comment)', () => {
  const detail = 'https://x.com/elonmusk/status/123456789';
  const context = adapter.pageContext(detail);
  assert.equal(context.type, 'detail');
  assert.equal(context.rootTweetId, '123456789');

  const root = adapter.extractTarget(fakeArticle({ href: '/elonmusk/status/123456789' }), context);
  assert.equal(root.kind, 'post');
  assert.equal(root.scope, 'detailRoot');

  const reply = adapter.extractTarget(fakeArticle({ href: '/someone/status/999' }), context);
  assert.equal(reply.kind, 'comment');
  assert.equal(reply.scope, 'detailReplies');
  assert.equal(reply.tweetId, '999');
});

test('timeline articles become post targets on every feed surface', () => {
  for (const [url, scope] of [
    ['https://x.com/home', 'timeline'],
    ['https://x.com/search?q=x', 'search'],
    ['https://x.com/explore', 'explore'],
    ['https://x.com/elonmusk', 'profile'],
    ['https://x.com/i/bookmarks', 'timeline']
  ]) {
    const context = adapter.pageContext(url);
    const target = adapter.extractTarget(fakeArticle(), context);
    assert.equal(target.kind, 'post', url);
    assert.equal(target.scope, scope, url);
  }
});

test('unsupported pages produce no scope and pageInScope rejects them', () => {
  const config = E.createDefaultConfig();
  for (const url of ['https://x.com/messages', 'https://x.com/notifications', 'https://x.com/compose/post']) {
    const context = adapter.pageContext(url);
    assert.equal(context.scope, null, url);
    assert.equal(adapter.extractTarget(fakeArticle(), context), null, url);
    assert.equal(adapter.pageInScope(config, context), false, url);
  }
});

test('scope toggles gate targetAllow and pageInScope per surface', () => {
  const off = E.normalizeConfig({ scopes: { timeline: false, detailRoot: false, explore: true } });
  const timelineContext = adapter.pageContext('https://x.com/home');
  assert.equal(adapter.pageInScope(off, timelineContext), false);
  assert.equal(adapter.targetAllowed(off, adapter.extractTarget(fakeArticle(), timelineContext)), false);

  const exploreContext = adapter.pageContext('https://x.com/explore');
  assert.equal(adapter.pageInScope(off, exploreContext), true);
  assert.equal(adapter.targetAllowed(off, adapter.extractTarget(fakeArticle(), exploreContext)), true);

  const detailContext = adapter.pageContext('https://x.com/elonmusk/status/1');
  // Replies still on, root off: page stays in scope but the root post is not allowed.
  assert.equal(adapter.pageInScope(off, detailContext), true);
  assert.equal(adapter.targetAllowed(off, adapter.extractTarget(fakeArticle({ href: '/elonmusk/status/1' }), detailContext)), false);
  assert.equal(adapter.targetAllowed(off, adapter.extractTarget(fakeArticle({ href: '/x/status/2' }), detailContext)), true);
});

test('articles without text or tweet id are ignored', () => {
  const context = adapter.pageContext('https://x.com/home');
  assert.equal(adapter.extractTarget(fakeArticle({ text: '' }), context), null);
  assert.equal(adapter.extractTarget(fakeArticle({ href: '/profile' }), context), null);
  assert.equal(adapter.extractTarget(null, context), null);
});

test('invisible character counts propagate into the target for spam signals', () => {
  const context = adapter.pageContext('https://x.com/home');
  const target = adapter.extractTarget(fakeArticle({ text: '\u200b我\u200c骚😟比\u200d我' }), context);
  assert.ok(target.invisibleCharCount >= 3);
});
