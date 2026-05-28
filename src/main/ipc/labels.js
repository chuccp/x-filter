const { ipcMain } = require('electron');
const db = require('../database');

function register() {
  ipcMain.handle('labels:get-unlabeled', async (event, limit, offset) => {
    try {
      const comments = db.getUnlabeledComments(limit || 20, offset || 0);
      return { success: true, comments };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:get-all', async (event, filter, limit, offset) => {
    try {
      const comments = db.getAllComments(filter || 'all', limit || 50, offset || 0);
      return { success: true, comments };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:set', async (event, id, label) => {
    try {
      db.setLabel(id, label);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:batch-set', async (event, ids, label) => {
    try {
      db.batchSetLabel(ids, label);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:delete', async (event, id) => {
    try {
      db.deleteComment(id);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:stats', async () => {
    try {
      return { success: true, stats: db.getLabelStats() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('export:csv', async () => {
    try {
      const rows = db.exportLabeledComments();
      return { success: true, rows };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { register };
