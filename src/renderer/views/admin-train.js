import { showStatus, apiInvoke, el } from '../ui.js';
import { t } from '../../i18n/index.js';

const { ipcRenderer } = require('electron');

export default class AdminTrainView {
  constructor() {
    this.training = false;
    this.installing = false;
    this.downloading = false;
    this.envReady = false;
    this.pretrainedReady = false;
    this.buildUI();
    this.bindEvents();
    this.checkEnv();
  }

  buildUI() {
    const c = document.getElementById('view-train');
    c.innerHTML = '';

    // Card 1: Environment check
    c.appendChild(
      el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'card-header' },
          el('span', { className: 'card-icon' }, '🔧'),
          el('h2', {}, t('train.env_title')),
          el(
            'button',
            {
              className: 'btn btn-sm btn-outline',
              id: 'btn-recheck-env',
              onClick: () => this.checkEnv(),
              style: 'margin-left:auto',
            },
            t('train.env_btn_recheck'),
          ),
        ),
        el(
          'div',
          { className: 'card-body' },
          el('div', {
            id: 'env-check',
            html: `<span style="color:var(--text-muted)">${t('train.env_checking')}</span>`,
          }),
          el('div', { id: 'env-actions', style: 'margin-top:12px' }),
        ),
      ),
    );

    // Card 2: Pretrained model download
    this.pretrainedCard = el(
      'div',
      { className: 'card', id: 'pretrained-card', style: 'display:none' },
      el(
        'div',
        { className: 'card-header' },
        el('span', { className: 'card-icon' }, '📦'),
        el('h2', {}, t('train.pretrained_title')),
        el(
          'button',
          {
            className: 'btn btn-sm btn-outline',
            id: 'btn-check-pretrained',
            onClick: () => this.checkPretrained(),
            style: 'margin-left:auto',
          },
          t('train.pretrained_btn_check'),
        ),
      ),
      el(
        'div',
        { className: 'card-body' },
        el('div', {
          id: 'pretrained-status',
          html: `<span style="color:var(--text-muted)">${t('train.checking_pretrained')}</span>`,
        }),
        el('div', { id: 'pretrained-actions', style: 'margin-top:12px' }),
      ),
    );
    c.appendChild(this.pretrainedCard);

    // Card 3: Training (initially hidden until env is ready)
    this.trainingCard = el(
      'div',
      { className: 'card', id: 'training-card', style: 'display:none' },
      el(
        'div',
        { className: 'card-header', style: 'padding:4px 16px' },
        el('span', { className: 'card-icon' }, '🧠'),
        el('h2', {}, t('train.training_title')),
        el('span', {
          id: 'train-data-stats',
          style: 'margin-left:12px;font-size:12px;color:var(--text-muted)',
        }),
        el(
          'div',
          { style: 'margin-left:auto;display:flex;align-items:center;gap:6px' },
          el(
            'label',
            { style: 'font-size:12px;color:var(--text-dim)' },
            t('train.epochs_label'),
          ),
          el('input', {
            type: 'number',
            id: 'train-epochs',
            value: '20',
            min: '1',
            max: '200',
            style: 'width:80px;font-size:13px',
          }),
          el(
            'label',
            { style: 'font-size:12px;color:var(--text-dim);margin-left:6px' },
            t('train.batch_size_label'),
          ),
          el('input', {
            type: 'number',
            id: 'train-batch-size',
            value: '32',
            min: '4',
            max: '128',
            step: '4',
            style: 'width:80px;font-size:13px',
          }),
          el(
            'button',
            { className: 'btn btn-primary btn-sm', id: 'btn-train' },
            t('train.btn_train_text'),
          ),
          el(
            'button',
            {
              className: 'btn btn-outline btn-sm',
              id: 'btn-cancel-train',
              style: 'display:none',
            },
            t('train.btn_cancel'),
          ),
        ),
      ),
    );
    c.appendChild(this.trainingCard);

    // Card 4: Trained model check
    this.modelCard = el(
      'div',
      { className: 'card', id: 'model-info-card', style: 'display:none' },
      el(
        'div',
        { className: 'card-header' },
        el('span', { className: 'card-icon' }, '📊'),
        el('h2', {}, t('train.model_title')),
        el(
          'button',
          {
            className: 'btn btn-sm btn-outline',
            id: 'btn-check-model',
            onClick: () => this.checkTrainedModel(),
            style: 'margin-left:auto',
          },
          t('train.model_check_btn'),
        ),
      ),
      el(
        'div',
        { className: 'card-body' },
        el('div', {
          id: 'trained-model-status',
          html: `<span style="color:var(--text-muted)">${t('train.model_not_checked')}</span>`,
        }),
        el('div', { id: 'trained-model-actions', style: 'margin-top:12px' }),
      ),
    );
    c.appendChild(this.modelCard);

    // Card 5: Log
    this.logCard = el(
      'div',
      {
        className: 'card',
        id: 'log-card',
        style: 'display:none;flex:1;min-height:0;flex-direction:column',
      },
      el(
        'div',
        { className: 'card-header' },
        el('span', { className: 'card-icon' }, '📜'),
        el('h2', {}, t('train.log_title')),
      ),
      el(
        'div',
        {
          className: 'card-body',
          style:
            'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0',
        },
        el(
          'div',
          { id: 'train-progress', style: 'display:none;margin-bottom:8px' },
          el(
            'div',
            { className: 'progress-bar' },
            el('div', {
              className: 'progress-fill',
              id: 'train-bar',
              style: 'width:0%',
            }),
          ),
          el('span', { className: 'progress-text', id: 'train-progress-text' }),
        ),
        el('div', {
          id: 'train-log',
          className: 'log-container',
          style: 'flex:1;max-height:none;overflow-y:auto',
        }),
      ),
    );
    c.appendChild(this.logCard);
  }

  bindEvents() {
    const rebind = () => {
      document
        .getElementById('btn-train')
        .addEventListener('click', () => this.startTraining());
      document
        .getElementById('btn-cancel-train')
        .addEventListener('click', () => this.cancelTraining());
    };
    rebind();

    document.addEventListener('language-changed', () => {
      this.buildUI();
      rebind();
    });

    ipcRenderer.on('train:progress', (event, data) => {
      if (!this.training && data.type !== 'metrics') return;
      this.handleProgress(data);
    });
    ipcRenderer.on('train:install-log', (event, text) => {
      this.appendLog(text, 'log-line');
    });
    ipcRenderer.on('model-download:progress', (event, data) => {
      this.handleDownloadProgress(data);
    });
    ipcRenderer.on('model:upload-finetuned-progress', (event, data) => {
      this.handleUploadProgress(data);
    });
  }

  // ── Environment check ──────────────────────────────────────

  async checkEnv() {
    const envEl = document.getElementById('env-check');
    envEl.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner"></span> ${t('train.checking_python')}</span>`;
    document.getElementById('env-actions').innerHTML = '';

    envEl.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner"></span> ${t('train.checking_deps')}</span>`;

    const res = await apiInvoke('train:check-env');
    if (!res.success) {
      document.getElementById('env-check').innerHTML =
        `<span style="color:var(--danger)">${t('train.env_fail')}</span>`;
      return;
    }

    const env = res.env;
    const items = [];

    // Python check
    if (env.python) {
      items.push(`<div class="log-line success" style="display:flex;align-items:center;gap:8px">
        <span style="color:var(--success);font-size:16px">✔</span>
        <span>${t('train.python_ok')} <span style="color:var(--text-muted)">${env.pythonVersion}</span></span>
      </div>
      <div class="log-line" style="font-size:11px;color:var(--text-dim);padding-left:24px">
        <code style="font-size:11px;word-break:break-all;background:var(--bg);padding:2px 6px;border-radius:4px">${env.pythonCmd}</code>
      </div>`);
    } else {
      items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--danger)">
        <span style="font-size:16px">✘</span>
        <span>${t('train.python_not_found')}</span>
      </div>`);
    }

    // CUDA check
    if (env.cuda && env.cuda.available) {
      items.push(`<div class="log-line success" style="display:flex;align-items:center;gap:8px">
        <span style="color:var(--success);font-size:16px">✔</span>
        <span>${t('train.cuda_available', { version: env.cuda.version, tag: env.cuda.cudaTag })}</span>
      </div>`);
    } else {
      items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--text-dim)">
        <span style="font-size:16px">·</span>
        <span>${t('train.cuda_not_found')}</span>
      </div>`);
    }

    // Packages check
    if (env.python) {
      if (env.packages.all) {
        items.push(`<div class="log-line success" style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--success);font-size:16px">✔</span>
          <span>${t('train.deps_ok')}</span>
        </div>`);
        // Show torch CUDA status
        if (env.packages.torchVersion) {
          const torchCudaOk = env.packages.torchCuda;
          items.push(`<div class="log-line ${torchCudaOk ? 'success' : ''}" style="display:flex;align-items:center;gap:8px;${torchCudaOk ? '' : 'color:#f59e0b'}">
            <span style="font-size:16px">${torchCudaOk ? '✔' : '⚠'}</span>
            <span>PyTorch ${env.packages.torchVersion} — ${torchCudaOk ? `CUDA (${env.packages.torchCudaDevices} GPU)` : t('train.torch_cpu_only')}</span>
          </div>`);
        }
      } else {
        const detail = env.packages.detail
          ? `<br><code style="font-size:11px;color:var(--text-muted)">${env.packages.detail}</code>`
          : '';
        items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--danger)">
          <span style="font-size:16px">✘</span>
          <span>${t('train.deps_missing')}${detail}</span>
        </div>`);
      }
    }

    document.getElementById('env-check').innerHTML = items.join('');

    // Action buttons
    const actions = document.getElementById('env-actions');
    actions.innerHTML = '';

    // Show install button if packages missing OR torch is CPU-only while CUDA is available
    const torchNeedsCuda =
      env.cuda?.available && env.packages.all && !env.packages.torchCuda;
    if (env.python && (!env.packages.all || torchNeedsCuda)) {
      const btn = el(
        'button',
        {
          className: 'btn btn-primary',
          id: 'btn-install-deps',
          onClick: () => this.installDeps(),
        },
        t('train.btn_install_deps'),
      );
      actions.appendChild(btn);
      const hintText = torchNeedsCuda
        ? t('train.install_cuda_hint')
        : t('train.install_hint');
      const hint = el(
        'div',
        { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' },
        hintText,
      );
      actions.appendChild(hint);
    }

    this.envReady = env.python && env.packages.all;
    if (this.envReady) {
      this.pretrainedCard.style.display = 'block';
      this.checkPretrained();
    }
  }

  // ── Pretrained model download ─────────────────────────────

  async checkPretrained() {
    const statusEl = document.getElementById('pretrained-status');
    const actionsEl = document.getElementById('pretrained-actions');
    statusEl.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner"></span> ${t('train.checking_pretrained')}</span>`;
    actionsEl.innerHTML = '';

    const res = await apiInvoke('model:download-status');
    this.pretrainedReady = res.downloaded;

    if (res.downloaded) {
      statusEl.innerHTML = `<div class="log-line success" style="display:flex;align-items:center;gap:8px">
        <span style="color:var(--success);font-size:16px">✔</span>
        <span>${t('train.pretrained_complete')}</span>
      </div>`;
      const btn = el(
        'button',
        {
          className: 'btn btn-sm btn-outline',
          id: 'btn-redownload-pretrained',
          onClick: () => this.downloadPretrained(true),
        },
        t('train.btn_redownload'),
      );
      actionsEl.appendChild(btn);
    } else if (res.partial) {
      const missingHtml =
        res.missing && res.missing.length > 0
          ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${t('train.pretrained_missing', { files: res.missing.join(', ') })}</div>`
          : '';
      statusEl.innerHTML = `<div class="log-line" style="display:flex;align-items:center;gap:8px;color:#f59e0b">
        <span style="font-size:16px">⚠</span>
        <span>${t('train.pretrained_incomplete')}</span>
      </div>${missingHtml}`;
      const btn = el(
        'button',
        {
          className: 'btn btn-primary',
          id: 'btn-download-pretrained',
          onClick: () => this.downloadPretrained(false),
        },
        t('train.btn_continue_download'),
      );
      actionsEl.appendChild(btn);
      const btnForce = el(
        'button',
        {
          className: 'btn btn-sm btn-outline',
          style: 'margin-left:8px',
          id: 'btn-redownload-pretrained',
          onClick: () => this.downloadPretrained(true),
        },
        t('train.btn_redownload'),
      );
      actionsEl.appendChild(btnForce);
    } else {
      statusEl.innerHTML = `<div class="log-line" style="display:flex;align-items:center;gap:8px;color:#f59e0b">
        <span style="font-size:16px">⚠</span>
        <span>${t('train.pretrained_not_downloaded')}</span>
      </div>`;
      const btn = el(
        'button',
        {
          className: 'btn btn-primary',
          id: 'btn-download-pretrained',
          onClick: () => this.downloadPretrained(false),
        },
        t('train.btn_download'),
      );
      actionsEl.appendChild(btn);
      const hint = el(
        'div',
        { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' },
        t('train.download_hint'),
      );
      actionsEl.appendChild(hint);
    }

    this.updateTrainAccess();
  }

  async downloadPretrained(force = false) {
    this.downloading = true;
    const btn = document.getElementById('btn-download-pretrained');
    const btnRe = document.getElementById('btn-redownload-pretrained');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('train.downloading');
    }
    if (btnRe) {
      btnRe.disabled = true;
    }

    this.logCard.style.display = 'flex';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'block';
    document.getElementById('train-bar').style.width = '0%';
    document.getElementById('train-progress-text').textContent = force
      ? t('train.download_status_force')
      : t('train.download_status');

    const res = await apiInvoke('model:download', force);

    this.downloading = false;
    document.getElementById('train-progress').style.display = 'none';

    if (res.success) {
      this.pretrainedReady = true;
      this.checkPretrained();
      this.trainingCard.style.display = 'block';
      this.refreshData();
    } else {
      this.appendLog(
        t('train.download_fail', { error: res.error || 'Unknown' }),
        'log-line',
      );
      const btn2 = document.getElementById('btn-download-pretrained');
      if (btn2) {
        btn2.disabled = false;
        btn2.textContent = t('train.btn_continue_download');
      }
      const btnRe2 = document.getElementById('btn-redownload-pretrained');
      if (btnRe2) {
        btnRe2.disabled = false;
      }
    }
  }

  async cancelDownload() {
    await apiInvoke('model:download-cancel');
    this.downloading = false;
  }

  handleDownloadProgress(data) {
    if (data.type === 'status') {
      const match = data.text.match(/(\d+)%/);
      if (match) {
        document.getElementById('train-bar').style.width = match[1] + '%';
      }
      document.getElementById('train-progress-text').textContent = data.text;
      this.appendLog(data.text, 'log-line success');
    } else if (data.type === 'progress') {
      const pct = data.percent || 0;
      document.getElementById('train-bar').style.width = pct + '%';
      const mb = data.downloaded / 1024 / 1024;
      const totalMb = data.total / 1024 / 1024;
      const text = `${data.file}: ${pct}% (${mb.toFixed(1)}/${totalMb.toFixed(1)} MB)`;
      document.getElementById('train-progress-text').textContent = text;
    } else if (data.type === 'log') {
      this.appendLog(data.text, 'log-line');
    }
  }

  updateTrainAccess() {
    if (this.pretrainedReady) {
      this.trainingCard.style.display = 'block';
      this.modelCard.style.display = 'block';
      this.checkTrainedModel();
      this.refreshData();
    } else {
      this.trainingCard.style.display = 'none';
      this.modelCard.style.display = 'none';
    }
  }

  async installDeps() {
    this.installing = true;
    const btn = document.getElementById('btn-install-deps');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('train.installing');
    }

    this.logCard.style.display = 'flex';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'none';
    this.appendLog(t('train.install_start'), 'log-line');
    this.appendLog(t('train.install_wait'), 'log-line');

    const res = await apiInvoke('train:install-deps');

    if (res.success) {
      await this.checkEnv();
    } else {
      this.appendLog(
        t('train.install_fail', { error: res.error || 'Unknown' }),
        'log-line',
      );
      document.getElementById('env-check').innerHTML +=
        `<div style="margin-top:8px;color:var(--danger);font-size:13px">${t('train.install_manual')}</div>`;
    }

    this.installing = false;
  }

  // ── Training ───────────────────────────────────────────────

  async refreshData() {
    const res = await apiInvoke('labels:stats');
    if (res.success) {
      const s = res.stats;
      const labeled = s.spam + s.not_spam;
      document.getElementById('train-data-stats').textContent = t(
        'train.data_stats',
        { spam: s.spam, not_spam: s.not_spam, labeled, unlabeled: s.unlabeled },
      );

      const btn = document.getElementById('btn-train');
      if (labeled < 10) {
        btn.disabled = true;
        btn.textContent = t('train.data_insufficient');
        btn.style.opacity = '0.6';
      } else {
        btn.disabled = false;
        btn.textContent = t('train.btn_train_text');
        btn.style.opacity = '1';
      }
    }
  }

  // ── Trained model check ────────────────────────────────────

  async checkTrainedModel() {
    const statusEl = document.getElementById('trained-model-status');
    const actionsEl = document.getElementById('trained-model-actions');
    statusEl.innerHTML = `<span style="color:var(--text-muted)"><span class="spinner"></span> ${t('train.model_checking')}</span>`;
    actionsEl.innerHTML = '';

    const res = await apiInvoke('model:check-trained');
    if (!res.success) {
      statusEl.innerHTML = `<span style="color:var(--danger)">${t('train.model_check_fail', { error: res.error })}</span>`;
      return;
    }

    if (!res.exists) {
      statusEl.innerHTML = `
        <div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--text-dim)">
          <span style="font-size:16px">·</span>
          <span>${t('train.model_not_trained')}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;padding-left:24px">
          <code style="font-size:11px;word-break:break-all;background:var(--bg);padding:2px 6px;border-radius:4px">${res.path}</code>
        </div>`;
      return;
    }

    const items = [];

    // Model existence
    if (res.hasOnnx && res.hasConfig) {
      items.push(`<div class="log-line success" style="display:flex;align-items:center;gap:8px">
        <span style="color:var(--success);font-size:16px">✔</span>
        <span>${t('train.model_trained_ok')}</span>
      </div>`);
    } else {
      items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--danger)">
        <span style="font-size:16px">✘</span>
        <span>${t('train.model_trained_incomplete')}</span>
      </div>`);
    }

    // Model type
    if (res.modelType) {
      items.push(`<div class="log-line" style="font-size:11px;color:var(--text-dim);padding-left:24px">
        ${t('train.model_type_label')} <code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${res.modelType}</code>
      </div>`);
    }

    // Trained at
    if (res.trainedAt) {
      const d = new Date(res.trainedAt);
      const dateStr = d.toLocaleString();
      items.push(`<div class="log-line" style="font-size:11px;color:var(--text-dim);padding-left:24px">
        ${t('train.model_trained_at')} ${dateStr}
      </div>`);
    }

    // ONNX files
    if (res.onnxFiles.length > 0) {
      items.push(`<div class="log-line" style="font-size:11px;color:var(--text-dim);padding-left:24px">
        ONNX: <code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px">${res.onnxFiles.join(', ')}</code>
      </div>`);
    }

    // Metrics
    if (res.metrics) {
      const m = res.metrics;
      items.push(`<div class="stats-grid" style="margin-top:8px">
        <div class="stat-card"><span class="num">${(m.eval_f1 * 100).toFixed(1)}%</span><span class="label">${t('train.metric_f1')}</span></div>
        <div class="stat-card"><span class="num">${(m.eval_accuracy * 100).toFixed(1)}%</span><span class="label">${t('train.metric_accuracy')}</span></div>
        <div class="stat-card"><span class="num">${(m.eval_precision * 100).toFixed(1)}%</span><span class="label">${t('train.metric_precision')}</span></div>
        <div class="stat-card"><span class="num">${(m.eval_recall * 100).toFixed(1)}%</span><span class="label">${t('train.metric_recall')}</span></div>
      </div>`);
    }

    // Path
    items.push(`<div style="font-size:11px;color:var(--text-dim);margin-top:4px;padding-left:24px">
      <code style="font-size:11px;word-break:break-all;background:var(--bg);padding:2px 6px;border-radius:4px">${res.path}</code>
    </div>`);

    statusEl.innerHTML = items.join('');

    // Action buttons: load/reload model
    const modelStatus = await apiInvoke('model:status');
    if (res.hasOnnx && res.hasConfig) {
      const btn = el(
        'button',
        {
          className: 'btn btn-primary btn-sm',
          id: 'btn-load-trained',
          onClick: () => this.loadTrainedModel(),
        },
        modelStatus.loaded
          ? t('train.btn_reload_model')
          : t('train.btn_load_model'),
      );
      actionsEl.appendChild(btn);

      if (!modelStatus.loaded) {
        const hint = el(
          'div',
          { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' },
          t('train.model_load_hint'),
        );
        actionsEl.appendChild(hint);
      }

      // HF upload section — always show when trained model exists on disk
      const uploadDiv = el(
        'div',
        {
          id: 'upload-section',
          style:
            'margin-top:12px;padding-top:12px;border-top:1px solid var(--border)',
        },
        el(
          'div',
          {
            style: 'font-size:12px;color:var(--text-muted);margin-bottom:6px',
          },
          t('train.upload_ready'),
        ),
        el(
          'div',
          {
            style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap',
          },
          el('input', {
            type: 'text',
            id: 'hf-token-input',
            placeholder: 'HF_TOKEN (hf_xxx)',
            style:
              'width:260px;font-size:13px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)',
          }),
          el(
            'button',
            {
              className: 'btn btn-primary btn-sm',
              id: 'btn-upload-hf',
              onClick: () => this.uploadToHF(),
            },
            t('train.btn_upload_hf'),
          ),
        ),
      );
      actionsEl.appendChild(uploadDiv);
    }
  }

  async loadTrainedModel() {
    const btn = document.getElementById('btn-load-trained');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('train.loading_model');
    }

    const res = await apiInvoke('model:load');
    if (res.success) {
      this.checkTrainedModel();
    } else {
      const statusEl = document.getElementById('trained-model-status');
      const errDiv = el(
        'div',
        { style: 'color:var(--danger);font-size:12px;margin-top:4px' },
        t('train.model_load_failed', {
          error: res.error || res.status?.error || 'Unknown',
        }),
      );
      statusEl.appendChild(errDiv);
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('train.btn_load_model');
      }
    }
  }

  async startTraining() {
    if (!this.pretrainedReady) {
      showStatus('train-status', t('train.pretrained_required'), false);
      return;
    }
    this.training = true;
    document.getElementById('btn-train').style.display = 'none';
    document.getElementById('btn-cancel-train').style.display = 'inline-flex';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'block';
    document.getElementById('train-bar').style.width = '0%';
    document.getElementById('train-progress-text').textContent =
      t('train.starting');
    this.logCard.style.display = 'flex';

    const epochs =
      parseInt(document.getElementById('train-epochs').value) || 20;
    const batchSize =
      parseInt(document.getElementById('train-batch-size').value) || 32;
    const res = await apiInvoke('train:start', { epochs, batchSize });
    this.training = false;
    document.getElementById('btn-train').style.display = 'inline-flex';
    document.getElementById('btn-cancel-train').style.display = 'none';

    if (res.success) {
      showStatus('train-status', t('train.done'));
      this.refreshData();
      this.checkTrainedModel();
    } else {
      showStatus('train-status', t('train.fail', { error: res.error }), false);
    }
  }

  async cancelTraining() {
    await apiInvoke('train:cancel');
    this.training = false;
    document.getElementById('btn-train').style.display = 'inline-flex';
    document.getElementById('btn-cancel-train').style.display = 'none';
    showStatus('train-status', t('train.cancelled'));
  }

  // ── Upload to HF ───────────────────────────────────────────

  async uploadToHF() {
    const tokenEl = document.getElementById('hf-token-input');
    const token = tokenEl ? tokenEl.value.trim() : '';
    if (!token) {
      this.appendLog(t('train.upload_token_required'), 'log-line');
      return;
    }

    const btn = document.getElementById('btn-upload-hf');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('train.uploading');
    }

    this.logCard.style.display = 'flex';
    document.getElementById('train-log').innerHTML = '';
    this.appendLog(t('train.uploading'), 'log-line');

    const res = await apiInvoke('model:upload-finetuned', null, token);

    if (res.success) {
      this.appendLog(t('train.upload_done'), 'log-line success');
      this.appendLog(`https://huggingface.co/${res.repo}`, 'log-line');
    } else {
      this.appendLog(
        t('train.upload_fail', { error: res.error || 'Unknown' }),
        'log-line',
      );
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = t('train.btn_upload_hf');
    }
  }

  handleUploadProgress(data) {
    if (data.type === 'status') {
      this.appendLog(data.text, 'log-line success');
    } else if (data.type === 'log') {
      this.appendLog(data.text, 'log-line');
    }
  }

  // ── Log / Progress ─────────────────────────────────────────

  handleProgress(data) {
    if (data.type === 'status') {
      this.appendLog(data.text, 'log-line success');
    } else if (data.type === 'progress') {
      const pct = Math.round((data.epoch / data.total) * 100);
      document.getElementById('train-bar').style.width = pct + '%';
      document.getElementById('train-progress-text').textContent =
        t('train.epoch_progress', { epoch: data.epoch, total: data.total }) +
        (data.loss != null
          ? t('train.epoch_loss', { loss: data.loss.toFixed(4) })
          : '');
      this.appendLog(
        t('train.epoch_progress', { epoch: data.epoch, total: data.total }) +
          (data.loss != null
            ? t('train.epoch_loss', { loss: data.loss.toFixed(4) })
            : ''),
        'log-line',
      );
    } else if (data.type === 'metrics') {
      const m = data.metrics;
      this.appendLog(
        t('train.metrics_format', {
          f1: (m.eval_f1 * 100).toFixed(1),
          accuracy: (m.eval_accuracy * 100).toFixed(1),
          precision: (m.eval_precision * 100).toFixed(1),
          recall: (m.eval_recall * 100).toFixed(1),
        }),
        'log-line success',
      );
    } else if (data.type === 'log') {
      this.appendLog(data.text, 'log-line');
    }
  }

  appendLog(text, className = 'log-line') {
    const log = document.getElementById('train-log');
    if (!log) return;
    const line = el('div', { className }, text);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  updateLastLog(text, className = 'log-line') {
    const log = document.getElementById('train-log');
    if (!log) return;
    const last = log.lastElementChild;
    if (last && last.className === className) {
      last.textContent = text;
    } else {
      const line = el('div', { className }, text);
      log.appendChild(line);
    }
    log.scrollTop = log.scrollHeight;
  }
}
