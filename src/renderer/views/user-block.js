import { showStatus, apiInvoke, el } from '../ui.js';
import { t } from '../../i18n/index.js';

const { ipcRenderer } = require('electron');

export default class UserBlockView {
  constructor() {
    this.blocking = false;
    this.downloading = false;
    this.bindEvents();
    this.checkModel();
  }

  bindEvents() {
    document.getElementById('btn-block-start').addEventListener('click', () => this.start());
    document.getElementById('btn-block-cancel').addEventListener('click', () => this.cancel());
    document.getElementById('threshold-slider').addEventListener('input', (e) => {
      document.getElementById('threshold-value').textContent = e.target.value;
    });

    ipcRenderer.on('block:progress', (event, progress) => {
      if (!this.blocking) return;
      this.renderProgress(progress);
    });

    ipcRenderer.on('model:download-finetuned-progress', (event, data) => {
      this.handleDownloadProgress(data);
    });
  }

  async checkModel() {
    const res = await apiInvoke('model:status');
    const el = document.getElementById('model-info');
    const btn = document.getElementById('btn-load-model');

    if (res.loaded) {
      el.className = 'model-status loaded';
      el.innerHTML = t('block.model_loaded');
      if (res.metrics) {
        el.innerHTML += ` — F1: ${res.metrics.eval_f1?.toFixed(3) || 'N/A'}`;
      }
      if (btn) {
        btn.textContent = t('block.btn_reload');
        btn.onclick = async () => {
          btn.textContent = t('block.loading_model');
          btn.disabled = true;
          await apiInvoke('model:load');
          this.checkModel();
        };
      }
    } else {
      // Model not loaded — check if fine-tuned model exists locally and auto-load
      const dlRes = await apiInvoke('model:download-finetuned-status');
      if (dlRes.downloaded) {
        el.className = 'model-status not-loaded';
        el.innerHTML = t('block.auto_loading_model');
        if (btn) { btn.style.display = 'none'; }
        const loadRes = await apiInvoke('model:load');
        if (loadRes.success) {
          this.checkModel();
          return;
        }
        // Auto-load failed, fall through to manual UI
      }

      el.className = 'model-status not-loaded';
      el.innerHTML = t('block.model_not_loaded');
      if (btn) {
        btn.style.display = '';
        btn.textContent = t('block.btn_load_model');
        btn.onclick = async () => {
          btn.textContent = t('block.loading_model');
          btn.disabled = true;
          await apiInvoke('model:load');
          this.checkModel();
        };
      }
    }

    // Check if fine-tuned model is downloadable from HF Hub
    const dlRes = await apiInvoke('model:download-finetuned-status');
    const dlBtn = document.getElementById('btn-download-model');
    if (dlBtn) {
      if (dlRes.downloaded) {
        dlBtn.style.display = 'none';
      } else {
        dlBtn.style.display = '';
        dlBtn.textContent = t('block.btn_download_model');
        dlBtn.onclick = () => this.downloadModel();
      }
    }
  }

  async downloadModel() {
    this.downloading = true;
    const btn = document.getElementById('btn-download-model');
    if (btn) { btn.disabled = true; btn.textContent = t('block.downloading_model'); }

    const dlArea = document.getElementById('download-progress-area');
    const dlBar = document.getElementById('download-bar');
    const dlText = document.getElementById('download-progress-text');
    if (dlArea) dlArea.style.display = 'block';
    if (dlBar) dlBar.style.width = '0%';
    if (dlText) dlText.textContent = t('block.downloading_model');

    const res = await apiInvoke('model:download-finetuned');

    this.downloading = false;
    if (dlArea) dlArea.style.display = 'none';

    if (res.success) {
      showStatus('block-status', t('block.download_complete'));
      await this.checkModel();
    } else {
      showStatus('block-status', t('block.download_failed', { error: res.error }), false);
    }

    if (btn) { btn.disabled = false; btn.textContent = t('block.btn_download_model'); }
  }

  handleDownloadProgress(data) {
    const dlBar = document.getElementById('download-bar');
    const dlText = document.getElementById('download-progress-text');
    const dlArea = document.getElementById('download-progress-area');
    if (dlArea && dlArea.style.display === 'none') return;

    if (data.type === 'status') {
      if (dlText) dlText.textContent = data.text;
    } else if (data.type === 'progress') {
      const pct = data.percent || 0;
      if (dlBar) dlBar.style.width = pct + '%';
      const mb = (data.downloaded || 0) / 1024 / 1024;
      const totalMb = (data.total || 1) / 1024 / 1024;
      if (dlText) dlText.textContent = `${data.file}: ${pct}% (${mb.toFixed(1)}/${totalMb.toFixed(1)} MB)`;
    }
  }

