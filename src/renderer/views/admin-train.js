import { showStatus, apiInvoke, el } from '../ui.js';

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
    c.appendChild(el('div', { className: 'card' },
      el('div', { className: 'card-header' },
        el('span', { className: 'card-icon' }, '🔧'),
        el('h2', {}, '环境检查'),
        el('button', { className: 'btn btn-sm btn-outline', id: 'btn-recheck-env', onClick: () => this.checkEnv(), style: 'margin-left:auto' }, '🔄 重新检测'),
      ),
      el('div', { className: 'card-body' },
        el('div', { id: 'env-check', html: '<span style="color:var(--text-muted)">正在检查...</span>' }),
        el('div', { id: 'env-actions', style: 'margin-top:12px' }),
      ),
    ));

    // Card 2: Pretrained model download
    this.pretrainedCard = el('div', { className: 'card', id: 'pretrained-card', style: 'display:none' },
      el('div', { className: 'card-header' },
        el('span', { className: 'card-icon' }, '📦'),
        el('h2', {}, '预训练模型'),
        el('button', { className: 'btn btn-sm btn-outline', id: 'btn-check-pretrained', onClick: () => this.checkPretrained(), style: 'margin-left:auto' }, '🔄 检查'),
      ),
      el('div', { className: 'card-body' },
        el('div', { id: 'pretrained-status', html: '<span style="color:var(--text-muted)">正在检查...</span>' }),
        el('div', { id: 'pretrained-actions', style: 'margin-top:12px' }),
      ),
    );
    c.appendChild(this.pretrainedCard);

    // Card 3: Training (initially hidden until env is ready)
    this.trainingCard = el('div', { className: 'card', id: 'training-card', style: 'display:none' },
      el('div', { className: 'card-header', style: 'padding:4px 16px' },
        el('span', { className: 'card-icon' }, '🧠'),
        el('h2', {}, '训练模型'),
        el('span', { id: 'train-data-stats', style: 'margin-left:12px;font-size:12px;color:var(--text-muted)' }),
        el('div', { style: 'margin-left:auto;display:flex;align-items:center;gap:6px' },
          el('label', { style: 'font-size:12px;color:var(--text-dim)' }, '轮数'),
          el('input', { type: 'number', id: 'train-epochs', value: '5', min: '1', max: '20', style: 'width:56px;font-size:13px' }),
          el('button', { className: 'btn btn-primary btn-sm', id: 'btn-train' }, '训练'),
          el('button', { className: 'btn btn-outline btn-sm', id: 'btn-cancel-train', style: 'display:none' }, '取消'),
        ),
      ),
    );
    c.appendChild(this.trainingCard);

    // Card 3: Model info
    this.modelCard = el('div', { className: 'card', id: 'model-info-card', style: 'display:none' },
      el('div', { className: 'card-header' },
        el('span', { className: 'card-icon' }, '📊'),
        el('h2', {}, '当前模型'),
      ),
      el('div', { className: 'card-body' },
        el('div', { id: 'train-model-info' }),
      ),
    );
    c.appendChild(this.modelCard);

    // Card 4: Log
    this.logCard = el('div', { className: 'card', id: 'log-card', style: 'display:none;flex:1;min-height:0;flex-direction:column' },
      el('div', { className: 'card-header' },
        el('span', { className: 'card-icon' }, '📜'),
        el('h2', {}, '输出日志'),
      ),
      el('div', { className: 'card-body', style: 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0' },
        el('div', { id: 'train-progress', style: 'display:none;margin-bottom:8px' },
          el('div', { className: 'progress-bar' },
            el('div', { className: 'progress-fill', id: 'train-bar', style: 'width:0%' }),
          ),
          el('span', { className: 'progress-text', id: 'train-progress-text' }),
        ),
        el('div', { id: 'train-log', className: 'log-container', style: 'flex:1;max-height:none;overflow-y:auto' }),
      ),
    );
    c.appendChild(this.logCard);
  }

  bindEvents() {
    document.getElementById('btn-train').addEventListener('click', () => this.startTraining());
    document.getElementById('btn-cancel-train').addEventListener('click', () => this.cancelTraining());

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
  }

  // ── Environment check ──────────────────────────────────────

  async checkEnv() {
    const envEl = document.getElementById('env-check');
    envEl.innerHTML = '<span style="color:var(--text-muted)"><span class="spinner"></span> 正在检查 Python 环境...</span>';
    document.getElementById('env-actions').innerHTML = '';

    envEl.innerHTML = '<span style="color:var(--text-muted)"><span class="spinner"></span> 正在检查依赖包...</span>';

    const res = await apiInvoke('train:check-env');
    if (!res.success) {
      document.getElementById('env-check').innerHTML = '<span style="color:var(--danger)">环境检查失败</span>';
      return;
    }

    const env = res.env;
    const items = [];

    // Python check
    if (env.python) {
      items.push(`<div class="log-line success" style="display:flex;align-items:center;gap:8px">
        <span style="color:var(--success);font-size:16px">✔</span>
        <span>Python 已安装 <span style="color:var(--text-muted)">${env.pythonVersion}</span></span>
      </div>`);
    } else {
      items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--danger)">
        <span style="font-size:16px">✘</span>
        <span>Python 未安装 — 请先到 <a href="https://www.python.org/downloads/" target="_blank" style="color:var(--accent)">python.org</a> 下载安装（安装时勾选 "Add Python to PATH"），然后重新检测</span>
      </div>`);
    }

    // CUDA check
    if (env.cuda && env.cuda.available) {
      items.push(`<div class="log-line success" style="display:flex;align-items:center;gap:8px">
        <span style="color:var(--success);font-size:16px">✔</span>
        <span>CUDA ${env.cuda.version} 可用 <span style="color:var(--text-muted)">(PyTorch 将使用 ${env.cuda.cudaTag})</span></span>
      </div>`);
    } else {
      items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--text-dim)">
        <span style="font-size:16px">·</span>
        <span>CUDA 未检测到 — 将安装 CPU 版 PyTorch</span>
      </div>`);
    }

    // Packages check
    if (env.python) {
      if (env.packages.all) {
        items.push(`<div class="log-line success" style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--success);font-size:16px">✔</span>
          <span>依赖包已就绪 (transformers, torch, datasets, etc.)</span>
        </div>`);
      } else {
        const detail = env.packages.detail ? `<br><code style="font-size:11px;color:var(--text-muted)">${env.packages.detail}</code>` : '';
        items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--danger)">
          <span style="font-size:16px">✘</span>
          <span>缺少 Python 依赖包${detail}</span>
        </div>`);
      }
    }

    document.getElementById('env-check').innerHTML = items.join('');

    // Action buttons
    const actions = document.getElementById('env-actions');
    actions.innerHTML = '';

    if (env.python && !env.packages.all) {
      const btn = el('button', {
        className: 'btn btn-primary',
        id: 'btn-install-deps',
        onClick: () => this.installDeps(),
      }, '一键安装依赖');
      actions.appendChild(btn);
      const hint = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' }, '将运行: pip install -i https://pypi.tuna.tsinghua.edu.cn/simple transformers torch datasets optimum[onnxruntime] scikit-learn pandas');
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
    statusEl.innerHTML = '<span style="color:var(--text-muted)"><span class="spinner"></span> 正在检查预训练模型...</span>';
    actionsEl.innerHTML = '';

    const res = await apiInvoke('model:download-status');
    this.pretrainedReady = res.downloaded;

    if (res.downloaded) {
      statusEl.innerHTML = `<div class="log-line success" style="display:flex;align-items:center;gap:8px">
        <span style="color:var(--success);font-size:16px">✔</span>
        <span>预训练模型已下载 <span style="color:var(--text-muted)">bert-base-multilingual-cased</span></span>
      </div>`;
    } else {
      statusEl.innerHTML = `<div class="log-line" style="display:flex;align-items:center;gap:8px;color:#f59e0b">
        <span style="font-size:16px">⚠</span>
        <span>预训练模型未下载 — 训练前需要先下载</span>
      </div>`;
      const btn = el('button', {
        className: 'btn btn-primary',
        id: 'btn-download-pretrained',
        onClick: () => this.downloadPretrained(),
      }, '下载预训练模型');
      actionsEl.appendChild(btn);
      const hint = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' }, '将下载 bert-base-multilingual-cased 到本地，约 700MB');
      actionsEl.appendChild(hint);
    }

    this.updateTrainAccess();
  }

  async downloadPretrained() {
    this.downloading = true;
    const btn = document.getElementById('btn-download-pretrained');
    if (btn) { btn.disabled = true; btn.textContent = '正在下载...'; }

    this.logCard.style.display = 'flex';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'block';
    document.getElementById('train-bar').style.width = '0%';
    document.getElementById('train-progress-text').textContent = '正在下载预训练模型...';

    const res = await apiInvoke('model:download');

    this.downloading = false;
    document.getElementById('train-progress').style.display = 'none';

    if (res.success) {
      this.pretrainedReady = true;
      this.checkPretrained();
      this.trainingCard.style.display = 'block';
      this.refreshData();
    } else {
      this.appendLog('下载失败: ' + (res.error || '未知错误'), 'log-line');
      const btn2 = document.getElementById('btn-download-pretrained');
      if (btn2) { btn2.disabled = false; btn2.textContent = '重新下载'; }
    }
  }

  async cancelDownload() {
    await apiInvoke('model:download-cancel');
    this.downloading = false;
  }

  handleDownloadProgress(data) {
    if (data.type === 'status') {
      this.appendLog(data.text, 'log-line success');
      // Parse percent from status like "Downloading config.json: 50%"
      const match = data.text.match(/(\d+)%/);
      if (match) {
        document.getElementById('train-bar').style.width = match[1] + '%';
        document.getElementById('train-progress-text').textContent = data.text;
      }
    } else if (data.type === 'progress') {
      const pct = data.percent || 0;
      document.getElementById('train-bar').style.width = pct + '%';
      document.getElementById('train-progress-text').textContent =
        `${data.file}: ${pct}%` + (data.total ? ` (${(data.downloaded / 1024 / 1024).toFixed(1)}/${(data.total / 1024 / 1024).toFixed(1)} MB)` : '');
    } else if (data.type === 'log') {
      this.appendLog(data.text, 'log-line');
    }
  }

  updateTrainAccess() {
    // Only show training card when pretrained model is ready
    if (this.pretrainedReady) {
      this.trainingCard.style.display = 'block';
      this.refreshData();
    } else {
      this.trainingCard.style.display = 'none';
    }
  }

  async installDeps() {
    this.installing = true;
    const btn = document.getElementById('btn-install-deps');
    if (btn) { btn.disabled = true; btn.textContent = '正在安装...'; }

    this.logCard.style.display = 'flex';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'none';
    this.appendLog('pip install transformers torch datasets optimum[onnxruntime] scikit-learn pandas', 'log-line');
    this.appendLog('正在下载安装，请耐心等待...', 'log-line');

    const res = await apiInvoke('train:install-deps');

    if (res.success) {
      await this.checkEnv();
    } else {
      this.appendLog('安装失败: ' + (res.error || '未知错误'), 'log-line');
      document.getElementById('env-check').innerHTML +=
        '<div style="margin-top:8px;color:var(--danger);font-size:13px">自动安装失败，请手动运行: pip install transformers torch datasets optimum[onnxruntime] scikit-learn pandas</div>';
    }

    this.installing = false;
  }

  // ── Training ───────────────────────────────────────────────

  async refreshData() {
    const res = await apiInvoke('labels:stats');
    if (res.success) {
      const s = res.stats;
      const labeled = s.spam + s.not_spam;
      document.getElementById('train-data-stats').textContent =
        `垃圾${s.spam} 正常${s.not_spam} 已标注${labeled} 待标注${s.unlabeled}`;

      const btn = document.getElementById('btn-train');
      if (labeled < 10) {
        btn.disabled = true;
        btn.textContent = '数据不足';
        btn.style.opacity = '0.6';
      } else {
        btn.disabled = false;
        btn.textContent = '训练';
        btn.style.opacity = '1';
      }
    }

    // Model info
    const modelRes = await apiInvoke('model:status');
    const modelEl = document.getElementById('train-model-info');
    if (modelRes.loaded) {
      this.modelCard.style.display = 'block';
      modelEl.innerHTML = '<span style="color:var(--success)">模型已加载</span>';
      if (modelRes.metrics) {
        const m = modelRes.metrics;
        modelEl.innerHTML += `
          <div class="stats-grid" style="margin-top:8px">
            <div class="stat-card"><span class="num">${(m.eval_f1 * 100).toFixed(1)}%</span><span class="label">F1</span></div>
            <div class="stat-card"><span class="num">${(m.eval_accuracy * 100).toFixed(1)}%</span><span class="label">准确率</span></div>
            <div class="stat-card"><span class="num">${(m.eval_precision * 100).toFixed(1)}%</span><span class="label">精确率</span></div>
            <div class="stat-card"><span class="num">${(m.eval_recall * 100).toFixed(1)}%</span><span class="label">召回率</span></div>
          </div>`;
      }
    }
  }

  async startTraining() {
    if (!this.pretrainedReady) {
      showStatus('train-status', '请先下载预训练模型', false);
      return;
    }
    this.training = true;
    document.getElementById('btn-train').style.display = 'none';
    document.getElementById('btn-cancel-train').style.display = 'inline-flex';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'block';
    document.getElementById('train-bar').style.width = '0%';
    document.getElementById('train-progress-text').textContent = '正在启动...';
    this.logCard.style.display = 'flex';

    const res = await apiInvoke('train:start');
    this.training = false;
    document.getElementById('btn-train').style.display = 'inline-flex';
    document.getElementById('btn-cancel-train').style.display = 'none';

    if (res.success) {
      showStatus('train-status', '训练完成！模型已自动加载');
      this.refreshData();
    } else {
      showStatus('train-status', '训练失败：' + res.error, false);
    }
  }

  async cancelTraining() {
    await apiInvoke('train:cancel');
    this.training = false;
    document.getElementById('btn-train').style.display = 'inline-flex';
    document.getElementById('btn-cancel-train').style.display = 'none';
    showStatus('train-status', '已取消');
  }

  // ── Log / Progress ─────────────────────────────────────────

  handleProgress(data) {
    if (data.type === 'status') {
      this.appendLog(data.text, 'log-line success');
    } else if (data.type === 'progress') {
      const pct = Math.round((data.epoch / data.total) * 100);
      document.getElementById('train-bar').style.width = pct + '%';
      document.getElementById('train-progress-text').textContent =
        `Epoch ${data.epoch}/${data.total}` + (data.loss != null ? ` — loss: ${data.loss.toFixed(4)}` : '');
      this.appendLog(`Epoch ${data.epoch}/${data.total}` + (data.loss != null ? `  loss: ${data.loss.toFixed(4)}` : ''), 'log-line');
    } else if (data.type === 'metrics') {
      const m = data.metrics;
      this.appendLog(
        `F1: ${(m.eval_f1 * 100).toFixed(1)}%  准确率: ${(m.eval_accuracy * 100).toFixed(1)}%  精确率: ${(m.eval_precision * 100).toFixed(1)}%  召回率: ${(m.eval_recall * 100).toFixed(1)}%`,
        'log-line success'
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
}
