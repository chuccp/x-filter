import { showStatus, apiInvoke } from '../ui.js';

const { ipcRenderer } = require('electron');

export default class AdminCollectView {
  constructor() {
    this.scraping = false;
    this.bindEvents();
  }

  bindEvents() {
    document.getElementById('btn-scrape').addEventListener('click', () => this.start());
    document.getElementById('btn-cancel-scrape').addEventListener('click', () => this.cancel());

    ipcRenderer.on('scrape:progress', (event, progress) => {
      if (!this.scraping) return;
      const pct = Math.round((progress.scroll / progress.total) * 100);
      document.getElementById('scrape-bar').style.width = pct + '%';
      document.getElementById('scrape-progress-text').textContent =
        `已滚动 ${progress.scroll}/${progress.total} 次，发现 ${progress.found} 条评论`;
    });
  }

  async start() {
    const url = document.getElementById('collect-url').value.trim();
    if (!url || !url.includes('x.com')) {
      showStatus('scrape-status', '请输入有效的 X.com 链接', false);
      return;
    }

    this.scraping = true;
    document.getElementById('scrape-progress').style.display = 'block';
    document.getElementById('btn-scrape').style.display = 'none';
    document.getElementById('btn-cancel-scrape').style.display = 'inline-flex';
    document.getElementById('scrape-bar').style.width = '0%';
    document.getElementById('scrape-progress-text').textContent = '正在连接 X...';
    showStatus('scrape-status', '正在采集评论...');

    const res = await apiInvoke('scrape:start', url);
    this.scraping = false;
    document.getElementById('scrape-progress').style.display = 'none';
    document.getElementById('btn-scrape').style.display = 'inline-flex';
    document.getElementById('btn-cancel-scrape').style.display = 'none';

    if (res.success) {
      const histEl = document.getElementById('scrape-history');
      if (histEl.classList.contains('empty-state')) histEl.classList.remove('empty-state');
      histEl.innerHTML = `<div class="log-line success">✅ 采集完成：${res.count} 条新评论（共发现 ${res.total} 条）</div>` + histEl.innerHTML;
      showStatus('scrape-status', `采集完成！新增 ${res.count} 条评论`);
    } else {
      showStatus('scrape-status', '采集失败：' + res.error, false);
    }
  }

  async cancel() {
    await apiInvoke('scrape:cancel');
    this.scraping = false;
    document.getElementById('scrape-progress').style.display = 'none';
    document.getElementById('btn-scrape').style.display = 'inline-flex';
    document.getElementById('btn-cancel-scrape').style.display = 'none';
    showStatus('scrape-status', '已取消');
  }
}
