const path = require('path');
const fs = require('fs');

let translations = {};
let currentLanguage = 'zh-CN';

function t(key, params = {}) {
  let text = translations[key];
  if (text === undefined) return key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
  }
  return text;
}

function loadLanguage(lang) {
  const filePath = path.join(__dirname, '..', 'i18n', `${lang}.json`);
  try {
    translations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    currentLanguage = lang;
  } catch (e) {
    console.error(`[i18n] Failed to load main language: ${lang}`, e.message);
  }
}

// Load default on startup
loadLanguage('zh-CN');

module.exports = { t, loadLanguage, getLanguage: () => currentLanguage };
