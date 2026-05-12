const { ipcMain, BrowserWindow } = require('electron');
const db = require('../database');
const scraper = require('../x-scraper');

function register() {
  ipcMain.handle('scrape:start', async (event, url) => {
    try {
      const sessionId = db.createScrapeSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('scrape:progress', progress);
      });

      if (comments.length > 0) {
        const commentData = comments.map(c => ({ ...c, source_url: url }));
        const newCount = db.insertComments(commentData);
        db.completeScrapeSession(sessionId, newCount);
        return { success: true, count: newCount, total: comments.length };
      } else {
        db.completeScrapeSession(sessionId, 0);
        return { success: true, count: 0, total: 0 };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('scrape:cancel', async () => {
    scraper.cancel();
    return { success: true };
  });
}

module.exports = { register };
