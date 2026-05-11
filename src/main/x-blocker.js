const cdp = require('./cdp-manager');

let cancelFlag = false;

function cancel() {
  cancelFlag = true;
}

async function blockAllUsers(sourceUrl, comments, onProgress) {
  cancelFlag = false;

  const targets = await cdp.getPageTargets();
  if (targets.length === 0) {
    throw new Error('No Chrome tabs open. Open X first.');
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

      const { isUserBlocked } = require('./database');
      if (isUserBlocked(c.username)) continue;

      const result = await blockUserOnPage(sessionId, c.username);
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

async function blockSpamUsers(sourceUrl, comments, onProgress) {
  cancelFlag = false;

  // Get an existing page or create one
  const targets = await cdp.getPageTargets();
  if (targets.length === 0) {
    throw new Error('No Chrome tabs open. Open X first.');
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

      // Skip already blocked
      const { isUserBlocked } = require('./database');
      if (isUserBlocked(c.username)) continue;

      // Attempt to block via DOM interaction on the post page
      const blocked = await blockUserOnPage(sessionId, c.username);
      if (blocked) {
        blocked++;
        if (onProgress) onProgress({ phase: 'blocked', scanned, blocked, errors, total: comments.length, username: c.username });
      }
    } catch (e) {
      errors++;
      if (onProgress) onProgress({ phase: 'error', scanned, blocked, errors, total: comments.length, error: e.message });
    }

    // Rate limit
    await sleep(2000);
  }

  await cdp.detachFromTarget(sessionId);
  return { scanned, blocked, errors };
}

async function blockUserOnPage(sessionId, username) {
  // Strategy: find the comment article for this user, open "...", click "Block"
  const script = `
    (async function() {
      // Find article containing this user's comment
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        const spans = article.querySelectorAll('span');
        let found = false;
        for (const span of spans) {
          if (span.textContent === '@${username}') {
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
              return { blocked: true, username: '${username}' };
            }
            return { blocked: true, username: '${username}' };
          }
        }
        return { error: 'block menu item not found' };
      }
      return { error: 'user article not found' };
    })()
  `;

  const result = await cdp.evaluate(sessionId, script);

  if (result && result.blocked) {
    const { addBlockedUser } = require('./database');
    const { getDb } = require('./database');
    addBlockedUser(username, null);
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { blockAllUsers, blockSpamUsers, cancel };
