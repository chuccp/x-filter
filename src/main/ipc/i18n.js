const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { getSetting, setSetting } = require('../database');
const { loadLanguage: loadMainLang } = require('../i18n');

function register() {
  ipcMain.handle('i18n:load', async (_event, lang) => {
    const filePath = path.join(__dirname, '..', '..', 'i18n', `${lang}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error(`[i18n] Failed to load ${lang}:`, e.message);
      const fallbackPath = path.join(__dirname, '..', '..', 'i18n', 'zh-CN.json');
      return JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    }
  });

  ipcMain.handle('i18n:get-language', async () => {
    return getSetting('language') || 'zh-CN';
  });

  ipcMain.handle('i18n:set-language', async (_event, lang) => {
    setSetting('language', lang);
    loadMainLang(lang);
    return true;
  });
}

module.exports = { register };
