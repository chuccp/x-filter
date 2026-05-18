const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('../database');
const modelManager = require('../model-manager');
const { getPythonCommand, checkCuda } = require('../python-utils');
const { t } = require('../i18n');

let trainingProcess = null;

function register() {
  const projectRoot = path.join(__dirname, '..', '..', '..');

  ipcMain.handle('train:check-env', async () => {
    const result = { python: false, pythonCmd: null, packages: {}, cuda: null };

    // CUDA check (runs in parallel to Python check if possible, but sequential is fine)
    result.cuda = checkCuda();

    const py = await getPythonCommand();
    if (py) {
      result.python = true;
      result.pythonCmd = py.cmd;
      result.pythonVersion = py.version;
    }

    if (result.python) {
      // Basic package check
      const pkgCheck = spawn(py.cmd, ['-c',
        'import transformers, torch, datasets, sklearn, pandas; print("all ok")'
      ]);
      let out = '';
      pkgCheck.stdout.on('data', d => out += d.toString());
      pkgCheck.stderr.on('data', d => out += d.toString());
      const code = await new Promise(r => pkgCheck.on('close', r));
      result.packages.all = code === 0 && out.includes('all ok');
      result.packages.detail = out.trim();

      // Verify torch CUDA support
      if (code === 0) {
        const torchCudaCheck = spawn(py.cmd, ['-c',
          'import torch; print(f"torch_version:{torch.__version__}"); print(f"cuda_available:{torch.cuda.is_available()}"); print(f"cuda_devices:{torch.cuda.device_count()}")'
        ]);
        let torchOut = '';
        torchCudaCheck.stdout.on('data', d => torchOut += d.toString());
        torchCudaCheck.stderr.on('data', d => torchOut += d.toString());
        await new Promise(r => torchCudaCheck.on('close', r));
        result.packages.torchVersion = (torchOut.match(/torch_version:(.+)/) || [])[1] || 'unknown';
        result.packages.torchCuda = torchOut.includes('cuda_available:True');
        result.packages.torchCudaDevices = parseInt((torchOut.match(/cuda_devices:(\d+)/) || [])[1] || '0', 10);
      }
    }

    return { success: true, env: result };
  });

  function log(win, msg) {
    if (win) win.webContents.send('train:install-log', msg);
  }

  function runPip(pyCmd, args, win) {
    return new Promise((resolve, reject) => {
      const proc = spawn(pyCmd, ['-m', 'pip', ...args], { shell: false });
      proc.stdout.on('data', d => log(win, d.toString()));
      proc.stderr.on('data', d => log(win, d.toString()));
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      proc.on('error', e => reject(e));
    });
  }

  ipcMain.handle('train:install-deps', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const py = await getPythonCommand();
      if (!py) return { success: false, error: t('train.python_not_found_error') };

      // Upgrade pip first
      log(win, t('train.upgrade_pip'));
      try { await runPip(py.cmd, ['install', '--upgrade', 'pip'], win); } catch (e) { /* non-fatal */ }

      const cuda = checkCuda();

      // Install torch: CUDA version from pytorch.org, CPU version from mirror
      // Force reinstall to ensure CUDA version replaces any existing CPU-only torch
      if (cuda.available) {
        log(win, t('train.cuda_detected', { version: cuda.version, tag: cuda.cudaTag }));
        await runPip(py.cmd, [
          'install', '--upgrade', '--force-reinstall',
          'torch', 'torchvision', 'torchaudio',
          '--index-url', `https://download.pytorch.org/whl/${cuda.cudaTag}`,
          '--trusted-host', 'download.pytorch.org',
        ], win);
      }

      const mirrors = [
        { url: 'https://pypi.tuna.tsinghua.edu.cn/simple', host: 'pypi.tuna.tsinghua.edu.cn' },
        { url: 'https://mirrors.aliyun.com/pypi/simple/', host: 'mirrors.aliyun.com' },
        { url: 'https://pypi.mirrors.ustc.edu.cn/simple/', host: 'pypi.mirrors.ustc.edu.cn' },
        { url: 'https://pypi.org/simple/', host: 'pypi.org' },
      ];

      // Debug: show pip config
      log(win, t('train.pip_config'));
      try { await runPip(py.cmd, ['config', 'list'], win); } catch (e) { log(win, t('train.pip_config_fail')); }
      log(win, t('train.install_begin'));

      // Install each package individually so one failure doesn't block others
      const pkgs = cuda.available
        ? ['transformers', 'accelerate>=0.26.0', 'datasets', 'optimum[onnxruntime]', 'scikit-learn', 'pandas', 'huggingface_hub', 'emoji']
        : ['transformers', 'torch', 'accelerate>=0.26.0', 'datasets', 'optimum[onnxruntime]', 'scikit-learn', 'pandas', 'huggingface_hub', 'emoji'];

      let failed = [];
      for (const pkg of pkgs) {
        log(win, t('train.installing_pkg', { pkg }));
        let ok = false;
        for (const m of mirrors) {
          try {
            await runPip(py.cmd, [
              'install', '-i', m.url, '--trusted-host', m.host, '--verbose', pkg
            ], win);
            log(win, t('train.install_pkg_ok', { pkg }));
            ok = true;
            break;
          } catch (e) {
            log(win, t('train.mirror_fail', { url: m.url, error: e.message }));
          }
        }
        if (!ok) {
          log(win, t('train.all_mirrors_fail', { pkg }));
          failed.push(pkg);
        }
      }

      log(win, failed.length === 0 ? t('train.install_all_done') : t('train.install_failed_list', { list: failed.join(', ') }));
      return {
        success: failed.length === 0,
        error: failed.length > 0 ? `${failed.length} 个包安装失败: ${failed.join(', ')}` : null,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('train:start', async (event, options) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);

      const py = await getPythonCommand();
      if (!py) {
        return { success: false, error: t('train.python_not_found_error') };
      }
      if (win) win.webContents.send('train:progress', { type: 'status', text: t('train.python_found', { version: py.version }) });

      const rows = db.exportLabeledComments();
      if (rows.length < 10) {
        return { success: false, error: t('train.not_enough_data', { got: rows.length }) };
      }

      const csvDir = path.join(__dirname, '..', '..', '..', 'data');
      fs.mkdirSync(csvDir, { recursive: true });
      const csvPath = path.join(csvDir, 'labeled.csv');

      function escapeCsvField(field) {
        if (field == null) return '';
        return field
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/"/g, '""');
      }

      const header = 'text,post_text,label\n';
      const csvRows = rows.map(r => {
        const text = escapeCsvField(r.text);
        const postText = escapeCsvField(r.post_text);
        return `"${text}","${postText}",${r.label}`;
      }).join('\n');
      fs.writeFileSync(csvPath, header + csvRows);

      if (win) win.webContents.send('train:progress', { type: 'status', text: t('train.exported', { count: rows.length }) });

      const modelDir = path.join(app.getPath('userData'), 'models', 'x-spam-classifier');

      // Select train script by Python version: train-py312.py > train.py
      const pyVerMatch = py.version.match(/(\d+)\.(\d+)/);
      const pyVerSuffix = pyVerMatch ? `-py${pyVerMatch[1]}${pyVerMatch[2]}` : '';

      let trainScript = null;
      if (pyVerSuffix) {
        trainScript = path.join(projectRoot, `train${pyVerSuffix}.py`);
      }
      if (!trainScript || !fs.existsSync(trainScript)) {
        trainScript = path.join(projectRoot, 'train.py');
      }
      if (!fs.existsSync(trainScript)) {
        trainScript = path.join(app.getAppPath(), pyVerSuffix ? `train${pyVerSuffix}.py` : 'train.py');
      }
      if (!fs.existsSync(trainScript)) {
        trainScript = path.join(app.getAppPath(), 'train.py');
      }
      if (!fs.existsSync(trainScript)) {
        return { success: false, error: t('train.script_not_found') };
      }
      if (win) win.webContents.send('train:progress', { type: 'status', text: t('train.using_script', { name: path.basename(trainScript) }) });

      if (win) win.webContents.send('train:progress', { type: 'status', text: t('train.starting_training') });

      // Check if pretrained model is available locally
      const pretrainedDir = path.join(projectRoot, 'model', 'bert-base-multilingual-cased');
      const hasPretrained = fs.existsSync(path.join(pretrainedDir, 'config.json'));
      const modelArg = hasPretrained ? pretrainedDir : 'bert-base-multilingual-cased';
      const epochs = options?.epochs || 20;
      const batchSize = options?.batchSize || 32;
      const gradAccum = options?.gradientAccumulationSteps || 1;

      trainingProcess = spawn(py.cmd, [
        trainScript,
        '--csv', csvPath,
        '--output', modelDir,
        '--model', modelArg,
        '--epochs', String(epochs),
        '--batch-size', String(batchSize),
        '--gradient-accumulation-steps', String(gradAccum),
      ], {
        cwd: path.dirname(trainScript),
        env: {
          ...process.env,
          LC_ALL: 'C',
          LANG: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
        },
      });

      trainingProcess.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          if (win) {
            if (line.startsWith('[STATUS]')) {
              win.webContents.send('train:progress', { type: 'status', text: line.slice(9) });
            } else if (line.startsWith('[PROGRESS]')) {
              try {
                const info = JSON.parse(line.slice(11));
                win.webContents.send('train:progress', { type: 'progress', ...info });
              } catch (e) { /* ignore parse errors */ }
            } else if (line.startsWith('[METRICS]')) {
              try {
                const metrics = JSON.parse(line.slice(10));
                win.webContents.send('train:progress', { type: 'metrics', metrics });
              } catch (e) { /* ignore */ }
            } else {
              win.webContents.send('train:progress', { type: 'log', text: line });
            }
          }
        }
      });

      trainingProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text && win) {
          if (text.includes('UserWarning') || text.includes('warnings.warn')) {
            win.webContents.send('train:progress', { type: 'log', text: '[warn] ' + text });
          } else {
            win.webContents.send('train:progress', { type: 'log', text: '[stderr] ' + text });
          }
        }
      });

      const exitCode = await new Promise((resolve) => {
        trainingProcess.on('close', resolve);
      });
      trainingProcess = null;

      if (exitCode === 0) {
        if (win) win.webContents.send('train:progress', { type: 'status', text: t('train.training_complete') });

        // Copy trained model to project checkpoints directory for easy dev loading
        const checkpointDir = path.join(projectRoot, 'checkpoints', 'x-spam-classifier');
        try {
          fs.mkdirSync(checkpointDir, { recursive: true });
          fs.cpSync(modelDir, checkpointDir, { recursive: true, force: true });
          if (win) win.webContents.send('train:progress', { type: 'status', text: `Model copied to ${checkpointDir}` });
        } catch (e) {
          if (win) win.webContents.send('train:progress', { type: 'log', text: `[warn] Copy to checkpoints failed: ${e.message}` });
        }

        try {
          const loadResult = await modelManager.loadModel(modelDir);
          if (win) {
            if (loadResult.loaded) {
              win.webContents.send('train:progress', { type: 'status', text: t('train.model_loaded_ready') });
            } else {
              win.webContents.send('train:progress', { type: 'status', text: t('train.model_load_failed', { error: loadResult.error || 'unknown error' }) });
            }
          }
        } catch (e) {
          if (win) win.webContents.send('train:progress', { type: 'status', text: t('train.model_load_error', { error: e.message }) });
        }
        return { success: true };
      } else {
        return { success: false, error: t('train.python_exit', { code: exitCode }) };
      }
    } catch (e) {
      trainingProcess = null;
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('train:cancel', async () => {
    if (trainingProcess) {
      trainingProcess.kill();
      trainingProcess = null;
    }
    return { success: true };
  });

}

module.exports = { register };
