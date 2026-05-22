const cdp = require('./cdp-manager');
const { getAllSettings } = require('./database');
const { t } = require('./i18n');

let cancelFlag = false;

function cancel() {
  cancelFlag = true;
}

function isProfileUrl(url) {
  // Post URL: x.com/user/status/123456...
  // Profile URL: x.com/user (no /status/ in path)
  try {
    const u = new URL(url);
    return u.hostname === 'x.com' && !u.pathname.includes('/status/');
  } catch {
    return !url.includes('/status/');
  }
}

async function scrapeProfilePosts(profileUrl, onProgress) {
  cancelFlag = false;

  const targets = await cdp.getPageTargets();
  if (targets.length === 0) {
    const { sessionId } = await cdp.openNewTab('about:blank');
    return scrapeProfileWithSession(sessionId, profileUrl, onProgress);
  }

  const sessionId = await cdp.attachToTarget(targets[0].targetId);
  return scrapeProfileWithSession(sessionId, profileUrl, onProgress);
}

async function scrapeProfileWithSession(sessionId, profileUrl, onProgress) {
  const settings = getAllSettings();
  const maxScroll = parseInt(settings.max_scroll) || 50;
  const scrollDelay = parseInt(settings.scroll_delay) || 500;

  try {
    await cdp.navigatePage(sessionId, profileUrl);
    await cdp.waitForSelector(sessionId, 'article[data-testid="tweet"]', 30000);

    if (cancelFlag) return [];

    // Check if we're on a login wall
    const isLoggedIn = await cdp.evaluate(sessionId,
      '!!document.querySelector(\'article[data-testid="tweet"]\')'
    );
    if (!isLoggedIn) {
      const hasLogin = await cdp.evaluate(sessionId,
        'document.body.innerText.includes("Sign in") || document.body.innerText.includes("Log in")'
      );
      if (hasLogin) throw new Error(t('scrape.login_required'));
    }

    const postUrls = new Set();
    let noNewCount = 0;
    const maxNoNew = 5;

    for (let i = 0; i < maxScroll; i++) {
      if (cancelFlag) break;

      const links = await cdp.evaluate(sessionId, `
        (function() {
          const links = document.querySelectorAll('a[href*="/status/"]');
          return [...new Set([...links].map(a => {
            const href = a.getAttribute('href');
            // Extract status ID: /username/status/1234567890
            const m = href.match(/^\\/(\\w+)\\/status\\/(\\d+)/);
            return m ? 'https://x.com' + m[0] : null;
          }).filter(Boolean))];
        })()
      `);

      let newCount = 0;
      for (const url of links) {
        if (!postUrls.has(url)) {
          postUrls.add(url);
          newCount++;
        }
      }

      if (onProgress) onProgress({ phase: 'listing', posts: postUrls.size, scroll: i + 1 });

      if (newCount === 0) {
        noNewCount++;
        if (noNewCount >= maxNoNew) break;
      } else {
        noNewCount = 0;
      }

      await cdp.evaluate(sessionId, 'window.scrollBy(0, 400)');
      await sleep(scrollDelay);
    }

    return [...postUrls];
  } finally {
    try { await cdp.detachFromTarget(sessionId); } catch (e) { /* ignore */ }
  }
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
  const settings = getAllSettings();
  const maxScroll = parseInt(settings.max_scroll) || 50;
  const scrollDelay = parseInt(settings.scroll_delay) || 500;

  try {
    // Navigate and wait for React to render tweet articles
    await cdp.navigatePage(sessionId, url);
    await cdp.waitForSelector(sessionId, 'article[data-testid="tweet"]', 30000);

    if (cancelFlag) return { comments: [], url };

    // Check if we're on a login wall
    const isLoggedIn = await cdp.evaluate(sessionId,
      '!!document.querySelector(\'article[data-testid="tweet"]\') || !!document.querySelector(\'[data-testid="tweetText"]\')'
    );
    if (!isLoggedIn) {
      const hasLogin = await cdp.evaluate(sessionId,
        'document.body.innerText.includes("Sign in") || document.body.innerText.includes("Log in")'
      );
      if (hasLogin) throw new Error(t('scrape.login_required'));
    }

    // Scroll and collect
    const comments = [];
    const seenTexts = new Set();
    let postText = '';
    let noNewCount = 0;
    const maxNoNew = 3; // Stop after 3 consecutive scrolls with no new comments

    for (let i = 0; i < maxScroll; i++) {
      if (cancelFlag) break;

      // Extract comments currently visible
      const batch = await cdp.evaluate(sessionId, `
        (function() {
          function getTextWithEmojis(el) {
            let result = '';
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (node.nodeType === Node.TEXT_NODE) {
                result += node.textContent;
              } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG' && node.alt) {
                result += node.alt;
              }
            }
            return result.trim();
          }
          const results = [];
          const articles = document.querySelectorAll('article[data-testid="tweet"]');
          let isFirst = true;
          for (const article of articles) {
            const textEl = article.querySelector('[data-testid="tweetText"]');
            if (!textEl) continue;
            const text = getTextWithEmojis(textEl);

            if (isFirst) {
              // First article is the original post — capture its text and skip
              results.push({ _isPost: true, text: text, username: '' });
              isFirst = false;
              continue;
            }

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
              text: text,
              username: username || 'unknown',
            });
          }
          return results;
        })()
      `);

      let newInBatch = 0;
      const newComments = [];
      for (const c of batch) {
        // Extract post text from the first article marker
        if (c._isPost) {
          if (!postText) postText = c.text;
          continue;
        }
        const normalized = normalizeText(c.text);
        if (c.text && !seenTexts.has(normalized)) {
          seenTexts.add(normalized);
          c.post_text = postText;
          comments.push(c);
          newComments.push({ text: c.text, username: c.username });
          newInBatch++;
        }
      }

      if (newInBatch === 0) {
        noNewCount++;
        if (noNewCount >= maxNoNew) break; // No new comments after several scrolls, stop
      } else {
        noNewCount = 0;
      }

      if (onProgress) onProgress({ found: comments.length, scroll: i + 1, total: maxScroll, newComments });

      // Scroll down
      await cdp.evaluate(sessionId, 'window.scrollBy(0, 400)');
      await sleep(scrollDelay);
    }

    return { comments, url };
  } finally {
    try { await cdp.detachFromTarget(sessionId); } catch (e) { /* ignore */ }
  }
}