  async start() {
    const url = document.getElementById('block-url').value.trim();
    if (!url || !url.includes('x.com')) {
      showStatus('block-status', t('block.invalid_url'), false);
      return;
    }

    this.blocking = true;
    document.getElementById('btn-block-start').style.display = 'none';
    document.getElementById('btn-block-cancel').style.display = 'inline-flex';
    document.getElementById('block-log').innerHTML = '';
    document.getElementById('block-progress-area').style.display = 'block';
    showStatus('block-status', t('block.scanning'));

    const threshold = parseFloat(document.getElementById('threshold-slider').value);
    const res = await apiInvoke('block:start', url, { threshold });

    this.blocking = false;
    document.getElementById('btn-block-start').style.display = 'inline-flex';
    document.getElementById('btn-block-cancel').style.display = 'none';
    document.getElementById('block-progress-area').style.display = 'none';

    if (res.success) {
      showStatus('block-status',
        t('block.done', { scanned: res.scanned, spam: res.spam, blocked: res.blocked }));
    } else {
      const statusEl = document.getElementById('block-status');
      if (res.error && res.error.includes('未连接 Chrome')) {
        statusEl.className = 'status-line error';
        statusEl.innerHTML = t('block.not_connected')
          + ` <button class="btn btn-sm" id="btn-goto-connect" style="margin-left:8px">${t('block.btn_goto_connect')}</button>`;
        document.getElementById('btn-goto-connect').onclick = () => {
          document.querySelector('.nav-item[data-view="connect"]')?.click();
        };
      } else {
        showStatus('block-status', t('block.fail', { error: res.error }), false);
      }
    }
  }

  async cancel() {
    await apiInvoke('block:cancel');
    this.blocking = false;
    document.getElementById('btn-block-start').style.display = 'inline-flex';
    document.getElementById('btn-block-cancel').style.display = 'none';
    document.getElementById('block-progress-area').style.display = 'none';
    showStatus('block-status', t('block.cancelled'));
  }

  renderProgress(p) {
    const log = document.getElementById('block-log');
    const logLine = el('div', { className: 'log-line' });

    if (p.phase === 'scraping') {
      const pct = p.total > 0 ? Math.round((p.scroll / p.total) * 100) : 0;
      document.getElementById('block-bar').style.width = pct + '%';
      document.getElementById('block-progress-text').textContent =
        t('block.scraping_progress', { found: p.found, scroll: p.scroll });
      logLine.textContent = t('block.scraping_log', { found: p.found });
      log.appendChild(logLine);

      // Show each newly found comment in the log
      if (p.newComments && p.newComments.length > 0) {
        for (const c of p.newComments) {
          const commentLine = el('div', { className: 'log-line comment' });
          commentLine.textContent = `@${c.username}: ${c.text}`;
          log.appendChild(commentLine);
        }
      }
      log.scrollTop = log.scrollHeight;
      return;
    } else if (p.phase === 'predicting') {
      document.getElementById('block-bar').style.background = 'var(--accent)';
      document.getElementById('block-bar').style.width = '100%';
      document.getElementById('block-progress-text').textContent =
        t('block.predicting_progress', { total: p.total, spam: p.spam });
      logLine.textContent = t('block.predicting_log', { spam: p.spam });
      logLine.className += ' spam';
    } else if (p.phase === 'blocking') {
      const pct = p.total > 0 ? Math.round((p.scanned / p.total) * 100) : 0;
      document.getElementById('block-bar').style.background = 'var(--danger)';
      document.getElementById('block-bar').style.width = pct + '%';
      document.getElementById('block-progress-text').textContent =
        t('block.blocking_progress', { scanned: p.scanned, total: p.total, blocked: p.blocked });
      logLine.textContent = t('block.blocking_log', { username: p.username });
    } else if (p.phase === 'blocked') {
      logLine.textContent = t('block.blocked_log', { username: p.username });
      logLine.className += ' spam';
    } else if (p.phase === 'error') {
      logLine.textContent = t('block.error_log', { error: p.error });
    }

    log.appendChild(logLine);
    log.scrollTop = log.scrollHeight;
  }
}
