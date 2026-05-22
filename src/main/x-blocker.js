const cdp = require('./cdp-manager');
const { isUserBlocked, addBlockedUser } = require('./database');
const { t } = require('./i18n');

let cancelFlag = false;

function cancel() {
  cancelFlag = true;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function blockUsers(sourceUrl, comments, onProgress) {
  cancelFlag = false;

  const targets = await cdp.getPageTargets();
  if (targets.length === 0) {
    throw new Error(t('block.no_tabs'));
  }

  const sessionId = await cdp.attachToTarget(targets[0].targetId);
  await cdp.navigatePage(sessionId, sourceUrl);
  await sleep(3000);
  await cdp.waitForPageLoad(sessionId, 15000);

  let scanned = 0;
  let blocked = 0;
  let errors = 0;

  for (let i = 0; i < comments.length; i++) {
    if (cancelFlag) break;

    const c = comments[i];
    scanned++;

    try {
      if (onProgress) onProgress({ phase: 'blocking', scanned, blocked, errors, total: comments.length, username: c.username });

      if (isUserBlocked(c.username)) continue;

      const result = await blockUserOnPage(sessionId, c.username, c.text);
      if (result) {
        blocked++;
        if (onProgress) onProgress({ phase: 'blocked', scanned, blocked, errors, total: comments.length, username: c.username });
      }
    } catch (e) {
      errors++;
      if (onProgress) onProgress({ phase: 'error', scanned, blocked, errors, total: comments.length, error: e.message });
    }

    await sleep(2000);
  }

  await cdp.detachFromTarget(sessionId);
  return { scanned, blocked, errors };
}

/**
 * Block a user by performing DOM clicks step-by-step.
 * Each step is a separate synchronous CDP call — no async IIFE,
 * which is more reliable than one big awaited script.
 *
 * Flow: find article → click caret → click "屏蔽/Block" → wait for user confirm
 */
async function blockUserOnPage(sessionId, username, reason) {
  const safeUsername = username.replace(/[\\"']/g, '\\$&');

  // Save scroll position
  const savedScrollY = await cdp.evaluate(sessionId, 'window.scrollY');

  try {
    // Step 1: Find the article and click its caret "..." button
    const caretResult = await cdp.evaluate(sessionId, `
      (function() {
        var articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (var i = 0; i < articles.length; i++) {
          var article = articles[i];
          var spans = article.querySelectorAll('span');
          for (var j = 0; j < spans.length; j++) {
            if (spans[j].textContent === '@${safeUsername}') {
              var caret = article.querySelector('button[data-testid="caret"]');
              if (!caret) return { error: 'caret not found' };
              caret.click();
              return { clicked: true };
            }
          }
        }
        return { error: 'user article not found' };
      })()
    `);

    if (!caretResult || !caretResult.clicked) {
      return false;
    }

    // Wait for menu to appear
    await sleep(800);

    // Step 2: Find and click the "Block/屏蔽" menu item
    const blockResult = await cdp.evaluate(sessionId, `
      (function() {
        var items = document.querySelectorAll('[role="menu"] [role="menuitem"]');
        for (var i = 0; i < items.length; i++) {
          if (items[i].textContent.includes('Block') || items[i].textContent.includes('屏蔽')) {
            items[i].click();
            return { clicked: true };
          }
        }
        return { error: 'block menu item not found' };
      })()
    `);

    if (!blockResult || !blockResult.clicked) {
      // Dismiss menu
      await cdp.evaluate(sessionId, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',keyCode:27,bubbles:true}))`);
      return false;
    }

    // Wait for confirm dialog to appear
    await sleep(800);

    // Step 3: Click the confirm button
    const confirmResult = await cdp.evaluate(sessionId, `
      (function() {
        var btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
        if (btn) {
          btn.click();
          return { clicked: true };
        }
        return { error: 'confirm button not found' };
      })()
    `);

    if (confirmResult && confirmResult.clicked) {
      // Wait for dialog to close and block to take effect
      await sleep(1000);
      addBlockedUser(username, null, reason || null);
      return true;
    }

    // Confirm button not found — dismiss any open UI
    await cdp.evaluate(sessionId, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',keyCode:27,bubbles:true}))`);
    return false;

  } finally {
    // Dismiss any leftover UI
    await cdp.evaluate(sessionId, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',keyCode:27,bubbles:true}))`);

    // Restore scroll position
    const currentScrollY = await cdp.evaluate(sessionId, 'window.scrollY');
    if (savedScrollY !== currentScrollY) {
      await cdp.evaluate(sessionId, `window.scrollTo(0, ${savedScrollY})`);
    }
  }
}

module.exports = { blockUsers, blockSingleUser: blockUserOnPage, cancel };
