const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const db = require('../database');
const scraper = require('../x-scraper');
const modelManager = require('../model-manager');
const blocker = require('../x-blocker');

function register() {
  // ── Blocking ────────────────────────────────────────────────

  ipcMain.handle('block:start', async (event, url, options) => {
    try {
      const threshold = options?.threshold || parseFloat(db.getSetting('spam_threshold')) || 0.8;
      const sessionId = db.createBlockSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      if (!modelManager.getStatus().loaded) {
        return { success: false, error: 'Model not loaded. Load a model first or train one with train.py.' };
      }

      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('block:progress', { phase: 'scraping', ...progress });
      });

      if (comments.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: 0, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: 0, spam: 0, blocked: 0 };
      }

      const predictions = await modelManager.predictBatch(
        comments.map(c => ({ text: c.text, post_text: c.post_text }))
      );
      const spamComments = comments.filter((c, i) => predictions[i] && predictions[i].spam && predictions[i].confidence >= threshold);

      if (win) win.webContents.send('block:progress', { phase: 'predicting', total: comments.length, spam: spamComments.length });

      const result = await blocker.blockSpamUsers(url, spamComments, (progress) => {
        if (win) win.webContents.send('block:progress', progress);
      });

      db.completeBlockSession(sessionId, {
        comments_scanned: comments.length,
        spam_detected: spamComments.length,
        users_blocked: result.blocked,
        errors: result.errors,
      });

      db.markMultipleBlockedInBlocklist(spamComments.map(c => c.username));

      return { success: true, scanned: comments.length, spam: spamComments.length, blocked: result.blocked, errors: result.errors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('block:all', async (event, url) => {
    try {
      const sessionId = db.createBlockSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('block:progress', { phase: 'scraping', ...progress });
      });

      if (comments.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: 0, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: 0, blocked: 0 };
      }

      const result = await blocker.blockAllUsers(url, comments, (progress) => {
        if (win) win.webContents.send('block:progress', progress);
      });

      db.completeBlockSession(sessionId, {
        comments_scanned: comments.length,
        spam_detected: comments.length,
        users_blocked: result.blocked,
        errors: result.errors,
      });

      db.markMultipleBlockedInBlocklist(comments.map(c => c.username));

      return { success: true, scanned: comments.length, blocked: result.blocked, errors: result.errors };
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
        title: '导入拉黑名单',
        filters: [
          { name: '文本文件', extensions: ['txt', 'csv'] },
          { name: '所有文件', extensions: ['*'] },
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
        title: '导出拉黑名单',
        defaultPath: 'blocklist.txt',
        filters: [
          { name: '文本文件', extensions: ['txt'] },
          { name: '所有文件', extensions: ['*'] },
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
        return { success: false, error: '拉黑名单为空，请先添加用户名' };
      }
      const blocklist = entries.map(e => e.username);
      const sessionId = db.createBlockSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('block:progress', { phase: 'scraping', ...progress });
      });

      if (comments.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: 0, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: 0, blocked: 0 };
      }

      const matched = comments.filter(c => {
        const u = (c.username || '').toLowerCase();
        return blocklist.some(b => b.toLowerCase() === u);
      });

      if (matched.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: comments.length, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: comments.length, matched: 0, blocked: 0 };
      }

      db.markMultipleBlockedInBlocklist(matched.map(c => c.username));

      const result = await blocker.blockByList(url, matched, (progress) => {
        if (win) win.webContents.send('block:progress', progress);
      });

      db.completeBlockSession(sessionId, {
        comments_scanned: comments.length,
        spam_detected: matched.length,
        users_blocked: result.blocked,
        errors: result.errors,
      });

      return { success: true, scanned: comments.length, matched: matched.length, blocked: result.blocked, errors: result.errors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { register };
