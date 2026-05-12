const { ipcMain } = require('electron');
const path = require('path');
const db = require('../database');

function register() {
  ipcMain.handle('app:paths', async () => {
    const workDir = path.join(__dirname, '..', '..', '..');
    return { workDir };
  });

  ipcMain.handle('settings:get-all', async () => {
    try {
      return { success: true, settings: db.getAllSettings() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('settings:set', async (event, key, value) => {
    try {
      db.setSetting(key, value);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { register };
