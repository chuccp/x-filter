/**
 * 学习脚本：连接 Chrome，打开指定推文，观察评论 DOM 结构，
 * 并模拟拉黑一个用户后观察 DOM 变化。
 * 
 * 用法: node scripts/learn-dom.js
 * 前提: Chrome 已开启远程调试 (端口 9222)，且已登录 X
 */

const WebSocket = require('ws');
const URL = 'https://x.com/ChineseWSJ/status/2057703033308381452';

let ws = null;
let pending = new Map();
let cmdId = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    cmdId++;
    pending.set(cmdId, { resolve, reject });
    ws.send(JSON.stringify({ id: cmdId, method, params }));
    setTimeout(() => { if (pending.has(cmdId)) { pending.delete(cmdId); reject(new Error('timeout')); } }, 30000);
  });
}

function sendSession(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    cmdId++;
    pending.set(cmdId, { resolve, reject });
    ws.send(JSON.stringify({ id: cmdId, method, params, sessionId }));
    setTimeout(() => { if (pending.has(cmdId)) { pending.delete(cmdId); reject(new Error('timeout')); } }, 30000);
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
  // 1. Connect to Chrome
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

  // 2. Get page targets
  const { targetInfos } = await send('Target.getTargets');
  const pages = targetInfos.filter(t => t.type === 'page');
  if (pages.length === 0) { console.log('没有打开的页面'); return; }

  const sessionId = await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true })
    .then(r => r.sessionId);
  console.log('已附加到页面，sessionId:', sessionId);

  // 3. Navigate to tweet
  console.log('\n=== 导航到推文 ===');
  await sendSession('Page.navigate', { url: URL }, sessionId);
  console.log('等待页面加载...');
  await sleep(5000);

  // Wait for articles
  for (let i = 0; i < 30; i++) {
    const count = await evaluate(sessionId, `document.querySelectorAll('article[data-testid="tweet"]').length`);
    if (count > 0) { console.log(`找到 ${count} 个 article`); break; }
    await sleep(1000);
  }

  // 4. Extract comment structure (BEFORE block)
  console.log('\n=== 拉黑前：评论 DOM 结构 ===');
  const commentsBefore = await evaluate(sessionId, `
    (function() {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const results = [];
      for (let i = 0; i < Math.min(articles.length, 5); i++) {
        const article = articles[i];
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const spans = article.querySelectorAll('span');
        let username = '';
        for (const span of spans) {
          if (span.textContent.startsWith('@')) {
            username = span.textContent.replace('@', '');
            break;
          }
        }
        // Check for caret button
        const caret = article.querySelector('button[data-testid="caret"]');
        
        // Get the full outerHTML structure of the article (truncated)
        const html = article.outerHTML.substring(0, 500);
        
        results.push({
          index: i,
          username: username || 'unknown',
          hasCaret: !!caret,
          textPreview: textEl ? textEl.textContent.substring(0, 80) : '(no text)',
          htmlPreview: html
        });
      }
      return results;
    })()
  `);
  for (const c of commentsBefore) {
    console.log(`\n--- Article ${c.index} ---`);
    console.log(`  用户: @${c.username}`);
    console.log(`  有caret按钮: ${c.hasCaret}`);
    console.log(`  评论: ${c.textPreview}`);
    console.log(`  HTML前500字符: ${c.htmlPreview}`);
  }

  // 5. Try to block the SECOND comment (first is the original post)
  console.log('\n=== 模拟拉黑第二个评论用户 ===');
  const blockResult = await evaluate(sessionId, `
    (async function() {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      if (articles.length < 2) return { error: 'not enough articles' };
      
      // Skip first article (original post), use second
      const article = articles[1];
      
      // Find username
      const spans = article.querySelectorAll('span');
      let username = '';
      for (const span of spans) {
        if (span.textContent.startsWith('@')) {
          username = span.textContent.replace('@', '');
          break;
        }
      }
      
      // Step 1: Click caret
      const caret = article.querySelector('button[data-testid="caret"]');
      if (!caret) return { error: 'caret not found', username };
      caret.click();
      await new Promise(r => setTimeout(r, 1000));
      
      // Step 2: Check what menu items appear
      const menuItems = document.querySelectorAll('[role="menu"] [role="menuitem"]');
      const itemTexts = [...menuItems].map(item => item.textContent);
      
      // Step 3: Find and click "Block" / "屏蔽"
      let blockItem = null;
      for (const item of menuItems) {
        if (item.textContent.includes('Block') || item.textContent.includes('屏蔽')) {
          blockItem = item;
          break;
        }
      }
      if (!blockItem) return { error: 'block menu item not found', menuItems: itemTexts, username };
      
      blockItem.click();
      await new Promise(r => setTimeout(r, 1000));
      
      // Step 4: DON'T auto-confirm — let user click in browser
      // Just report what we see
      const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      
      return {
        username,
        menuItems: itemTexts,
        hadConfirmBtn: !!confirmBtn,
        waitingForUserConfirm: true
      };
    })()
  `);
  console.log('拉黑结果:', JSON.stringify(blockResult, null, 2));

  if (blockResult.waitingForUserConfirm) {
    console.log('\n>>> 请在浏览器中点击确认拉黑按钮 <<<');
    // Wait for user to click confirm in browser
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const dialogGone = await evaluate(sessionId, `
        !document.querySelector('[data-testid="confirmationSheetConfirm"]') &&
        !document.querySelector('[role="menu"]')
      `);
      if (dialogGone) {
        console.log('检测到确认对话框已关闭');
        break;
      }
      if (i % 5 === 0) process.stdout.write('.');
    }
    console.log('');
  }

  // 6. Check DOM state after blocking
  console.log('\n=== 拉黑后：DOM 状态检查 ===');
  await sleep(3000);
  
  const afterState = await evaluate(sessionId, `
    (function() {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const results = [];
      for (let i = 0; i < Math.min(articles.length, 5); i++) {
        const article = articles[i];
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const spans = article.querySelectorAll('span');
        let username = '';
        for (const span of spans) {
          if (span.textContent.startsWith('@')) {
            username = span.textContent.replace('@', '');
            break;
          }
        }
        const caret = article.querySelector('button[data-testid="caret"]');
        
        // Check if article contains "blocked" or "屏蔽" text
        const fullText = article.textContent;
        const hasBlockedText = fullText.includes('blocked') || fullText.includes('屏蔽') || fullText.includes('Block');
        
        results.push({
          index: i,
          username: username || 'unknown',
          hasCaret: !!caret,
          hasBlockedText,
          textPreview: textEl ? textEl.textContent.substring(0, 80) : '(no tweetText)',
          fullTextPreview: fullText.substring(0, 200),
          htmlPreview: article.outerHTML.substring(0, 500)
        });
      }
      
      // Also check if any menus/dialogs are still open
      const openMenus = document.querySelectorAll('[role="menu"]');
      const openDialogs = document.querySelectorAll('[role="dialog"]');
      const openSheets = document.querySelectorAll('[data-testid="confirmationSheetConfirm"]');
      
      return {
        articleCount: articles.length,
        articles: results,
        openMenuCount: openMenus.length,
        openDialogCount: openDialogs.length,
        openSheetCount: openSheets.length
      };
    })()
  `);
  console.log('拉黑后状态:', JSON.stringify(afterState, null, 2));

  // 7. Try scrolling and extracting new comments after block
  console.log('\n=== 拉黑后：滚动并尝试获取新评论 ===');
  
  await evaluate(sessionId, 'window.scrollBy(0, 800)');
  await sleep(2000);
  
  const afterScroll = await evaluate(sessionId, `
    (function() {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const results = [];
      for (let i = 0; i < Math.min(articles.length, 8); i++) {
        const article = articles[i];
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const spans = article.querySelectorAll('span');
        let username = '';
        for (const span of spans) {
          if (span.textContent.startsWith('@')) {
            username = span.textContent.replace('@', '');
            break;
          }
        }
        results.push({
          index: i,
          username: username || 'unknown',
          textPreview: textEl ? textEl.textContent.substring(0, 80) : '(no tweetText)',
        });
      }
      return { articleCount: articles.length, articles: results };
    })()
  `);
  console.log('滚动后:', JSON.stringify(afterScroll, null, 2));

  // 8. Check what the blocked user's article looks like in detail
  console.log('\n=== 被拉黑用户的 article 详细 HTML ===');
  const blockedDetail = await evaluate(sessionId, `
    (function() {
      // Find any article that mentions "blocked" or has unusual structure
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const details = [];
      for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        const fullText = article.textContent;
        if (fullText.includes('屏蔽') || fullText.includes('blocked') || fullText.includes('Blocked')) {
          details.push({
            index: i,
            outerHTML: article.outerHTML.substring(0, 2000),
            fullText: fullText.substring(0, 500)
          });
        }
      }
      return details;
    })()
  `);
  console.log('被拉黑相关 article:', JSON.stringify(blockedDetail, null, 2));

  // Cleanup
  await send('Target.detachFromTarget', { sessionId });
  ws.close();
  console.log('\n=== 完成 ===');
}

main().catch(e => { console.error('Error:', e); ws?.close(); process.exit(1); });
