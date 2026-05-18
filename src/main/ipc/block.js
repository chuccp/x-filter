const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const db = require('../database');
const scraper = require('../x-scraper');
const modelManager = require('../model-manager');
const blocker = require('../x-blocker');
const { t } = require('../i18n');

function register() {
  async function resolveTargets(url, win) {
    const targets = scraper.isProfileUrl(url)
      ? await scraper.scrapeProfilePosts(url, (p) => {
          if (win) win.webContents.send('block:progress', { phase: 'listing', ...p });
        })
      : [url];
    return targets;
  }

  async function runBlockSession(win, postUrl, index, total, options) {
    const { filterFn, afterFilter, afterBlock } = options;
    const sessionId = db.createBlockSession(postUrl);
    if (win) {
      win.webContents.send('block:progress', {
        phase: 'status',
        text: t('block.scanning_post', { i: index + 1, total }),
      });
    }

    const { comments } = await scraper.scrapeComments(postUrl, (progress) => {
      if (win) win.webContents.send('block:progress', { phase: 'scraping', ...progress, postIndex: index + 1, postTotal: total });
    });

    if (comments.length === 0) {
      db.completeBlockSession(sessionId, { comments_scanned: 0, spam_detected: 0, users_blocked: 0, errors: 0 });
      return { scanned: 0, matched: 0, blocked: 0, errors: 0 };
    }

    let matched = comments;
    if (filterFn) {
      matched = await filterFn(comments);
    }

    if (afterFilter) {
      await afterFilter(comments, matched);
    }

    const result = await blocker.blockUsers(postUrl, matched, (progress) => {
      if (win) win.webContents.send('block:progress', progress);
    });

    if (afterBlock) {
      await afterBlock(matched, result);
    }

    db.completeBlockSession(sessionId, {
      comments_scanned: comments.length,
      spam_detected: matched.length,
      users_blocked: result.blocked,
      errors: result.errors,
    });

    return { scanned: comments.length, matched: matched.length, blocked: result.blocked, errors: result.errors };
  }

  ipcMain.handle('block:start', async (event, url, options) => {
    try {
      const threshold = options?.threshold || parseFloat(db.getSetting('spam_threshold')) || 0.8;
      const win = BrowserWindow.fromWebContents(event.sender);

      if (!modelManager.getStatus().loaded) {
        return { success: false, error: t('block.model_not_loaded') };
      }

      const targets = await resolveTargets(url, win);
      if (targets.length === 0) {
        return { success: true, scanned: 0, spam: 0, blocked: 0 };
      }

      let totalScanned = 0, totalSpam = 0, totalBlocked = 0, totalErrors = 0;

      for (let i = 0; i < targets.length; i++) {
        const filterFn = async (comments) => {
          const predictions = await modelManager.predictBatch(
            comments.map(c => ({ text: c.text, post_text: c.post_text }))
          );
          return comments.filter((c, j) => predictions[j] && predictions[j].spam && predictions[j].confidence >= threshold);
        };

        const result = await runBlockSession(win, targets[i], i, targets.length, {
          filterFn,
          afterFilter: (comments, matched) => {
            if (win) {
              win.webContents.send('block:progress', {
                phase: 'predicting',
                total: comments.length,
                spam: matched.length,
                postIndex: i + 1,
                postTotal: targets.length,
              });
            }
          },
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
      const targets = await resolveTargets(url, win);

      let totalScanned = 0, totalBlocked = 0, totalErrors = 0;

      for (let i = 0; i < targets.length; i++) {
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

      const targets = await resolveTargets(url, win);

      let totalScanned = 0, totalMatched = 0, totalBlocked = 0, totalErrors = 0;

      for (let i = 0; i < targets.length; i++) {
        const result = await runBlockSession(win, targets[i], i, targets.length, {
          filterFn: (comments) => comments.filter(c => {
            const u = (c.username || '').toLowerCase();
            return blocklist.some(b => b === u);
          }),
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
