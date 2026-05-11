import { showStatus, apiInvoke } from '../ui.js';

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
      modelEl.innerHTML = '<span style="color:var(--success)">模型已加载</span>';
      if (modelRes.metrics) {
        modelEl.innerHTML += ` — F1: ${modelRes.metrics.eval_f1?.toFixed(3) || 'N/A'}`;
      }
    } else {
      modelEl.innerHTML = `<span style="color:var(--text-muted)">模型未加载</span> — ${modelRes.error || '请先运行 train.py 训练模型'}`;
    }
  }

  async save() {
    const keys = ['max_scroll', 'scroll_delay', 'spam_threshold'];
    for (const key of keys) {
      const el = document.getElementById('setting-' + key);
      if (el) await apiInvoke('settings:set', key, el.value);
    }
    showStatus('settings-status', '设置已保存');
  }

  async exportCsv() {
    showStatus('settings-status', '正在导出...');
    const res = await apiInvoke('export:csv');
    if (res.success) {
      const header = 'text,label\n';
      const rows = res.rows.map(r => `"${r.text.replace(/"/g, '""')}",${r.label}`).join('\n');
      const { clipboard } = require('electron');
      clipboard.writeText(header + rows);
      showStatus('settings-status', `已复制 ${res.rows.length} 条评论到剪贴板`);
    } else {
      showStatus('settings-status', '导出失败：' + res.error, false);
    }
  }
}
