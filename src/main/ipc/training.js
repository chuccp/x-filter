const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const db = require('../database');
const modelManager = require('../model-manager');

let trainingProcess = null;
let downloadProcess = null;

// Use execSync to reliably resolve PATH through cmd.exe
function tryExec(cmd) {
  try {
    return execSync(`"${cmd}" --version`, { encoding: 'utf-8', shell: true, stdio: 'pipe' }).trim();
  } catch (e) {
    return null;
  }
}

function findPythonInPaths(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getPythonFromWhere() {
  // Use cmd.exe's "where" to locate python in PATH
  try {
    const paths = ['python', 'python3', 'py'];
    for (const name of paths) {
      const result = execSync(`where ${name} 2>nul`, { encoding: 'utf-8', shell: true, stdio: 'pipe' }).trim();
      if (result) {
        const firstLine = result.split('\n')[0].trim();
        if (fs.existsSync(firstLine)) return firstLine;
      }
    }
  } catch (e) { /* not found */ }
  return null;
}

async function getPythonCommand() {
  // 1. Use cmd.exe "where" to locate python (most reliable PATH resolution)
  let cmd = getPythonFromWhere();
  if (cmd) {
    const ver = tryExec(cmd);
    if (ver) return { cmd, version: ver, source: 'system' };
  }

  // 2. Try commands via execSync (shell PATH)
  if (process.platform === 'win32') {
    const names = ['python', 'python3', 'py'];
    for (const name of names) {
      const ver = tryExec(name);
      if (ver) return { cmd: name, version: ver, source: 'system' };
    }
  } else {
    for (const name of ['python3', 'python']) {
      const ver = tryExec(name);
      if (ver) return { cmd: name, version: ver, source: 'system' };
    }
  }

  // 3. Fallback: scan common Windows install directories
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || '';
    const versions = ['313', '312', '311', '310', '39', '38'];
    const searchPaths = [];
    for (const v of versions) {
      searchPaths.push(
        `C:\\Python${v}\\python.exe`,
        `C:\\Program Files\\Python${v}\\python.exe`,
        path.join(home, `AppData\\Local\\Programs\\Python\\Python${v}\\python.exe`),
        path.join(home, `AppData\\Local\\Microsoft\\WindowsApps\\python.exe`),
        path.join(home, `AppData\\Local\\Microsoft\\WindowsApps\\python3.exe`),
      );
    }
    const found = findPythonInPaths(searchPaths);
    if (found) {
      const ver = tryExec(found);
      if (ver) return { cmd: found, version: ver, source: 'detected' };
    }
  }

  return null;
}

