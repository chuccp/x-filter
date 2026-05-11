import { showStatus, apiInvoke, el } from '../ui.js';

const { ipcRenderer } = require('electron');

export default class UserBlocklistView {
  constructor() {
    this.blocking = false;
    this.bindEvents();
    this.loadBlocklist();
  }

  bindEvents() {
    document.getElementById('btn-blocklist-add').addEventListener('click', () => this.blocklistAdd());
    document.getElementById('blocklist-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.blocklistAdd();
    });
    document.getElementById('btn-blocklist-import').addEventListener('click', () => this.blocklistImport());
    document.getElementById('btn-blocklist-export').addEventListener('click', () => this.blocklistExport());
    document.getElementById('btn-blocklist-clear').addEventListener('click', () => this.blocklistClear());
    document.getElementById('btn-blocklist-block').addEventListener('click', () => this.blocklistBlock());
    document.getElementById('btn-blocklist-cancel').addEventListener('click', () => this.cancel());

    ipcRenderer.on('block:progress', (event, progress) => {
      if (!this.blocking) return;
      this.renderProgress(progress);
    });
  }

  // ── Blocklist management ──────────────────────────────────

  async loadBlocklist() {
    const res = await apiInvoke('blocklist:get');
    if (res.success) this.renderBlocklist(res.entries);
  }

  renderBlocklist(entries) {
    const container = document.getElementById('blocklist-entries');
    const count = document.getElementById('blocklist-count');
    const blockedCount = entries.filter(e => e.is_blocked).length;
    count.textContent = `${entries.length} 人（已拉黑 ${blockedCount}）`;

    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-state">名单为空，请添加或导入用户名</div>';
      return;
    }

    container.innerHTML = '';
    for (const e of entries) {
      const statusTag = e.is_blocked
        ? el('span', { className: 'tag-blocked' }, '已拉黑')
        : el('span', { className: 'tag-pending' }, '待拉黑');

      const row = el('div', { className: 'blocklist-row' },
        el('span', { className: 'blocklist-user' }, '@' + e.username),
        el('div', { style: 'display:flex;align-items:center;gap:8px' },
          statusTag,
          el('button', {
            className: 'btn btn-sm btn-outline blocklist-remove-btn',
            onClick: () => this.blocklistRemove(e.username),
          }, '删除'),
        ),
      );
      container.appendChild(row);
    }
  }

  async blocklistAdd() {
    const input = document.getElementById('blocklist-input');
    const username = input.value.trim();
    if (!username) return;
    const res = await apiInvoke('blocklist:add', username);
    if (res.success) {
      input.value = '';
      this.loadBlocklist();
    }
  }

  async blocklistRemove(username) {
    await apiInvoke('blocklist:remove', username);
    this.loadBlocklist();
  }

  async blocklistImport() {
    // Use file dialog to pick a .txt/.csv file
    const res = await apiInvoke('blocklist:import-file');
    if (res.success) {
      showStatus('blocklist-status', `已导入 ${res.count} 个用户名，名单共 ${res.total} 人`);
      this.loadBlocklist();
    } else if (res.error !== 'cancelled') {
      showStatus('blocklist-status', '导入失败：' + res.error, false);
    }
  }

  async blocklistExport() {
    const res = await apiInvoke('blocklist:export-file');
    if (res.success) {
      showStatus('blocklist-status', `名单已导出到 ${res.path}`);
    } else if (res.error !== 'cancelled') {
      showStatus('blocklist-status', '导出失败：' + res.error, false);
    }
  }

  async blocklistClear() {
    await apiInvoke('blocklist:clear');
    this.loadBlocklist();
  }

  // ── Block by list ───────────────────────────────────────

  async blocklistBlock() {
    const url = document.getElementById('blocklist-url').value.trim();
    if (!url || !url.includes('x.com')) {
      showStatus('blocklist-status', '请输入有效的 X.com 链接', false);
      return;
    }

    this.blocking = true;
    document.getElementById('btn-blocklist-block').style.display = 'none';
    document.getElementById('btn-blocklist-cancel').style.display = 'inline-flex';
    document.getElementById('blocklist-log').innerHTML = '';
    document.getElementById('blocklist-progress-area').style.display = 'block';
    showStatus('blocklist-status', '正在扫描评论并匹配名单...');

    const res = await apiInvoke('blocklist:block', url);

    this.blocking = false;
    document.getElementById('btn-blocklist-block').style.display = 'inline-flex';
    document.getElementById('btn-blocklist-cancel').style.display = 'none';
    document.getElementById('blocklist-progress-area').style.display = 'none';

    if (res.success) {
      showStatus('blocklist-status',
        `完成！扫描 ${res.scanned} 条评论，匹配名单 ${res.matched || 0} 条，拉黑 ${res.blocked} 个用户`);
      // Refresh list to update blocked status
      this.loadBlocklist();
    } else {
      showStatus('blocklist-status', '失败：' + res.error, false);
    }
  }

  async cancel() {
    await apiInvoke('block:cancel');
    this.blocking = false;
    document.getElementById('btn-blocklist-block').style.display = 'inline-flex';
    document.getElementById('btn-blocklist-cancel').style.display = 'none';
    document.getElementById('blocklist-progress-area').style.display = 'none';
    showStatus('blocklist-status', '已取消');
  }

  // ── Progress rendering ──────────────────────────────────

  renderProgress(p) {
    const log = document.getElementById('blocklist-log');
    const logLine = el('div', { className: 'log-line' });

    if (p.phase === 'scraping') {
      const pct = p.total > 0 ? Math.round((p.scroll / p.total) * 100) : 0;
      document.getElementById('blocklist-bar').style.width = pct + '%';
      document.getElementById('blocklist-progress-text').textContent =
        `正在采集评论：${p.found} 条 / ${p.scroll} 次滚动`;
      logLine.textContent = `📥 采集到 ${p.found} 条评论...`;
    } else if (p.phase === 'blocking') {
      const pct = p.total > 0 ? Math.round((p.scanned / p.total) * 100) : 0;
      document.getElementById('blocklist-bar').style.background = 'var(--danger)';
      document.getElementById('blocklist-bar').style.width = pct + '%';
      document.getElementById('blocklist-progress-text').textContent =
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
