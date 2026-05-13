const { ipcRenderer } = require('electron');

let translations = {};
let currentLanguage = 'zh-CN';

export function t(key, params = {}) {
  let text = translations[key];
  if (text === undefined) {
    console.warn(`[i18n] Missing key: ${key}`);
    return key;
  }
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
  }
  return text;
}

export function scanDOM(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
}

export async function loadLanguage(lang) {
  try {
    const data = await ipcRenderer.invoke('i18n:load', lang);
    translations = data;
    currentLanguage = lang;
    scanDOM();
    document.documentElement.lang = lang;
    window.dispatchEvent(new CustomEvent('language-changed', { detail: { language: lang } }));
    await ipcRenderer.invoke('i18n:set-language', lang);
  } catch (e) {
    console.error('[i18n] Failed to load language:', lang, e);
  }
}

export async function init() {
  const lang = await ipcRenderer.invoke('i18n:get-language');
  await loadLanguage(lang || 'zh-CN');
}