function checkCuda() {
  try {
    const out = execSync('nvidia-smi', { encoding: 'utf-8', shell: true, stdio: 'pipe' });
    // Parse CUDA version from line like "CUDA Version: 12.4"
    const m = out.match(/CUDA Version:\s*(\d+\.\d+)/i);
    if (m) {
      const ver = m[1];
      // Map CUDA version to PyTorch index: 12.x → cu124, 11.x → cu118
      const major = parseInt(ver.split('.')[0], 10);
      const minor = parseInt(ver.split('.')[1] || '0', 10);
      let cudaTag;
      if (major >= 12) cudaTag = minor >= 4 ? 'cu124' : 'cu121';
      else if (major >= 11) cudaTag = 'cu118';
      else return { available: false };
      return { available: true, version: ver, cudaTag };
    }
  } catch (e) { /* nvidia-smi not found */ }
  return { available: false };
}

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
      const pkgCheck = spawn(py.cmd, ['-c',
        'import transformers, torch, datasets, sklearn, pandas; print("all ok")'
      ]);
      let out = '';
      pkgCheck.stdout.on('data', d => out += d.toString());
      pkgCheck.stderr.on('data', d => out += d.toString());
      const code = await new Promise(r => pkgCheck.on('close', r));
      result.packages.all = code === 0 && out.includes('all ok');
      result.packages.detail = out.trim();
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
      if (!py) return { success: false, error: 'Python not found' };

      // Upgrade pip first
      log(win, '升级 pip...\n');
      try { await runPip(py.cmd, ['install', '--upgrade', 'pip'], win); } catch (e) { /* non-fatal */ }

      const cuda = checkCuda();

      // Install torch: CUDA version from pytorch.org, CPU version from mirror
      if (cuda.available) {
        log(win, `检测到 CUDA ${cuda.version}，安装 PyTorch ${cuda.cudaTag} 版本\n`);
        await runPip(py.cmd, [
          'install', 'torch',
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
      log(win, '--- pip 配置 ---\n');
      try { await runPip(py.cmd, ['config', 'list'], win); } catch (e) { log(win, 'pip config 失败\n'); }
      log(win, '--- 开始安装 ---\n');

      // Install each package individually so one failure doesn't block others
      const pkgs = cuda.available
        ? ['transformers', 'datasets', 'optimum[onnxruntime]', 'scikit-learn', 'pandas']
        : ['transformers', 'torch', 'datasets', 'optimum[onnxruntime]', 'scikit-learn', 'pandas'];

      let failed = [];
      for (const pkg of pkgs) {
        log(win, `安装 ${pkg} ...`);
        let ok = false;
        for (const m of mirrors) {
          try {
            await runPip(py.cmd, [
              'install', '-i', m.url, '--trusted-host', m.host, '--verbose', pkg
            ], win);
            log(win, `  ${pkg} 安装成功\n`);
            ok = true;
            break;
          } catch (e) {
            log(win, `  ${m.url} 失败: ${e.message}\n`);
          }
        }
        if (!ok) {
          log(win, `  ${pkg} 所有镜像均失败！\n`);
          failed.push(pkg);
        }
      }

      log(win, failed.length === 0 ? '全部安装完成！\n' : `以下包安装失败: ${failed.join(', ')}\n`);
      return {
        success: failed.length === 0,
        error: failed.length > 0 ? `${failed.length} 个包安装失败: ${failed.join(', ')}` : null,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('train:start', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);

      const py = await getPythonCommand();
      if (!py) {
        return { success: false, error: 'Python not found. Please install Python 3 from python.org.' };
      }
      if (win) win.webContents.send('train:progress', { type: 'status', text: 'Python found: ' + py.version });

      const rows = db.exportLabeledComments();
      if (rows.length < 10) {
        return { success: false, error: `Need at least 10 labeled comments, got ${rows.length}` };
      }

      const csvDir = path.join(__dirname, '..', '..', '..', 'data');
      fs.mkdirSync(csvDir, { recursive: true });
      const csvPath = path.join(csvDir, 'labeled.csv');
      const header = 'text,post_text,label\n';
      const csvRows = rows.map(r => `"${r.text.replace(/"/g, '""')}","${(r.post_text || '').replace(/"/g, '""')}",${r.label}`).join('\n');
      fs.writeFileSync(csvPath, header + csvRows);

      if (win) win.webContents.send('train:progress', { type: 'status', text: `Exported ${rows.length} labeled comments` });

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
        return { success: false, error: `train${pyVerSuffix || ''}.py not found` };
      }
      if (win) win.webContents.send('train:progress', { type: 'status', text: `Using script: ${path.basename(trainScript)}` });

      if (win) win.webContents.send('train:progress', { type: 'status', text: 'Starting training...' });

      // Check if pretrained model is available locally
      const pretrainedDir = path.join(projectRoot, 'model', 'bert-base-multilingual-cased');
      const hasPretrained = fs.existsSync(path.join(pretrainedDir, 'config.json'));
      const modelArg = hasPretrained ? pretrainedDir : 'bert-base-multilingual-cased';

      trainingProcess = spawn(py.cmd, [
        trainScript,
        '--csv', csvPath,
        '--output', modelDir,
        '--model', modelArg,
        '--epochs', '5',
      ], {
        cwd: path.dirname(trainScript),
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
        if (text && win) win.webContents.send('train:progress', { type: 'log', text: '[stderr] ' + text });
      });

      const exitCode = await new Promise((resolve) => {
        trainingProcess.on('close', resolve);
      });
      trainingProcess = null;

      if (exitCode === 0) {
        if (win) win.webContents.send('train:progress', { type: 'status', text: 'Training complete!' });
        try { await modelManager.loadModel(modelDir); } catch (e) { /* ignore */ }
        return { success: true };
      } else {
        return { success: false, error: `Python exited with code ${exitCode}` };
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

  // ── Pretrained model download ──────────────────────────────────

  ipcMain.handle('model:download-status', async () => {
    const modelDir = path.join(projectRoot, 'model', 'bert-base-multilingual-cased');
    const configPath = path.join(modelDir, 'config.json');
    const dirExists = fs.existsSync(modelDir);
    const hasFiles = dirExists && fs.readdirSync(modelDir).length > 0;
    return {
      downloaded: fs.existsSync(configPath),
      partial: hasFiles && !fs.existsSync(configPath),
      path: modelDir,
    };
  });

  ipcMain.handle('model:download', async (event, force) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const py = await getPythonCommand();
      if (!py) return { success: false, error: 'Python not found' };

      const modelDir = path.join(projectRoot, 'model', 'bert-base-multilingual-cased');

      const script = path.join(projectRoot, 'download_model.py');
      if (!fs.existsSync(script)) {
        return { success: false, error: 'download_model.py not found' };
      }

      if (win) win.webContents.send('model-download:progress', { type: 'status', text: force ? '正在重新下载预训练模型...' : '正在下载预训练模型...' });

      const spawnArgs = [
        script,
        '--output', modelDir,
        '--model', 'bert-base-multilingual-cased',
      ];
      if (force) spawnArgs.push('--force');

      downloadProcess = spawn(py.cmd, spawnArgs, {
        cwd: path.dirname(script),
      });

      downloadProcess.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          if (win) {
            if (line.startsWith('[STATUS]')) {
              win.webContents.send('model-download:progress', { type: 'status', text: line.slice(9) });
            } else if (line.startsWith('[PROGRESS]')) {
              try {
                const info = JSON.parse(line.slice(11));
                win.webContents.send('model-download:progress', { type: 'progress', ...info });
              } catch (e) { /* ignore */ }
            } else {
              win.webContents.send('model-download:progress', { type: 'log', text: line });
            }
          }
        }
      });

      downloadProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text && win) win.webContents.send('model-download:progress', { type: 'log', text: '[stderr] ' + text });
      });

      const exitCode = await new Promise((resolve) => {
        downloadProcess.on('close', resolve);
      });
      downloadProcess = null;

      if (exitCode === 0) {
        if (win) win.webContents.send('model-download:progress', { type: 'status', text: '预训练模型下载完成' });
        return { success: true, path: modelDir };
      } else {
        return { success: false, error: `Download exited with code ${exitCode}` };
      }
    } catch (e) {
      downloadProcess = null;
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('model:download-cancel', async () => {
    if (downloadProcess) {
      downloadProcess.kill();
      downloadProcess = null;
    }
    return { success: true };
  });
}

module.exports = { register };