async function scrapeInSession(sessionId, url, onNewComment, onProgress) {
  const settings = getAllSettings();
  const maxScroll = parseInt(settings.max_scroll) || 50;
  const scrollDelay = parseInt(settings.scroll_delay) || 500;

  await cdp.navigatePage(sessionId, url);
  await cdp.waitForSelector(sessionId, 'article[data-testid="tweet"]', 30000);

  if (cancelFlag) return { comments: [], url };

  const isLoggedIn = await cdp.evaluate(sessionId,
    '!!document.querySelector(\'article[data-testid="tweet"]\') || !!document.querySelector(\'[data-testid="tweetText"]\')'
  );
  if (!isLoggedIn) {
    const hasLogin = await cdp.evaluate(sessionId,
      'document.body.innerText.includes("Sign in") || document.body.innerText.includes("Log in")'
    );
    if (hasLogin) throw new Error(t('scrape.login_required'));
  }

  const comments = [];
  const seenTexts = new Set();
  let postText = '';
  let noNewCount = 0;
  const maxNoNew = 3;

  for (let i = 0; i < maxScroll; i++) {
    if (cancelFlag) break;

    const batch = await cdp.evaluate(sessionId, `
      (function() {
        function getTextWithEmojis(el) {
          let result = '';
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.nodeType === Node.TEXT_NODE) {
              result += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG' && node.alt) {
              result += node.alt;
            }
          }
          return result.trim();
        }
        const results = [];
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        let isFirst = true;
        for (const article of articles) {
          const textEl = article.querySelector('[data-testid="tweetText"]');
          if (!textEl) continue;
          const text = getTextWithEmojis(textEl);

          if (isFirst) {
            results.push({ _isPost: true, text: text, username: '' });
            isFirst = false;
            continue;
          }

          const socialContext = article.querySelector('[data-testid="socialContext"]');

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
            text: text,
            username: username || 'unknown',
          });
        }
        return results;
      })()
    `);

    let newInBatch = 0;
    const newComments = [];
    for (const c of batch) {
      if (c._isPost) {
        if (!postText) postText = c.text;
        continue;
      }
      const normalized = normalizeText(c.text);
      if (c.text && !seenTexts.has(normalized)) {
        seenTexts.add(normalized);
        c.post_text = postText;
        comments.push(c);
        newComments.push({ text: c.text, username: c.username });
        newInBatch++;

        if (onNewComment) {
          await onNewComment(c);
          // Blocking a user removes their article from the DOM, which can
          // cause the next few scrolls to show only already-seen comments.
          // Reset the counter so we don't exit the loop prematurely.
          noNewCount = 0;
        }
      }
    }

    if (newInBatch === 0) {
      noNewCount++;
      if (noNewCount >= maxNoNew) break;
    } else {
      noNewCount = 0;
    }

    if (onProgress) onProgress({ found: comments.length, scroll: i + 1, total: maxScroll, newComments });

    await cdp.evaluate(sessionId, 'window.scrollBy(0, 400)');
    await sleep(scrollDelay);
  }

  return { comments, url };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

module.exports = { scrapeComments, scrapeProfilePosts, scrapeInSession, isProfileUrl, cancel };
