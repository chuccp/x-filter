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
    document.getElementById('btn-download-model').addEventListener('click', () => this.openDownloadModal());
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

  }

  openDownloadModal() {
    const overlay = document.getElementById('modal-download-model');
    if (!overlay) return;

    // Reset to phase 1
    document.getElementById('modal-dl-phase-input').style.display = '';
    document.getElementById('modal-dl-phase-progress').style.display = 'none';
    document.getElementById('modal-dl-phase-done').style.display = 'none';
    document.getElementById('modal-dl-bar').style.width = '0%';
    document.getElementById('modal-dl-text').textContent = '准备下载...';
    const cancelBtn = document.getElementById('modal-download-model-cancel');
    const confirmBtn = document.getElementById('modal-download-model-confirm');
    const closeBtn = document.getElementById('modal-download-model-close');
    cancelBtn.style.display = '';
    confirmBtn.textContent = t('block.modal_download_btn');
    confirmBtn.disabled = false;

    overlay.style.display = 'flex';

    const closeModal = () => { overlay.style.display = 'none'; };
    closeBtn.onclick = () => { if (!this.downloading) closeModal(); };
    cancelBtn.onclick = () => { if (!this.downloading) closeModal(); };
    overlay.onclick = (e) => { if (e.target === overlay && !this.downloading) closeModal(); };

    confirmBtn.onclick = () => {
      const raw = (document.getElementById('modal-download-model-url')?.value || '').trim();
      const repo = raw.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/$/, '');
      if (!repo) return;
      this._runDownloadInModal(repo, closeModal);
    };
  }

  async _runDownloadInModal(repo, closeModal) {
    this.downloading = true;

    // Switch to progress phase
    document.getElementById('modal-dl-phase-input').style.display = 'none';
    document.getElementById('modal-dl-phase-progress').style.display = '';
    document.getElementById('modal-dl-phase-done').style.display = 'none';
    document.getElementById('modal-dl-bar').style.width = '0%';
    const cancelBtn = document.getElementById('modal-download-model-cancel');
    const confirmBtn = document.getElementById('modal-download-model-confirm');
    cancelBtn.style.display = 'none';
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('block.downloading_model');

    const res = await apiInvoke('model:download-finetuned', repo);
    this.downloading = false;

    // Switch to done phase
    document.getElementById('modal-dl-phase-progress').style.display = 'none';
    document.getElementById('modal-dl-phase-done').style.display = '';
    const resultEl = document.getElementById('modal-dl-result');

    if (res.success) {
      resultEl.className = 'status-line success';
      resultEl.textContent = t('block.download_complete');
      confirmBtn.disabled = false;
      confirmBtn.textContent = t('common.ok');
      confirmBtn.onclick = async () => {
        closeModal();
        await this.checkModel();
      };
    } else {
      resultEl.className = 'status-line error';
      resultEl.textContent = t('block.download_failed', { error: res.error });
      cancelBtn.style.display = '';
      cancelBtn.textContent = t('common.close');
      cancelBtn.onclick = closeModal;
      confirmBtn.style.display = 'none';
    }
  }

  handleDownloadProgress(data) {
    if (!this.downloading) return;
    const dlBar = document.getElementById('modal-dl-bar');
    const dlText = document.getElementById('modal-dl-text');

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

    // Pre-check Chrome connection
    const cdpStatus = await apiInvoke('cdp:status');
    if (!cdpStatus.connected) {
      const statusEl = document.getElementById('block-status');
      statusEl.className = 'status-line error';
      statusEl.innerHTML = t('block.not_connected')
        + ` <button class="btn btn-sm" id="btn-goto-connect" style="margin-left:8px">${t('block.btn_goto_connect')}</button>`;
      document.getElementById('btn-goto-connect').onclick = () => {
        document.querySelector('.nav-item[data-view="connect"]')?.click();
      };
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

    if (p.phase === 'listing') {
      document.getElementById('block-bar').style.background = 'var(--primary)';
      document.getElementById('block-bar').style.width = '50%';
      document.getElementById('block-progress-text').textContent =
        t('block.listing_progress', { posts: p.posts, scroll: p.scroll });
      logLine.textContent = t('block.listing_log', { posts: p.posts });
      log.appendChild(logLine);
      log.scrollTop = log.scrollHeight;
      return;
    } else if (p.phase === 'status') {
      logLine.textContent = p.text;
      logLine.className += ' success';
      log.appendChild(logLine);
      log.scrollTop = log.scrollHeight;
      return;
    } else if (p.phase === 'scraping') {
      const pct = p.total > 0 ? Math.round((p.scroll / p.total) * 100) : 0;
      document.getElementById('block-bar').style.background = 'var(--primary)';
      document.getElementById('block-bar').style.width = pct + '%';
      document.getElementById('block-progress-text').textContent =
        t('block.scraping_progress', { found: p.found, scroll: p.scroll, current: p.postIndex || 1, totalPosts: p.postTotal || 1 });
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
    } else if (p.phase === 'scanning') {
      logLine.textContent = t('block.scanning_log', { username: p.username, scanned: p.scanned, spam: p.matched });
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
