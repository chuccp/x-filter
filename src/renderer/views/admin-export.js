import { apiInvoke, el } from '../ui.js';
import { t } from '../../i18n/index.js';

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
      { key: 'all', label: t('export.filter_all') },
      { key: 'spam', label: t('export.filter_spam') },
      { key: 'not-spam', label: t('export.filter_normal') },
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
    document.addEventListener('language-changed', () => {
      this.buildFilters();
      this.renderTable();
      this.refresh();
    });
  }

  async setFilter(filter) {
    this.filter = filter;
    document.querySelectorAll('#data-filters .filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    await this.loadData();
  }

  async refresh() {
    const res = await apiInvoke('labels:stats');
    if (res.success) {
      const s = res.stats;
      const labeled = s.spam + s.not_spam;
      document.getElementById('export-stats').textContent =
        t('export.stats', { spam: s.spam, not_spam: s.not_spam, labeled, total: s.total });
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
        t('export.empty')));
      return;
    }

    const table = el('table', { className: 'data-table' });
    const thead = el('thead', {},
      el('tr', {},
        el('th', {}, t('export.col_comment')),
        el('th', {}, t('export.col_post')),
        el('th', {}, t('export.col_user')),
        el('th', {}, t('export.col_label')),
      )
    );
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const c of this.data) {
      const labelTag = c.label === 1
        ? el('span', { className: 'tag-spam' }, t('export.tag_spam'))
        : el('span', { className: 'tag-ok' }, t('export.tag_normal'));

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
    const btn = document.getElementById('btn-copy-csv');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = t('export.copied');
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  }
}
