import { showStatus, apiInvoke, el } from '../ui.js';

const { ipcRenderer } = require('electron');

export default class UserBlockView {
  constructor() {
    this.blocking = false;
    this.bindEvents();
    this.checkModel();
  }

  bindEvents() {
    document.getElementById('btn-block-start').addEventListener('click', () => this.start());
    document.getElementById('btn-block-all').addEventListener('click', () => this.blockAll());
    document.getElementById('btn-block-cancel').addEventListener('click', () => this.cancel());
    document.getElementById('threshold-slider').addEventListener('input', (e) => {
      document.getElementById('threshold-value').textContent = e.target.value;
    });

    ipcRenderer.on('block:progress', (event, progress) => {
      if (!this.blocking) return;
      this.renderProgress(progress);
    });
  }

  async checkModel() {
    const res = await apiInvoke('model:status');
    const el = document.getElementById('model-info');
    const loadArea = document.getElementById('model-load-area');
    if (res.loaded) {
      el.className = 'model-status loaded';
      el.innerHTML = '模型已加载';
      if (res.metrics) {
        el.innerHTML += ` — F1 分数: ${res.metrics.eval_f1?.toFixed(3) || 'N/A'}`;
      }
      if (loadArea) loadArea.style.display = 'none';
    } else {
      el.className = 'model-status not-loaded';
      el.innerHTML = '模型未加载 — 请先用 Python 训练模型（参见「导出数据」页面）';
      if (loadArea) {
        loadArea.style.display = 'block';
        const btn = document.getElementById('btn-load-model');
        btn.onclick = async () => {
          btn.textContent = '正在加载...';
          btn.disabled = true;
          await apiInvoke('model:load');
          this.checkModel();
        };
      }
    }
  }

  async start() {
    const url = document.getElementById('block-url').value.trim();
    if (!url || !url.includes('x.com')) {
      showStatus('block-status', '请输入有效的 X.com 链接', false);
      return;
    }

    this.blocking = true;
    document.getElementById('btn-block-start').style.display = 'none';
    document.getElementById('btn-block-all').style.display = 'none';
    document.getElementById('btn-block-cancel').style.display = 'inline-flex';
    document.getElementById('block-log').innerHTML = '';
    document.getElementById('block-progress-area').style.display = 'block';
    showStatus('block-status', '正在扫描并拉黑垃圾评论...');

    const threshold = parseFloat(document.getElementById('threshold-slider').value);
    const res = await apiInvoke('block:start', url, { threshold });

    this.blocking = false;
    document.getElementById('btn-block-start').style.display = 'inline-flex';
    document.getElementById('btn-block-all').style.display = 'inline-flex';
    document.getElementById('btn-block-cancel').style.display = 'none';
    document.getElementById('block-progress-area').style.display = 'none';

    if (res.success) {
      showStatus('block-status',
        `完成！扫描 ${res.scanned} 条评论，发现 ${res.spam} 条垃圾，拉黑 ${res.blocked} 个用户`);
    } else {
      showStatus('block-status', '失败：' + res.error, false);
    }
  }

  async blockAll() {
    const url = document.getElementById('block-url').value.trim();
    if (!url || !url.includes('x.com')) {
      showStatus('block-status', '请输入有效的 X.com 链接', false);
      return;
    }

    this.blocking = true;
    document.getElementById('btn-block-start').style.display = 'none';
    document.getElementById('btn-block-all').style.display = 'none';
    document.getElementById('btn-block-cancel').style.display = 'inline-flex';
    document.getElementById('block-log').innerHTML = '';
    document.getElementById('block-progress-area').style.display = 'block';
    showStatus('block-status', '正在扫描并全部拉黑...');

    const res = await apiInvoke('block:all', document.getElementById('block-url').value.trim());

    this.blocking = false;
    document.getElementById('btn-block-start').style.display = 'inline-flex';
    document.getElementById('btn-block-all').style.display = 'inline-flex';
    document.getElementById('btn-block-cancel').style.display = 'none';
    document.getElementById('block-progress-area').style.display = 'none';

    if (res.success) {
      showStatus('block-status',
        `完成！扫描 ${res.scanned} 条评论，拉黑 ${res.blocked} 个用户`);
    } else {
      showStatus('block-status', '失败：' + res.error, false);
    }
  }

  async cancel() {
    await apiInvoke('block:cancel');
    this.blocking = false;
    document.getElementById('btn-block-start').style.display = 'inline-flex';
    document.getElementById('btn-block-all').style.display = 'inline-flex';
    document.getElementById('btn-block-cancel').style.display = 'none';
    document.getElementById('block-progress-area').style.display = 'none';
    showStatus('block-status', '已取消');
  }

  renderProgress(p) {
    const log = document.getElementById('block-log');
    const logLine = el('div', { className: 'log-line' });

    if (p.phase === 'scraping') {
      const pct = p.total > 0 ? Math.round((p.scroll / p.total) * 100) : 0;
      document.getElementById('block-bar').style.width = pct + '%';
      document.getElementById('block-progress-text').textContent =
        `正在采集评论：${p.found} 条 / ${p.scroll} 次滚动`;
      logLine.textContent = `📥 采集到 ${p.found} 条评论...`;
    } else if (p.phase === 'predicting') {
      document.getElementById('block-bar').style.background = 'var(--accent)';
      document.getElementById('block-bar').style.width = '100%';
      document.getElementById('block-progress-text').textContent =
        `模型预测中：${p.total} 条，${p.spam} 条疑似垃圾`;
      logLine.textContent = `🧠 模型识别出 ${p.spam} 条垃圾评论`;
      logLine.className += ' spam';
    } else if (p.phase === 'blocking') {
      const pct = p.total > 0 ? Math.round((p.scanned / p.total) * 100) : 0;
      document.getElementById('block-bar').style.background = 'var(--danger)';
      document.getElementById('block-bar').style.width = pct + '%';
      document.getElementById('block-progress-text').textContent =
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
