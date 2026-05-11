import { showStatus, apiInvoke, el } from '../ui.js';

export default class AdminExportView {
  constructor() {
    this.bindEvents();
    this.refresh();
  }

  bindEvents() {
    document.getElementById('btn-export').addEventListener('click', () => this.exportCsv());
  }

  async refresh() {
    const res = await apiInvoke('labels:stats');
    if (res.success) {
      const s = res.stats;
      document.getElementById('export-stats').innerHTML = `
        <div class="stats-grid">
          <div class="stat-card"><span class="num">${s.spam}</span><span class="label">垃圾评论</span></div>
          <div class="stat-card"><span class="num">${s.not_spam}</span><span class="label">正常评论</span></div>
          <div class="stat-card"><span class="num">${s.total}</span><span class="label">总计</span></div>
        </div>`;
    }
  }

  async exportCsv() {
    showStatus('export-status', '正在导出...');
    const res = await apiInvoke('export:csv');
    if (res.success) {
      if (res.rows.length === 0) {
        showStatus('export-status', '没有可导出的已标注评论', false);
        return;
      }
      const header = 'text,label\n';
      const rows = res.rows.map(r => `"${r.text.replace(/"/g, '""')}",${r.label}`).join('\n');
      const csv = header + rows;

      document.getElementById('export-result').innerHTML = '';
      const textarea = el('textarea', {
        readonly: true,
        style: 'width:100%;height:200px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-size:12px;resize:vertical',
      }, csv);
      document.getElementById('export-result').appendChild(textarea);

      showStatus('export-status', `导出了 ${res.rows.length} 条评论。复制上方内容保存为 data/labeled.csv 用于训练`);
    } else {
      showStatus('export-status', '导出失败：' + res.error, false);
    }
  }
}
