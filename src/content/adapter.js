(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // X DOM adapter. Every X selector lives here; the rest of the content
  // pipeline only consumes { tweetId, text, author, kind, scope } targets.
  //
  // Target kinds:
  //   comment — detail page replies (elons-job behaviour)
  //   post    — timeline / search / explore / profile posts AND the root
  //             tweet on detail pages (the new blocking surface)
  // ---------------------------------------------------------------------------

  const core = root.JevXBlocker;

  const SELECTORS = {
    tweet: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    tweetLink: 'a[href*="/status/"]'
  };

  // Cached page context. X is a SPA: main.js bumps routeVersion whenever the
  // URL changes and calls invalidatePageContext() from the same tick, so the
  // cache can never leak a stale rootTweetId into a new page.
  let cachedUrl = '';
  let cachedContext = null;
  let routeVersion = 0;

  function invalidatePageContext() {
    cachedUrl = '';
    cachedContext = null;
    routeVersion += 1;
  }

  function pageContext(url) {
    const href = String(url || (root.location && root.location.href) || '');
    if (!cachedContext || href !== cachedUrl) {
      const classified = core.classifyPage(href);
      const scope = core.SCOPE_BY_TYPE[classified.type] || null;
      cachedUrl = href;
      cachedContext = {
        url: href,
        type: classified.type,
        rootTweetId: classified.rootTweetId,
        scope,
        routeVersion
      };
    }
    return cachedContext;
  }

  function tweetIdFromArticle(article) {
    if (!article || !article.querySelector) return null;
    const link = article.querySelector(SELECTORS.tweetLink);
    const match = link && String(link.getAttribute('href') || '').match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function extractTarget(article, pageInfo) {
    if (!article || !article.querySelector) return null;
    const context = pageInfo || pageContext();
    const tweetId = tweetIdFromArticle(article);
    if (!tweetId) return null;
    const textNode = article.querySelector(SELECTORS.tweetText);
    const rawText = textNode ? String(textNode.textContent || '') : '';
    const text = core.normalizeText(rawText);
    if (!text) return null;
    const userNode = article.querySelector(SELECTORS.userName);
    const rawAuthor = userNode ? String(userNode.textContent || '') : '';
    const author = core.normalizeText(rawAuthor);
    let kind;
    let scope;
    if (context.type === core.PAGE_TYPES.DETAIL) {
      const isRoot = tweetId === context.rootTweetId;
      kind = isRoot ? 'post' : 'comment';
      scope = isRoot ? 'detailRoot' : 'detailReplies';
    } else {
      kind = 'post';
      scope = context.scope;
    }
    if (!scope) return null;
    const dirtyCount = core.invisibleCharCount(rawText) + core.invisibleCharCount(rawAuthor);
    const target = { tweetId, text, author, kind, scope };
    if (dirtyCount) target.invisibleCharCount = dirtyCount;
    return target;
  }

  // True when the page itself is worth scanning at all. Cheap pre-gate that
  // keeps the MutationObserver idle on messages/settings/unknown routes.
  function pageInScope(config, pageInfo) {
    const context = pageInfo || pageContext();
    if (!context.scope) return false;
    if (context.type === core.PAGE_TYPES.DETAIL) {
      return core.scopeActive(config, 'detailReplies') || core.scopeActive(config, 'detailRoot');
    }
    return core.scopeActive(config, context.scope);
  }

  function targetAllowed(config, target) {
    if (!target || !config) return false;
    if (config.enabled === false) return false;
    return core.scopeActive(config, target.scope);
  }

  root.JevXBlocker = Object.assign(root.JevXBlocker || {}, {
    adapter: {
      SELECTORS,
      pageContext,
      invalidatePageContext,
      tweetIdFromArticle,
      extractTarget,
      pageInScope,
      targetAllowed
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
