/**
 * 精确模拟流式拉黑流程，逐步执行每个操作，记录每一步结果和耗时
 * 用法: node scripts/test-streaming.js
 */
const WebSocket = require('ws');
const TARGET_URL = 'https://x.com/ChineseWSJ/status/2057703033308381452';

let ws = null, pending = new Map(), cmdId = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    cmdId++;
    pending.set(cmdId, { resolve, reject });
    ws.send(JSON.stringify({ id: cmdId, method, params }));
    setTimeout(() => { if (pending.has(cmdId)) { pending.delete(cmdId); reject(new Error('timeout 30s: ' + method)); } }, 30000);
  });
}
function sendSession(method, params, sid) {
  return new Promise((resolve, reject) => {
    cmdId++;
    pending.set(cmdId, { resolve, reject });
    ws.send(JSON.stringify({ id: cmdId, method, params, sessionId: sid }));
    setTimeout(() => { if (pending.has(cmdId)) { pending.delete(cmdId); reject(new Error('timeout 30s: ' + method)); } }, 30000);
  });
}
function evaluate(sid, expr) {
  return sendSession('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)
    .then(r => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result ? r.result.value : null; });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function timed(label, fn) {
  const t0 = Date.now();
  console.log(`  ▶ ${label} ...`);
  try {
    const result = await fn();
    console.log(`  ✔ ${label} (${Date.now() - t0}ms)`, typeof result === 'object' ? JSON.stringify(result) : result);
    return result;
  } catch (e) {
    console.log(`  ✖ ${label} FAILED (${Date.now() - t0}ms): ${e.message}`);
    throw e;
  }
}

async function main() {
  console.log('=== 1. 连接 Chrome ===');
  ws = new WebSocket('ws://127.0.0.1:9222/devtools/browser');
  await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
  ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } catch(e){} });
  const { targetInfos } = await send('Target.getTargets');
  const pages = targetInfos.filter(t => t.type === 'page');
  const sid = (await send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true })).sessionId;
  console.log('sessionId:', sid);

  console.log('\n=== 2. 导航到推文 ===');
  await timed('navigate', () => sendSession('Page.navigate', { url: TARGET_URL }, sid));
  await sleep(5000);
  for (let i = 0; i < 30; i++) {
    const c = await evaluate(sid, `document.querySelectorAll('article[data-testid="tweet"]').length`);
    if (c > 0) { console.log('  articles:', c); break; }
    await sleep(1000);
  }

  // ---- 模拟 scrapeInSession 第一次滚动迭代 ----
  console.log('\n=== 3. 第一次滚动：提取评论 ===');
  const batch1 = await timed('extract comments', () => evaluate(sid, `
    (function() {
      const results = [];
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      let isFirst = true;
      for (const article of articles) {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (!textEl) continue;
        if (isFirst) { isFirst = false; continue; }
        const spans = article.querySelectorAll('span');
        let username = '';
        for (const s of spans) { if (s.textContent.startsWith('@')) { username = s.textContent.replace('@',''); break; } }
        results.push({ text: textEl.textContent.substring(0,50), username: username||'unknown' });
      }
      return results;
    })()
  `));
  console.log('  发现评论:', batch1.length, '条');
  for (const c of batch1) console.log(`    @${c.username}: ${c.text}`);

  // ---- 模拟 blockSingleUser 拉黑第一条评论 ----
  if (batch1.length > 0) {
    const target = batch1[0];
    console.log(`\n=== 4. blockSingleUser: 拉黑 @${target.username} ===`);
    
    const blockResult = await timed('blockSingleUser', () => evaluate(sid, `
      (async function() {
        const safeUsername = '${(target.username||'').replace(/[\\\\"']/g, "\\\\$&")}';
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (const article of articles) {
          const spans = article.querySelectorAll('span');
          let found = false;
          for (const span of spans) {
            if (span.textContent === '@' + safeUsername) { found = true; break; }
          }
          if (!found) continue;

          const caret = article.querySelector('button[data-testid="caret"]');
          if (!caret) return { error: 'caret not found' };
          caret.click();
          await new Promise(r => setTimeout(r, 800));

          const menuItems = document.querySelectorAll('[role="menu"] [role="menuitem"]');
          for (const item of menuItems) {
            if (item.textContent.includes('Block') || item.textContent.includes('屏蔽')) {
              item.click();
              await new Promise(r => setTimeout(r, 800));

              const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
              if (confirmBtn) {
                confirmBtn.click();
                await new Promise(r => setTimeout(r, 1000));
              }
              return { blocked: true, username: safeUsername };
            }
          }
          return { error: 'block menu item not found' };
        }
        return { error: 'user article not found' };
      })()
    `));
    console.log('  拉黑结果:', blockResult);

    // 等用户确认
    if (blockResult && blockResult.blocked === true && blockResult.username) {
      // blockResult returned before actual confirm? Check if confirm dialog exists
      const hasConfirm = await evaluate(sid, `!!document.querySelector('[data-testid="confirmationSheetConfirm"]')`);
      if (hasConfirm) {
        console.log('\n  >>> 请在浏览器中点击确认拉黑 <<<');
        for (let i = 0; i < 60; i++) {
          await sleep(1000);
          const gone = await evaluate(sid, `!document.querySelector('[data-testid="confirmationSheetConfirm"]') && !document.querySelector('[role="menu"]')`);
          if (gone) { console.log('  确认对话框已关闭'); break; }
          if (i % 5 === 0) process.stdout.write('.');
        }
        console.log('');
      }
    }
  }

  // ---- 检查拉黑后的 DOM 状态 ----
  console.log('\n=== 5. 拉黑后：DOM 状态 ===');
  const postBlockState = await timed('check DOM', () => evaluate(sid, `
    (function() {
      return {
        articleCount: document.querySelectorAll('article[data-testid="tweet"]').length,
        openMenus: document.querySelectorAll('[role="menu"]').length,
        openDialogs: document.querySelectorAll('[role="dialog"]').length,
        confirmSheet: !!document.querySelector('[data-testid="confirmationSheetConfirm"]'),
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
        docHeight: document.documentElement.scrollHeight,
      };
    })()
  `));

  // ---- 关键：关闭任何残留的菜单/对话框 ----
  console.log('\n=== 6. 清理残留 DOM ===');
  await timed('press Escape', () => evaluate(sid, `
    (function() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
      // Also try clicking outside any menus
      const backdrop = document.querySelector('[data-testid="mask"]');
      if (backdrop) backdrop.click();
      return { done: true };
    })()
  `));
  await sleep(500);
  const afterClean = await timed('recheck DOM', () => evaluate(sid, `
    (function() {
      return {
        openMenus: document.querySelectorAll('[role="menu"]').length,
        confirmSheet: !!document.querySelector('[data-testid="confirmationSheetConfirm"]'),
        scrollY: window.scrollY,
      };
    })()
  `));

  // ---- 第二次滚动：看是否能继续提取评论 ----
  console.log('\n=== 7. 第二次滚动 ===');
  await timed('scroll', () => evaluate(sid, 'window.scrollBy(0, 800)'));
  await sleep(2000);
  
  const batch2 = await timed('extract after scroll', () => evaluate(sid, `
    (function() {
      const results = [];
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      let isFirst = true;
      for (const article of articles) {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (!textEl) continue;
        if (isFirst) { isFirst = false; continue; }
        const spans = article.querySelectorAll('span');
        let username = '';
        for (const s of spans) { if (s.textContent.startsWith('@')) { username = s.textContent.replace('@',''); break; } }
        results.push({ text: textEl.textContent.substring(0,50), username: username||'unknown' });
      }
      return results;
    })()
  `));
  console.log('  发现评论:', batch2.length, '条');
  for (const c of batch2) console.log(`    @${c.username}: ${c.text}`);

  // ---- 第三次滚动 + 第二次拉黑 ----
  if (batch2.length > 1) {
    // 找一个不同于第一个的用户
    const target2 = batch2.find(c => c.username !== batch1[0].username) || batch2[1];
    console.log(`\n=== 8. 第二次 blockSingleUser: 拉黑 @${target2.username} ===`);
    
    const blockResult2 = await timed('blockSingleUser #2', () => evaluate(sid, `
      (async function() {
        const safeUsername = '${(target2.username||'').replace(/[\\\\"']/g, "\\\\$&")}';
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (const article of articles) {
          const spans = article.querySelectorAll('span');
          let found = false;
          for (const span of spans) {
            if (span.textContent === '@' + safeUsername) { found = true; break; }
          }
          if (!found) continue;

          const caret = article.querySelector('button[data-testid="caret"]');
          if (!caret) return { error: 'caret not found' };
          caret.click();
          await new Promise(r => setTimeout(r, 800));

          const menuItems = document.querySelectorAll('[role="menu"] [role="menuitem"]');
          for (const item of menuItems) {
            if (item.textContent.includes('Block') || item.textContent.includes('屏蔽')) {
              item.click();
              await new Promise(r => setTimeout(r, 800));

              const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
              if (confirmBtn) {
                confirmBtn.click();
                await new Promise(r => setTimeout(r, 1000));
              }
              return { blocked: true, username: safeUsername };
            }
          }
          return { error: 'block menu item not found' };
        }
        return { error: 'user article not found' };
      })()
    `));
    console.log('  拉黑结果:', blockResult2);

    const hasConfirm2 = await evaluate(sid, `!!document.querySelector('[data-testid="confirmationSheetConfirm"]')`);
    if (hasConfirm2) {
      console.log('\n  >>> 请在浏览器中点击确认拉黑 <<<');
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const gone = await evaluate(sid, `!document.querySelector('[data-testid="confirmationSheetConfirm"]') && !document.querySelector('[role="menu"]')`);
        if (gone) { console.log('  确认对话框已关闭'); break; }
        if (i % 5 === 0) process.stdout.write('.');
      }
    }
  }

  // ---- 第四次滚动 ----
  console.log('\n=== 9. 第三次滚动 ===');
  await evaluate(sid, 'window.scrollBy(0, 800)');
  await sleep(2000);
  const batch3 = await timed('extract after scroll #3', () => evaluate(sid, `
    (function() {
      const results = [];
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      let isFirst = true;
      for (const article of articles) {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (!textEl) continue;
        if (isFirst) { isFirst = false; continue; }
        const spans = article.querySelectorAll('span');
        let username = '';
        for (const s of spans) { if (s.textContent.startsWith('@')) { username = s.textContent.replace('@',''); break; } }
        results.push({ text: textEl.textContent.substring(0,50), username: username||'unknown' });
      }
      return results;
    })()
  `));
  console.log('  发现评论:', batch3.length, '条');

  // Cleanup
  await send('Target.detachFromTarget', { sessionId: sid });
  ws.close();
  console.log('\n=== 完成 ===');
}

main().catch(e => { console.error('FATAL:', e); ws?.close(); process.exit(1); });
