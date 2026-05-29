/**
 * 诊断脚本：检查指定推文为何无法采集评论
 * 用法: node scripts/debug-scrape.js
 * 前提: Chrome 已开启远程调试 (端口 9222)，且已登录 X
 */

const WebSocket = require('ws');
const URL = 'https://x.com/xiaohu/status/2059708948085932386';

let ws = null;
let pending = new Map();
let cmdId = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    cmdId++;
    pending.set(cmdId, { resolve, reject });
    ws.send(JSON.stringify({ id: cmdId, method, params }));
    setTimeout(() => {
      if (pending.has(cmdId)) { pending.delete(cmdId); reject(new Error(`timeout: ${method}`)); }
    }, 30000);
  });
}

function sendSession(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    cmdId++;
    pending.set(cmdId, { resolve, reject });
    ws.send(JSON.stringify({ id: cmdId, method, params, sessionId }));
    setTimeout(() => {
      if (pending.has(cmdId)) { pending.delete(cmdId); reject(new Error(`timeout: ${method}`)); }
    }, 30000);
  });
}

function evaluate(sessionId, expr) {
  return sendSession('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId).then(r => {
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : null;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== 连接 Chrome ===');
  ws = new WebSocket('ws://127.0.0.1:9222/devtools/browser');
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('已连接');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } catch (e) {}
  });

  const { targetInfos } = await send('Target.getTargets');
  const pages = targetInfos.filter(t => t.type === 'page');
  if (pages.length === 0) { console.log('没有打开的页面'); return; }

  const sessionId = await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true })
    .then(r => r.sessionId);
  console.log('sessionId:', sessionId);

  // 1. 导航到目标推文
  console.log('\n=== 导航到目标推文 ===');
  console.log('URL:', URL);
  await sendSession('Page.navigate', { url: URL }, sessionId);
  console.log('等待页面加载...');
  await sleep(6000);

  // 2. 基本页面状态
  console.log('\n=== [1] 基本页面状态 ===');
  const basicState = await evaluate(sessionId, `
    ({
      url: location.href,
      title: document.title,
      bodyText200: document.body.innerText.substring(0, 200),
      hasLoginWall: document.body.innerText.includes('Sign in') || document.body.innerText.includes('Log in') || document.body.innerText.includes('登录'),
      articleCount: document.querySelectorAll('article[data-testid="tweet"]').length,
      hasTweetText: !!document.querySelector('[data-testid="tweetText"]'),
      hasTimelineItem: !!document.querySelector('[data-testid="cellInnerDiv"]'),
      hasPrimaryColumn: !!document.querySelector('[data-testid="primaryColumn"]'),
    })
  `);
  console.log(JSON.stringify(basicState, null, 2));

  // 3. 等更久，再检查
  console.log('\n=== [2] 等待更长时间后再检查 article ===');
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const count = await evaluate(sessionId, `document.querySelectorAll('article[data-testid="tweet"]').length`);
    process.stdout.write(`  ${i + 1}s: ${count} articles\n`);
    if (count > 0) break;
  }

  // 4. 详细检查 article 结构
  console.log('\n=== [3] Article 详细结构 ===');
  const articleDetail = await evaluate(sessionId, `
    (function() {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      if (articles.length === 0) return { error: 'no articles found' };

      const results = [];
      for (let i = 0; i < Math.min(articles.length, 8); i++) {
        const a = articles[i];
        // Username via link
        let usernameLink = '';
        for (const link of a.querySelectorAll('a[role="link"]')) {
          const m = link.getAttribute('href')?.match(/^\\/([\\w]+)$/);
          if (m && m[1] !== 'i' && !m[1].startsWith('hashtag')) {
            usernameLink = m[1]; break;
          }
        }
        // Username via span
        let usernameSpan = '';
        for (const span of a.querySelectorAll('span')) {
          if (span.textContent.startsWith('@')) { usernameSpan = span.textContent.replace('@', ''); break; }
        }
        const textEl = a.querySelector('[data-testid="tweetText"]');
        results.push({
          index: i,
          usernameLink,
          usernameSpan,
          hasTweetText: !!textEl,
          textPreview: textEl ? textEl.innerText.substring(0, 100) : null,
          isPost: i === 0,
        });
      }
      return { total: articles.length, results };
    })()
  `);
  console.log(JSON.stringify(articleDetail, null, 2));

  // 5. 检查是否有"Discover more"边界
  console.log('\n=== [4] 检查 "Discover more" / "发现更多" 边界 ===');
  const boundaryCheck = await evaluate(sessionId, `
    (function() {
      const allSpans = document.querySelectorAll('span');
      const boundary = [];
      for (const span of allSpans) {
        const t = span.textContent.trim();
        if (t === '发现更多' || t === 'Discover more') {
          boundary.push({
            text: t,
            parentHTML: span.parentElement?.outerHTML?.substring(0, 200),
            hasCellInnerDiv: !!span.closest('[data-testid="cellInnerDiv"]'),
          });
        }
      }
      return { count: boundary.length, items: boundary };
    })()
  `);
  console.log(JSON.stringify(boundaryCheck, null, 2));

  // 6. 检查 cellInnerDiv 结构（scraper 用于边界判断）
  console.log('\n=== [5] cellInnerDiv 数量和结构 ===');
  const cellDivs = await evaluate(sessionId, `
    (function() {
      const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
      return {
        count: cells.length,
        firstText: cells[0]?.innerText?.substring(0, 100),
        lastText: cells[cells.length - 1]?.innerText?.substring(0, 100),
      };
    })()
  `);
  console.log(JSON.stringify(cellDivs, null, 2));

  // 7. 模拟 scraper 的 username 提取逻辑，看哪些 article 会被跳过
  console.log('\n=== [6] 模拟 scraper 提取逻辑 ===');
  const scraperSim = await evaluate(sessionId, `
    (function() {
      function getTextWithEmojis(el) {
        if (!el) return '';
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
        var text = '';
        var node;
        while ((node = walker.nextNode())) {
          if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
          } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
            text += node.alt || '';
          }
        }
        return text;
      }

      var articles = document.querySelectorAll('article[data-testid="tweet"]');
      var results = [];

      // boundary check
      var boundaryEl = null;
      var allSpans = document.querySelectorAll('span');
      for (var span of allSpans) {
        if (span.textContent.trim() === '发现更多' || span.textContent.trim() === 'Discover more') {
          var cell = span.closest('[data-testid="cellInnerDiv"]');
          if (cell) { boundaryEl = cell; break; }
        }
      }

      for (var i = 0; i < articles.length; i++) {
        var article = articles[i];

        // boundary check
        var afterBoundary = false;
        if (boundaryEl) {
          afterBoundary = !!(boundaryEl.compareDocumentPosition(article) & 4); // FOLLOWING
        }

        var textEl = article.querySelector('[data-testid="tweetText"]');
        var text = getTextWithEmojis(textEl);

        // username via link
        var username = '';
        var links = article.querySelectorAll('a[role="link"]');
        for (var link of links) {
          var href = link.getAttribute('href') || '';
          var m = href.match(/^\\/([\\w]+)$/);
          if (m && m[1] !== 'i' && !m[1].startsWith('hashtag')) {
            username = m[1]; break;
          }
        }
        if (!username) {
          for (var span of article.querySelectorAll('span')) {
            if (span.textContent.startsWith('@')) {
              username = span.textContent.replace('@', ''); break;
            }
          }
        }

        results.push({
          index: i,
          isPost: i === 0,
          skipped_noTextEl: !textEl,
          afterBoundary,
          username: username || 'unknown',
          textPreview: text ? text.substring(0, 80) : null,
          wouldBeCollected: i > 0 && !!textEl && !afterBoundary,
        });
      }

      return {
        total: articles.length,
        hasBoundary: !!boundaryEl,
        results,
        wouldCollect: results.filter(r => r.wouldBeCollected).length,
      };
    })()
  `);
  console.log(JSON.stringify(scraperSim, null, 2));

  // 8. 检查页面是否有特殊提示（限制访问、仅限关注者等）
  console.log('\n=== [7] 特殊提示检查 ===');
  const specialPrompts = await evaluate(sessionId, `
    (function() {
      const body = document.body.innerText;
      return {
        hasAgeRestriction: body.includes('age') || body.includes('年龄') || body.includes('敏感'),
        hasSensitiveContent: body.includes('sensitive') || body.includes('敏感内容'),
        hasPrivateAccount: body.includes('protected') || body.includes('仅限关注者') || body.includes('Private'),
        hasSuspended: body.includes('suspended') || body.includes('已被封禁'),
        hasNotFound: body.includes('doesn\\'t exist') || body.includes('不存在') || document.title.includes('404'),
        has429: body.includes('rate limit') || body.includes('Too many requests'),
        bodySnippet: body.substring(0, 400),
      };
    })()
  `);
  console.log(JSON.stringify(specialPrompts, null, 2));

  // 9. 滚动一次后再检查
  console.log('\n=== [8] 滚动后再检查 ===');
  await evaluate(sessionId, 'window.scrollBy(0, 800)');
  await sleep(2000);
  const afterScroll = await evaluate(sessionId, `
    ({
      articleCount: document.querySelectorAll('article[data-testid="tweet"]').length,
      hasTweetText: document.querySelectorAll('[data-testid="tweetText"]').length,
    })
  `);
  console.log(JSON.stringify(afterScroll, null, 2));

  // 10. 检查是否有隐藏/折叠评论的提示
  console.log('\n=== [9] 检查评论区提示文字 ===');
  const commentSection = await evaluate(sessionId, `
    (function() {
      // Look for "replies" section or any indicators about reply state
      const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
      const texts = [];
      for (const cell of cells) {
        const t = cell.innerText.trim();
        if (t && !cell.querySelector('article')) {
          texts.push(t.substring(0, 150));
        }
      }
      return texts;
    })()
  `);
  console.log('非 article 的 cellInnerDiv 内容:');
  commentSection.forEach((t, i) => console.log(`  [${i}] ${t}`));

  await send('Target.detachFromTarget', { sessionId });
  ws.close();
  console.log('\n=== 诊断完成 ===');
}

main().catch(e => { console.error('Error:', e); ws?.close(); process.exit(1); });
