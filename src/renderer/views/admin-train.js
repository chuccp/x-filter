import { showStatus, apiInvoke, el } from '../ui.js';

const { ipcRenderer } = require('electron');

export default class AdminTrainView {
  constructor() {
    this.training = false;
    this.installing = false;
    this.envReady = false;
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
      ),
      el('div', { className: 'card-body' },
        el('div', { id: 'env-check', html: '<span style="color:var(--text-muted)">正在检查...</span>' }),
        el('div', { id: 'env-actions', style: 'margin-top:12px' }),
      ),
    ));

    // Card 2: Training (initially hidden until env is ready)
    this.trainingCard = el('div', { className: 'card', id: 'training-card', style: 'display:none' },
      el('div', { className: 'card-header' },
        el('span', { className: 'card-icon' }, '🧠'),
        el('h2', {}, '训练模型'),
      ),
      el('div', { className: 'card-body' },
        el('div', { id: 'train-data-stats', style: 'margin-bottom:16px' }),
        el('div', { className: 'form-group' },
          el('label', {}, '训练轮数'),
          el('input', { type: 'number', id: 'train-epochs', value: '5', min: '1', max: '20', style: 'width:100px' }),
        ),
        el('div', { className: 'btn-row' },
          el('button', { className: 'btn btn-primary', id: 'btn-train' }, '开始训练'),
          el('button', { className: 'btn btn-outline', id: 'btn-cancel-train', style: 'display:none' }, '取消'),
        ),
        el('div', { className: 'status-line', id: 'train-status' }),
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
    this.logCard = el('div', { className: 'card', id: 'log-card', style: 'display:none' },
      el('div', { className: 'card-header' },
        el('span', { className: 'card-icon' }, '📜'),
        el('h2', {}, '输出日志'),
      ),
      el('div', { className: 'card-body' },
        el('div', { id: 'train-progress', style: 'display:none;margin-bottom:8px' },
          el('div', { className: 'progress-bar' },
            el('div', { className: 'progress-fill', id: 'train-bar', style: 'width:0%' }),
          ),
          el('span', { className: 'progress-text', id: 'train-progress-text' }),
        ),
        el('div', { id: 'train-log', className: 'log-container', style: 'max-height:350px' }),
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
  }

  // ── Environment check ──────────────────────────────────────

  async checkEnv() {
    document.getElementById('env-check').innerHTML = '<span style="color:var(--text-muted)">正在检查 Python 环境...</span>';
    document.getElementById('env-actions').innerHTML = '';

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
        <span>Python 未安装 — 请先安装 <code style="color:var(--text-dim)">python.org</code></span>
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
        items.push(`<div class="log-line" style="display:flex;align-items:center;gap:8px;color:var(--danger)">
          <span style="font-size:16px">✘</span>
          <span>缺少 Python 依赖包</span>
        </div>`);
      }
    }

    document.getElementById('env-check').innerHTML = items.join('');

    // Action buttons
    const actions = document.getElementById('env-actions');
    if (env.python && !env.packages.all) {
      actions.innerHTML = '';
      const btn = el('button', {
        className: 'btn btn-primary',
        id: 'btn-install-deps',
        onClick: () => this.installDeps(),
      }, '一键安装依赖');
      actions.appendChild(btn);
      const hint = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' }, '将运行: pip install transformers torch datasets optimum scikit-learn pandas');
      actions.appendChild(hint);
    } else if (!env.python) {
      actions.innerHTML = '<span style="font-size:13px;color:var(--text-dim)">请安装 Python 3.9+ 后重启应用</span>';
    }

    this.envReady = env.python && env.packages.all;
    if (this.envReady) {
      this.trainingCard.style.display = 'block';
      this.refreshData();
    }
  }

  async installDeps() {
    this.installing = true;
    const btn = document.getElementById('btn-install-deps');
    if (btn) { btn.disabled = true; btn.textContent = '正在安装...'; }

    this.logCard.style.display = 'block';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'none';
    this.appendLog('pip install transformers torch datasets optimum[onnxruntime] scikit-learn pandas', 'log-line');
    this.appendLog('正在下载安装，请耐心等待...', 'log-line');

    const res = await apiInvoke('train:install-deps');

    if (res.success) {
      this.appendLog('安装完成！重新检查环境...', 'log-line success');
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
      document.getElementById('train-data-stats').innerHTML =
        `<div class="stats-grid">` +
        `<div class="stat-card"><span class="num">${s.spam}</span><span class="label">垃圾</span></div>` +
        `<div class="stat-card"><span class="num">${s.not_spam}</span><span class="label">正常</span></div>` +
        `<div class="stat-card"><span class="num">${labeled}</span><span class="label">已标注</span></div>` +
        `<div class="stat-card"><span class="num">${s.unlabeled}</span><span class="label">待标注</span></div>` +
        `</div>`;

      const btn = document.getElementById('btn-train');
      if (labeled < 10) {
        btn.disabled = true;
        btn.textContent = `需要至少 10 条已标注数据（当前 ${labeled} 条）`;
        btn.style.opacity = '0.6';
      } else {
        btn.disabled = false;
        btn.textContent = '开始训练';
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
    this.training = true;
    document.getElementById('btn-train').style.display = 'none';
    document.getElementById('btn-cancel-train').style.display = 'inline-flex';
    document.getElementById('train-log').innerHTML = '';
    document.getElementById('train-progress').style.display = 'block';
    document.getElementById('train-bar').style.width = '0%';
    document.getElementById('train-progress-text').textContent = '正在启动...';
    this.logCard.style.display = 'block';

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
