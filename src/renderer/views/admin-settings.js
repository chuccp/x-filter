import { showStatus, apiInvoke } from '../ui.js';
import { t } from '../../i18n/index.js';

export default class AdminSettingsView {
  constructor() {
    this.bindEvents();
    this.loadSettings();
  }

  bindEvents() {
    document.getElementById('btn-save-settings').addEventListener('click', () => this.save());
    document.getElementById('btn-settings-export').addEventListener('click', () => this.exportCsv());
    document.getElementById('setting-spam_threshold').addEventListener('input', (e) => {
      document.getElementById('setting-spam_threshold-value').textContent = e.target.value;
    });
    document.addEventListener('language-changed', () => this.loadSettings());
  }

  async loadSettings() {
    const res = await apiInvoke('settings:get-all');
    if (res.success) {
      for (const [k, v] of Object.entries(res.settings)) {
        const el = document.getElementById('setting-' + k);
        if (el) {
          el.value = v;
          const display = document.getElementById('setting-' + k + '-value');
          if (display) display.textContent = v;
        }
      }
    }

    const modelRes = await apiInvoke('model:status');
    const modelEl = document.getElementById('settings-model');
    if (modelRes.loaded) {
      modelEl.innerHTML = `<span style="color:var(--success)">${t('settings.model_loaded')}</span>`;
      if (modelRes.metrics) {
        modelEl.innerHTML += ` — F1: ${modelRes.metrics.eval_f1?.toFixed(3) || 'N/A'}`;
      }
    } else {
      modelEl.innerHTML = `<span style="color:var(--text-muted)">${t('settings.model_not_loaded')}</span> — ${modelRes.error || t('settings.model_default_error')} `
        + `<button class="btn btn-sm" id="btn-settings-load-model">${t('settings.btn_load_model')}</button>`;
      document.getElementById('btn-settings-load-model').addEventListener('click', async () => {
        modelEl.innerHTML = t('settings.loading_model');
        await apiInvoke('model:load');
        this.loadSettings();
      });
    }
  }

  async save() {
    const keys = ['max_scroll', 'scroll_delay', 'spam_threshold'];
    for (const key of keys) {
      const el = document.getElementById('setting-' + key);
      if (el) await apiInvoke('settings:set', key, el.value);
    }
    showStatus('settings-status', t('settings.saved'));
  }

  async exportCsv() {
    showStatus('settings-status', t('settings.exporting'));
    const res = await apiInvoke('export:csv');
    if (res.success) {
      const header = 'text,post_text,label\n';
      const rows = res.rows.map(r => `"${r.text.replace(/"/g, '""')}","${(r.post_text || '').replace(/"/g, '""')}",${r.label}`).join('\n');
      const { clipboard } = require('electron');
      clipboard.writeText(header + rows);
      showStatus('settings-status', t('settings.csv_copied', { count: res.rows.length }));
    } else {
      showStatus('settings-status', t('settings.export_fail', { error: res.error }), false);
    }
  }
}
