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

async function blockUserOnPage(sessionId, username, reason) {
  // Escape username for safe injection into the evaluated script
  const safeUsername = username.replace(/[\\"']/g, '\\$&');

  // Strategy: find the comment article for this user, open "...", click "Block"
  const script = `
    (async function() {
      // Find article containing this user's comment
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        const spans = article.querySelectorAll('span');
        let found = false;
        for (const span of spans) {
          if (span.textContent === '@${safeUsername}') {
            found = true;
            break;
          }
        }
        if (!found) continue;

        // Found the article. Click the caret "..." button
        const caret = article.querySelector('button[data-testid="caret"]');
        if (!caret) return { error: 'caret not found' };
        caret.click();
        await new Promise(r => setTimeout(r, 500));

        // Find "Block" menu item
        const menuItems = document.querySelectorAll('[role="menu"] [role="menuitem"]');
        for (const item of menuItems) {
          if (item.textContent.includes('Block') || item.textContent.includes('屏蔽')) {
            item.click();
            await new Promise(r => setTimeout(r, 500));

            // Confirm block dialog
            const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
            if (confirmBtn) {
              confirmBtn.click();
              await new Promise(r => setTimeout(r, 500));
              return { blocked: true, username: '${safeUsername}' };
            }
            return { blocked: true, username: '${safeUsername}' };
          }
        }
        return { error: 'block menu item not found' };
      }
      return { error: 'user article not found' };
    })()
  `;

  const result = await cdp.evaluate(sessionId, script);

  if (result && result.blocked) {
    addBlockedUser(username, null, reason || null);
    return true;
  }

  return false;
}

module.exports = { blockUsers, cancel };
