import { showStatus, apiInvoke, el } from '../ui.js';

const { ipcRenderer } = require('electron');

export default class UserBlocklistView {
  constructor() {
    this.blocking = false;
    this.bindEvents();
    this.loadBlocklist();
  }

  // ── Events ─────────────────────────────────────────────

  bindEvents() {
    // Toolbar buttons → open modals
    document.getElementById('btn-blocklist-add').addEventListener('click', () => this.openAddModal());
    document.getElementById('btn-blocklist-import').addEventListener('click', () => this.openImportModal());
    document.getElementById('btn-blocklist-export').addEventListener('click', () => this.handleExport());
    document.getElementById('btn-blocklist-block').addEventListener('click', () => this.openBlockModal());
    document.getElementById('btn-blocklist-clear').addEventListener('click', () => this.handleClear());

    // Modal close buttons (data-close attribute)
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.closeModal(btn.dataset.close));
    });
    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.closeModal(overlay.id);
      });
    });

    // Modal action buttons
    document.getElementById('modal-add-confirm').addEventListener('click', () => this.handleAdd());
    document.getElementById('modal-add-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleAdd();
    });
    document.getElementById('modal-import-file').addEventListener('click', () => this.handleImportFile());
    document.getElementById('modal-import-confirm').addEventListener('click', () => this.handleImportText());
    document.getElementById('modal-block-start').addEventListener('click', () => this.handleBlock());
    document.getElementById('modal-block-cancel-btn').addEventListener('click', () => this.cancelBlock());

    // Progress events for blocking
    ipcRenderer.on('block:progress', (event, progress) => {
      if (!this.blocking) return;
      this.renderProgress(progress);
    });
  }

  // ── Modal helpers ─────────────────────────────────────

  openModal(id) {
    document.getElementById(id).style.display = 'flex';
    if (id === 'modal-add') {
      document.getElementById('modal-add-input').value = '';
      setTimeout(() => document.getElementById('modal-add-input').focus(), 100);
    }
    if (id === 'modal-block') {
      document.getElementById('modal-block-status').textContent = '';
      document.getElementById('modal-block-status').className = 'status-line';
      document.getElementById('modal-block-log').innerHTML = '';
      document.getElementById('modal-block-log').style.display = 'none';
      document.getElementById('modal-block-progress').style.display = 'none';
      document.getElementById('modal-block-start').style.display = 'inline-flex';
      document.getElementById('modal-block-cancel-btn').style.display = 'none';
      document.getElementById('modal-block-close-btn').style.display = 'inline-flex';
      this.blocking = false;
    }
  }

  closeModal(id) {
    if (this.blocking && id === 'modal-block') return; // don't close while blocking
    document.getElementById(id).style.display = 'none';
  }

  // ── Blocklist table ───────────────────────────────────

  async loadBlocklist() {
    const res = await apiInvoke('blocklist:get');
    if (res.success) this.renderTable(res.entries);
  }

  renderTable(entries) {
    const container = document.getElementById('blocklist-table-container');
    const count = document.getElementById('blocklist-count');
    const blockedCount = entries.filter(e => e.is_blocked).length;
    count.textContent = `${entries.length} 人（已拉黑 ${blockedCount}）`;

    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-state" id="blocklist-empty">名单为空，请添加或导入用户名</div>';
      return;
    }

    const table = el('table', { className: 'data-table' });
    const thead = el('thead', {},
      el('tr', {},
        el('th', {}, '用户名'),
        el('th', {}, '状态'),
        el('th', { style: 'width:60px;text-align:center' }, '操作'),
      )
    );
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const e of entries) {
      const statusTag = e.is_blocked
        ? el('span', { className: 'tag-blocked' }, '已拉黑')
        : el('span', { className: 'tag-pending' }, '待拉黑');

      const tr = el('tr', {},
        el('td', { className: 'col-user' }, '@' + e.username),
        el('td', {}, statusTag),
        el('td', { style: 'text-align:center' },
          el('button', {
            className: 'btn btn-sm btn-outline',
            style: 'padding:2px 10px;font-size:11px',
            onClick: () => this.handleRemove(e.username),
          }, '删除'),
        ),
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    container.innerHTML = '';
    container.appendChild(table);
  }

  // ── Actions ───────────────────────────────────────────

  async handleAdd() {
    const input = document.getElementById('modal-add-input');
    const username = input.value.trim();
    if (!username) return;
    const res = await apiInvoke('blocklist:add', username);
    if (res.success) {
      this.closeModal('modal-add');
      this.loadBlocklist();
    }
  }

  async handleRemove(username) {
    await apiInvoke('blocklist:remove', username);
    this.loadBlocklist();
  }

  async handleClear() {
    await apiInvoke('blocklist:clear');
    this.loadBlocklist();
  }

  // ── Import ────────────────────────────────────────────

  openImportModal() {
    document.getElementById('modal-import-text').value = '';
    document.getElementById('modal-import-path').textContent = '';
    document.getElementById('modal-import-path').className = 'status-line';
    document.getElementById('modal-import').style.display = 'flex';
  }

  async handleImportFile() {
    const res = await apiInvoke('blocklist:import-file');
    if (res.success) {
      document.getElementById('modal-import-path').textContent = `已加载 ${res.total} 条`;
      document.getElementById('modal-import-path').className = 'status-line success';
      this.loadBlocklist();
    } else if (res.error !== 'cancelled') {
      document.getElementById('modal-import-path').textContent = res.error;
      document.getElementById('modal-import-path').className = 'status-line error';
    }
  }

  async handleImportText() {
    const text = document.getElementById('modal-import-text').value.trim();
    if (!text) return;
    const res = await apiInvoke('blocklist:import', text);
    if (res.success) {
      document.getElementById('modal-import-text').value = '';
      document.getElementById('modal-import-path').textContent = `已导入 ${res.count} 条，共 ${res.total} 条`;
      document.getElementById('modal-import-path').className = 'status-line success';
      this.loadBlocklist();
    } else {
      document.getElementById('modal-import-path').textContent = res.error;
      document.getElementById('modal-import-path').className = 'status-line error';
    }
  }

  // ── Export ────────────────────────────────────────────

  async handleExport() {
    await apiInvoke('blocklist:export-file');
  }

  // ── Block ─────────────────────────────────────────────

  openBlockModal() {
    const urlInput = document.getElementById('modal-block-url');
    // Pre-fill from the block view if empty
    if (!urlInput.value.trim()) {
      const blockUrl = document.getElementById('block-url');
      if (blockUrl && blockUrl.value.trim()) {
        urlInput.value = blockUrl.value.trim();
      }
    }
    this.openModal('modal-block');
  }

  async handleBlock() {
    const url = document.getElementById('modal-block-url').value.trim();
    if (!url || !url.includes('x.com')) {
      showStatus('modal-block-status', '请输入有效的 X.com 链接', false);
      return;
    }

    this.blocking = true;
    document.getElementById('modal-block-start').style.display = 'none';
    document.getElementById('modal-block-cancel-btn').style.display = 'inline-flex';
    document.getElementById('modal-block-close-btn').style.display = 'none';
    document.getElementById('modal-block-log').innerHTML = '';
    document.getElementById('modal-block-log').style.display = 'block';
    document.getElementById('modal-block-progress').style.display = 'block';
    document.getElementById('modal-block-bar').style.width = '0%';
    document.getElementById('modal-block-bar').style.background = 'var(--primary)';
    showStatus('modal-block-status', '正在扫描评论并匹配名单...');

    const res = await apiInvoke('blocklist:block', url);

    this.blocking = false;
    document.getElementById('modal-block-start').style.display = 'inline-flex';
    document.getElementById('modal-block-cancel-btn').style.display = 'none';
    document.getElementById('modal-block-close-btn').style.display = 'inline-flex';

    if (res.success) {
      showStatus('modal-block-status',
        `完成！扫描 ${res.scanned} 条，匹配 ${res.matched || 0} 条，拉黑 ${res.blocked} 个用户`);
      this.loadBlocklist();
    } else {
      showStatus('modal-block-status', '失败：' + res.error, false);
    }
  }

  async cancelBlock() {
    await apiInvoke('block:cancel');
    this.blocking = false;
    document.getElementById('modal-block-start').style.display = 'inline-flex';
    document.getElementById('modal-block-cancel-btn').style.display = 'none';
    document.getElementById('modal-block-close-btn').style.display = 'inline-flex';
    showStatus('modal-block-status', '已取消');
  }

  // ── Progress in modal ─────────────────────────────────

  renderProgress(p) {
    const log = document.getElementById('modal-block-log');
    const logLine = el('div', { className: 'log-line' });

    if (p.phase === 'scraping') {
      const pct = p.total > 0 ? Math.round((p.scroll / p.total) * 100) : 0;
      document.getElementById('modal-block-bar').style.width = pct + '%';
      document.getElementById('modal-block-progress-text').textContent =
        `正在采集评论：${p.found} 条 / ${p.scroll} 次滚动`;
      logLine.textContent = `📥 采集到 ${p.found} 条评论...`;
    } else if (p.phase === 'blocking') {
      const pct = p.total > 0 ? Math.round((p.scanned / p.total) * 100) : 0;
      document.getElementById('modal-block-bar').style.background = 'var(--danger)';
      document.getElementById('modal-block-bar').style.width = pct + '%';
      document.getElementById('modal-block-progress-text').textContent =
        `正在拉黑：${p.scanned}/${p.total} — 已拉黑 ${p.blocked}`;
      logLine.textContent = `⏳ 正在处理 @${p.username}...`;
    } else if (p.phase === 'blocked') {
      logLine.textContent = `🚫 已拉黑 @${p.username}`;
      logLine.className += ' spam';
    } else if (p.phase === 'error') {
      logLine.textContent = `❌ 错误：${p.error}`;
    }

    log.appendChild(logLine);
    log.scrollTop = log.scrollHeight;
  }
}
