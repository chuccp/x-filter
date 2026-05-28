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

  const activeTab = await cdp.getActiveTab();
  if (!activeTab) {
    const { sessionId } = await cdp.openNewTab('about:blank');
    return scrapeProfileWithSession(sessionId, profileUrl, onProgress);
  }

  await cdp.activateTarget(activeTab.targetId);
  const sessionId = await cdp.attachToTarget(activeTab.targetId);
  return scrapeProfileWithSession(sessionId, profileUrl, onProgress);
}

async function scrapeProfileWithSession(sessionId, profileUrl, onProgress) {
  const settings = getAllSettings();
  const maxScroll = parseInt(settings.max_scroll) || 50;
  const scrollDelay = parseInt(settings.scroll_delay) || 500;

  try {
    await cdp.navigatePage(sessionId, profileUrl);
    await cdp.waitForPageLoad(sessionId);
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
    const maxNoNew = 10;

    for (let i = 0; i < maxScroll; i++) {
      if (cancelFlag) break;

      const links = await cdp.evaluate(sessionId, `
        (function() {
          var boundaryEl = null;
          var allSpans = document.querySelectorAll('span');
          for (var k = 0; k < allSpans.length; k++) {
            var t = allSpans[k].textContent.trim();
            if (t === '发现更多' || t === 'Discover more') {
              boundaryEl = allSpans[k].closest('[data-testid="cellInnerDiv"]');
              break;
            }
          }
          var links = document.querySelectorAll('a[href*="/status/"]');
          var result = [];
          var seen = new Set();
          for (var i = 0; i < links.length; i++) {
            if (boundaryEl && (boundaryEl.compareDocumentPosition(links[i]) & 4)) break;
            var href = links[i].getAttribute('href');
            var m = href.match(/^\\/(\\w+)\\/status\\/(\\d+)/);
            var url = m ? 'https://x.com' + m[0] : null;
            if (url && !seen.has(url)) {
              seen.add(url);
              result.push(url);
            }
          }
          return result;
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

  const activeTab = await cdp.getActiveTab();
  if (!activeTab) {
    const { sessionId } = await cdp.openNewTab('about:blank');
    return scrapeWithSession(sessionId, url, onProgress);
  }

  await cdp.activateTarget(activeTab.targetId);
  const sessionId = await cdp.attachToTarget(activeTab.targetId);
  return scrapeWithSession(sessionId, url, onProgress);
}

async function scrapeWithSession(sessionId, url, onProgress) {
  const settings = getAllSettings();
  const maxScroll = parseInt(settings.max_scroll) || 50;
  const scrollDelay = parseInt(settings.scroll_delay) || 500;

  try {
    // Navigate and wait for React to render tweet articles
    await cdp.navigatePage(sessionId, url);
    await cdp.waitForPageLoad(sessionId);
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
    const maxNoNew = 8;

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
          var articles = document.querySelectorAll('article[data-testid="tweet"]');
          // Find system recommendation boundary
          var boundaryEl = null;
          var allSpans = document.querySelectorAll('span');
          for (var k = 0; k < allSpans.length; k++) {
            var t = allSpans[k].textContent.trim();
            if (t === '发现更多' || t === 'Discover more') {
              boundaryEl = allSpans[k].closest('[data-testid="cellInnerDiv"]');
              break;
            }
          }
          var isFirst = true;
          for (var i = 0; i < articles.length; i++) {
            var article = articles[i];
            if (boundaryEl && (boundaryEl.compareDocumentPosition(article) & 4)) { results.push({ _endReached: true }); break; }
            var textEl = article.querySelector('[data-testid="tweetText"]');
            if (!textEl) continue;
            var text = getTextWithEmojis(textEl);

            if (isFirst) {
              results.push({ _isPost: true, text: text, username: '' });
              isFirst = false;
              continue;
            }

            var socialContext = article.querySelector('[data-testid="socialContext"]');

            var links = article.querySelectorAll('a[role="link"]');
            var username = '';
            for (var j = 0; j < links.length; j++) {
              var href = links[j].getAttribute('href') || '';
              var match = href.match(/^\\/(\\w+)$/);
              if (match && match[1] !== 'i' && !match[1].startsWith('hashtag')) {
                username = match[1];
                break;
              }
            }
            if (!username) {
              var spans2 = article.querySelectorAll('span');
              for (var s = 0; s < spans2.length; s++) {
                if (spans2[s].textContent.startsWith('@')) {
                  username = spans2[s].textContent.replace('@', '');
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
      let endReached = false;
      const newComments = [];
      for (const c of batch) {
        if (c._endReached) { endReached = true; break; }
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
        if (noNewCount >= maxNoNew) break;
      } else {
        noNewCount = 0;
      }

      if (endReached) break;

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
  await cdp.waitForPageLoad(sessionId);
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
  const maxNoNew = 8;

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
        var articles2 = document.querySelectorAll('article[data-testid="tweet"]');
        var boundaryEl2 = null;
        var allSpans2 = document.querySelectorAll('span');
        for (var k2 = 0; k2 < allSpans2.length; k2++) {
          var t2 = allSpans2[k2].textContent.trim();
          if (t2 === '发现更多' || t2 === 'Discover more') {
            boundaryEl2 = allSpans2[k2].closest('[data-testid="cellInnerDiv"]');
            break;
          }
        }
        var isFirst2 = true;
        for (var i2 = 0; i2 < articles2.length; i2++) {
          var article2 = articles2[i2];
          if (boundaryEl2 && (boundaryEl2.compareDocumentPosition(article2) & 4)) break;
          var textEl2 = article2.querySelector('[data-testid="tweetText"]');
          if (!textEl2) continue;
          var text2 = getTextWithEmojis(textEl2);

          if (isFirst2) {
            results.push({ _isPost: true, text: text2, username: '' });
            isFirst2 = false;
            continue;
          }

          var socialContext2 = article2.querySelector('[data-testid="socialContext"]');

          var links2 = article2.querySelectorAll('a[role="link"]');
          var username2 = '';
          for (var j2 = 0; j2 < links2.length; j2++) {
            var href2 = links2[j2].getAttribute('href') || '';
            var match2 = href2.match(/^\\/(\\w+)$/);
            if (match2 && match2[1] !== 'i' && !match2[1].startsWith('hashtag')) {
              username2 = match2[1];
              break;
            }
          }
          if (!username2) {
            var spans3 = article2.querySelectorAll('span');
            for (var s2 = 0; s2 < spans3.length; s2++) {
              if (spans3[s2].textContent.startsWith('@')) {
                username2 = spans3[s2].textContent.replace('@', '');
                break;
              }
            }
          }

          results.push({
            text: text2,
            username: username2 || 'unknown',
          });
        }
        return results;
      })()
    `);

    let newInBatch = 0;
    let endReached2 = false;
    const newComments = [];
    for (const c of batch) {
      if (c._endReached) { endReached2 = true; break; }
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
          noNewCount = 0;
        }
      }
    }

    if (endReached2) break;

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
