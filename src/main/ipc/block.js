const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const db = require('../database');
const cdp = require('../cdp-manager');
const scraper = require('../x-scraper');
const modelManager = require('../model-manager');
const blocker = require('../x-blocker');
const { t } = require('../i18n');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let sessionCancelFlag = false;

function register() {
  async function resolveTargets(url, win) {
    const targets = scraper.isProfileUrl(url)
      ? await scraper.scrapeProfilePosts(url, (p) => {
          if (win) win.webContents.send('block:progress', { phase: 'listing', ...p });
        })
      : [url];
    return targets;
  }

  /**
   * Streaming block session: scrape one comment → predict → block if spam.
   * This replaces the old batch flow (scrape all → predict all → block all)
   * to produce more natural timing between blocks.
   */
  async function runBlockSession(win, postUrl, index, total, options) {
    const { shouldBlockFn, afterBlock, blockDelay } = options;
    const blockSessionId = db.createBlockSession(postUrl);

    if (win) {
      win.webContents.send('block:progress', {
        phase: 'status',
        text: t('block.scanning_post', { i: index + 1, total }),
      });
    }

    // Set up CDP session — use the active/x.com tab
    const activeTab = await cdp.getActiveTab();
    if (!activeTab) {
      throw new Error(t('block.no_tabs'));
    }
    await cdp.activateTarget(activeTab.targetId);
    const cdpSessionId = await cdp.attachToTarget(activeTab.targetId);

    let scanned = 0;
    let matched = 0;
    let blocked = 0;
    let errors = 0;
    const matchedComments = [];

    try {
      await scraper.scrapeInSession(cdpSessionId, postUrl,
        async (comment) => {
          if (sessionCancelFlag) return;

          scanned++;

          // Determine if this comment should be blocked
          let shouldBlock = !shouldBlockFn; // Block all if no filter
          if (shouldBlockFn) {
            try {
              shouldBlock = await shouldBlockFn(comment);
            } catch (e) {
              shouldBlock = false;
            }
          }

          if (shouldBlock) {
            matched++;
            matchedComments.push(comment);

            if (win) {
              win.webContents.send('block:progress', {
                phase: 'blocking', scanned, matched, blocked, errors, username: comment.username,
              });
            }

            if (!db.isUserBlocked(comment.username)) {
              try {
                const result = await blocker.blockSingleUser(cdpSessionId, comment.username, comment.text);
                if (result) {
                  blocked++;
                  if (win) {
                    win.webContents.send('block:progress', {
                      phase: 'blocked', scanned, matched, blocked, errors, username: comment.username,
                    });
                  }
                }
              } catch (e) {
                errors++;
                if (win) {
                  win.webContents.send('block:progress', {
                    phase: 'error', scanned, matched, blocked, errors, error: e.message,
                  });
                }
              }

              // Delay after block attempt to avoid rapid-fire blocking
              await sleep(blockDelay || 3000);
            }
          } else {
            if (win) {
              win.webContents.send('block:progress', {
                phase: 'scanning', scanned, matched, blocked, errors, username: comment.username,
              });
            }
          }
        },
        (progress) => {
          if (win) {
            win.webContents.send('block:progress', {
              phase: 'scraping', ...progress, postIndex: index + 1, postTotal: total,
            });
          }
        }
      );
    } finally {
      try { await cdp.detachFromTarget(cdpSessionId); } catch (e) { /* ignore */ }
    }

    if (afterBlock) {
      await afterBlock(matchedComments, { blocked, errors });
    }

    db.completeBlockSession(blockSessionId, {
      comments_scanned: scanned,
      spam_detected: matched,
      users_blocked: blocked,
      errors,
    });

    return { scanned, matched, blocked, errors };
  }

  ipcMain.handle('block:start', async (event, url, options) => {
    try {
      const threshold = options?.threshold || parseFloat(db.getSetting('spam_threshold')) || 0.8;
      const win = BrowserWindow.fromWebContents(event.sender);

      if (!modelManager.getStatus().loaded) {
        return { success: false, error: t('block.model_not_loaded') };
      }

      sessionCancelFlag = false;
      const targets = await resolveTargets(url, win);
      if (targets.length === 0) {
        return { success: true, scanned: 0, spam: 0, blocked: 0 };
      }

      let totalScanned = 0, totalSpam = 0, totalBlocked = 0, totalErrors = 0;

      for (let i = 0; i < targets.length; i++) {
        if (sessionCancelFlag) break;

        // Per-comment prediction using single predict() instead of predictBatch
        const shouldBlockFn = async (comment) => {
          const prediction = await modelManager.predict(comment.text, comment.post_text);
          return prediction.spam && prediction.confidence >= threshold;
        };

        const result = await runBlockSession(win, targets[i], i, targets.length, {
          shouldBlockFn,
          afterBlock: (matched) => {
            db.markMultipleBlockedInBlocklist(matched.map(c => c.username));
          },
        });

        totalScanned += result.scanned;
        totalSpam += result.matched;
        totalBlocked += result.blocked;
        totalErrors += result.errors;
      }

      if (win) {
        win.webContents.send('block:progress', {
          phase: 'status',
          text: t('block.all_done', { scanned: totalScanned, spam: totalSpam, blocked: totalBlocked }),
        });
      }

      return { success: true, scanned: totalScanned, spam: totalSpam, blocked: totalBlocked, errors: totalErrors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('block:all', async (event, url) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      sessionCancelFlag = false;

      const targets = await resolveTargets(url, win);

      let totalScanned = 0, totalBlocked = 0, totalErrors = 0;

      for (let i = 0; i < targets.length; i++) {
        if (sessionCancelFlag) break;

        // No shouldBlockFn = block all commenters
        const result = await runBlockSession(win, targets[i], i, targets.length, {
          afterBlock: (matched) => {
            db.markMultipleBlockedInBlocklist(matched.map(c => c.username));
          },
        });

        totalScanned += result.scanned;
        totalBlocked += result.blocked;
        totalErrors += result.errors;
      }

      return { success: true, scanned: totalScanned, blocked: totalBlocked, errors: totalErrors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('block:cancel', async () => {
    sessionCancelFlag = true;
    blocker.cancel();
    scraper.cancel();
    return { success: true };
  });

  // ── Blocklist ───────────────────────────────────────────────

  ipcMain.handle('blocklist:get', async () => {
    try {
      return { success: true, entries: db.getBlocklist() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:add', async (event, username) => {
    try {
      const added = db.addToBlocklist(username);
      return { success: true, added, count: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:remove', async (event, username) => {
    try {
      db.removeFromBlocklist(username);
      return { success: true, count: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:clear', async () => {
    try {
      db.clearBlocklist();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:import', async (event, text) => {
    try {
      const usernames = text.split(/[\n,]+/).filter(Boolean);
      const count = db.importBlocklist(usernames);
      return { success: true, count, total: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:import-file', async (event) => {
    try {
      const { dialog } = require('electron');
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: t('common.dialog_import_title'),
        filters: [
          { name: t('common.dialog_text_file'), extensions: ['txt', 'csv'] },
          { name: t('common.dialog_all_files'), extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'cancelled' };
      }
      const content = fs.readFileSync(result.filePaths[0], 'utf-8');
      const usernames = content.split(/[\n,]+/).filter(Boolean);
      const count = db.importBlocklist(usernames);
      return { success: true, count, total: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:export', async () => {
    try {
      const entries = db.getBlocklist();
      const text = entries.map(e => e.username).join('\n');
      return { success: true, text };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:export-file', async (event) => {
    try {
      const { dialog } = require('electron');
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win, {
        title: t('common.dialog_export_title'),
        defaultPath: t('common.default_filename'),
        filters: [
          { name: t('common.dialog_text_file'), extensions: ['txt'] },
          { name: t('common.dialog_all_files'), extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'cancelled' };
      }
      const entries = db.getBlocklist();
      const text = entries.map(e => e.username).join('\n');
      fs.writeFileSync(result.filePath, text);
      return { success: true, path: result.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:block', async (event, url) => {
    try {
      const entries = db.getBlocklist();
      if (entries.length === 0) {
        return { success: false, error: t('blocklist.empty_error') };
      }
      const blocklist = entries.map(e => e.username.toLowerCase());
      const win = BrowserWindow.fromWebContents(event.sender);
      sessionCancelFlag = false;

      const targets = await resolveTargets(url, win);

      let totalScanned = 0, totalMatched = 0, totalBlocked = 0, totalErrors = 0;

      for (let i = 0; i < targets.length; i++) {
        if (sessionCancelFlag) break;

        const shouldBlockFn = (comment) => {
          const u = (comment.username || '').toLowerCase();
          return blocklist.some(b => b === u);
        };

        const result = await runBlockSession(win, targets[i], i, targets.length, {
          shouldBlockFn,
          afterBlock: (matched) => {
            db.markMultipleBlockedInBlocklist(matched.map(c => c.username));
          },
        });

        totalScanned += result.scanned;
        totalMatched += result.matched;
        totalBlocked += result.blocked;
        totalErrors += result.errors;
      }

      return { success: true, scanned: totalScanned, matched: totalMatched, blocked: totalBlocked, errors: totalErrors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { register };
