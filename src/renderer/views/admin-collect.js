import { showStatus, apiInvoke } from '../ui.js';
import { t } from '../../i18n/index.js';

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
        t('collect.progress', { scroll: progress.scroll, total: progress.total, found: progress.found });
    });
  }

  async start() {
    const url = document.getElementById('collect-url').value.trim();
    if (!url || !url.includes('x.com')) {
      showStatus('scrape-status', t('collect.invalid_url'), false);
      return;
    }

    this.scraping = true;
    document.getElementById('scrape-progress').style.display = 'block';
    document.getElementById('btn-scrape').style.display = 'none';
    document.getElementById('btn-cancel-scrape').style.display = 'inline-flex';
    document.getElementById('scrape-bar').style.width = '0%';
    document.getElementById('scrape-progress-text').textContent = t('collect.connecting');
    showStatus('scrape-status', t('collect.scraping'));

    const res = await apiInvoke('scrape:start', url);
    this.scraping = false;
    document.getElementById('scrape-progress').style.display = 'none';
    document.getElementById('btn-scrape').style.display = 'inline-flex';
    document.getElementById('btn-cancel-scrape').style.display = 'none';

    if (res.success) {
      const histEl = document.getElementById('scrape-history');
      if (histEl.classList.contains('empty-state')) histEl.classList.remove('empty-state');
      histEl.innerHTML = `<div class="log-line success">${t('collect.done_detail', { count: res.count, total: res.total })}</div>` + histEl.innerHTML;
      showStatus('scrape-status', t('collect.done', { count: res.count }));
    } else {
      showStatus('scrape-status', t('collect.fail', { error: res.error }), false);
    }
  }

  async cancel() {
    await apiInvoke('scrape:cancel');
    this.scraping = false;
    document.getElementById('scrape-progress').style.display = 'none';
    document.getElementById('btn-scrape').style.display = 'inline-flex';
    document.getElementById('btn-cancel-scrape').style.display = 'none';
    showStatus('scrape-status', t('collect.cancelled'));
  }
}
