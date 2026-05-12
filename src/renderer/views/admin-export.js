import { apiInvoke, el } from '../ui.js';

export default class AdminDataView {
  constructor() {
    this.filter = 'all';
    this.data = [];
    this.buildFilters();
    this.bindEvents();
    this.refresh();
  }

  buildFilters() {
    const container = document.getElementById('data-filters');
    if (!container) return;
    const filters = [
      { key: 'all', label: '全部' },
      { key: 'spam', label: '垃圾' },
      { key: 'not-spam', label: '正常' },
    ];
    container.innerHTML = '';
    for (const f of filters) {
      const btn = el('button', {
        className: 'filter-btn' + (f.key === this.filter ? ' active' : ''),
        'data-filter': f.key,
        onClick: () => this.setFilter(f.key),
      }, f.label);
      container.appendChild(btn);
    }
  }

  bindEvents() {
    const copyBtn = document.getElementById('btn-copy-csv');
    if (copyBtn) copyBtn.addEventListener('click', () => this.copyCsv());
    const refreshBtn = document.getElementById('btn-refresh-data');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.refresh());
  }

  async setFilter(filter) {
    this.filter = filter;
    document.querySelectorAll('#data-filters .filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    await this.loadData();
  }

  async refresh() {
    // Update stats
    const res = await apiInvoke('labels:stats');
    if (res.success) {
      const s = res.stats;
      const labeled = s.spam + s.not_spam;
      document.getElementById('export-stats').textContent =
        `垃圾${s.spam} 正常${s.not_spam} 已标注${labeled} 总计${s.total}`;
    }
    await this.loadData();
  }

  async loadData() {
    const res = await apiInvoke('labels:get-all', this.filter, 500, 0);
    if (res.success) {
      this.data = res.comments.filter(c => c.label !== null);
      this.renderTable();
    }
  }

  renderTable() {
    const container = document.getElementById('data-table-container');
    const empty = document.getElementById('data-empty');
    if (!container) return;

    if (this.data.length === 0) {
      container.innerHTML = '';
      container.appendChild(el('div', { className: 'empty-state', id: 'data-empty' },
        '还没有标注数据。先去「标注评论」吧！'));
      return;
    }

    const table = el('table', { className: 'data-table' });
    const thead = el('thead', {},
      el('tr', {},
        el('th', {}, '评论'),
        el('th', {}, '原文'),
        el('th', {}, '用户'),
        el('th', {}, '标签'),
      )
    );
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const c of this.data) {
      const labelTag = c.label === 1
        ? el('span', { className: 'tag-spam' }, '垃圾')
        : el('span', { className: 'tag-ok' }, '正常');

      const tr = el('tr', {},
        el('td', { className: 'col-text' }, c.text),
        el('td', { className: 'col-post' }, c.post_text || '-'),
        el('td', { className: 'col-user' }, '@' + c.username),
        el('td', { className: 'col-label' }, labelTag),
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    container.innerHTML = '';
    container.appendChild(table);
  }

  async copyCsv() {
    const res = await apiInvoke('export:csv');
    if (!res.success || res.rows.length === 0) return;
    const header = 'text,post_text,label\n';
    const rows = res.rows.map(r =>
      `"${r.text.replace(/"/g, '""')}","${(r.post_text || '').replace(/"/g, '""')}",${r.label}`
    ).join('\n');
    const { clipboard } = require('electron');
    clipboard.writeText(header + rows);
    // Brief visual feedback
    const btn = document.getElementById('btn-copy-csv');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '已复制！';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  }
}
