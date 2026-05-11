const cdp = require('./cdp-manager');

let cancelFlag = false;

function cancel() {
  cancelFlag = true;
}

async function scrapeComments(url, onProgress) {
  cancelFlag = false;

  // 1. Find or create a page target
  const targets = await cdp.getPageTargets();
  if (targets.length === 0) {
    const { sessionId } = await cdp.openNewTab('about:blank');
    return scrapeWithSession(sessionId, url, onProgress);
  }

  // Use existing page
  const sessionId = await cdp.attachToTarget(targets[0].targetId);
  return scrapeWithSession(sessionId, url, onProgress);
}

async function scrapeWithSession(sessionId, url, onProgress) {
  const settings = require('./database').getAllSettings();
  const maxScroll = parseInt(settings.max_scroll) || 50;
  const scrollDelay = parseInt(settings.scroll_delay) || 500;

  try {
    // Navigate and wait
    await cdp.navigatePage(sessionId, url);
    await sleep(3000); // Initial load
    await cdp.waitForPageLoad(sessionId, 20000);

    if (cancelFlag) return { comments: [], url };

    // Check if we're on a login wall
    const isLoggedIn = await cdp.evaluate(sessionId,
      '!!document.querySelector(\'article[data-testid="tweet"]\') || !!document.querySelector(\'[data-testid="tweetText"]\')'
    );
    if (!isLoggedIn) {
      const hasLogin = await cdp.evaluate(sessionId,
        'document.body.innerText.includes("Sign in") || document.body.innerText.includes("Log in")'
      );
      if (hasLogin) throw new Error('X requires login. Please log in to X in Chrome first.');
    }

    // Scroll and collect
    const comments = [];
    const seenTexts = new Set();

    for (let i = 0; i < maxScroll; i++) {
      if (cancelFlag) break;

      // Extract comments currently visible
      const batch = await cdp.evaluate(sessionId, `
        (function() {
          const results = [];
          const articles = document.querySelectorAll('article[data-testid="tweet"]');
          for (const article of articles) {
            // Skip the main tweet (first article) — only collect replies
            // Find tweet text
            const textEl = article.querySelector('[data-testid="tweetText"]');
            if (!textEl) continue;
            // Skip retweets/quotes — they have a socialContext
            const socialContext = article.querySelector('[data-testid="socialContext"]');

            // Find username — typically a link with role="link" containing /username
            const links = article.querySelectorAll('a[role="link"]');
            let username = '';
            for (const link of links) {
              const href = link.getAttribute('href') || '';
              const match = href.match(/^\\/(\\w+)$/);
              if (match && match[1] !== 'i' && !match[1].startsWith('hashtag')) {
                username = match[1];
                break;
              }
            }
            // Fallback: find text containing @
            if (!username) {
              const spans = article.querySelectorAll('span');
              for (const span of spans) {
                if (span.textContent.startsWith('@')) {
                  username = span.textContent.replace('@', '');
                  break;
                }
              }
            }

            results.push({
              text: textEl.textContent.trim(),
              username: username || 'unknown',
            });
          }
          return results;
        })()
      `);

      for (const c of batch) {
        if (c.text && !seenTexts.has(c.text)) {
          seenTexts.add(c.text);
          comments.push(c);
        }
      }

      if (onProgress) onProgress({ found: comments.length, scroll: i + 1, total: maxScroll });

      // Scroll down
      await cdp.evaluate(sessionId, 'window.scrollBy(0, 800)');
      await sleep(scrollDelay);
    }

    return { comments, url };
  } finally {
    try { await cdp.detachFromTarget(sessionId); } catch (e) { /* ignore */ }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { scrapeComments, cancel };
