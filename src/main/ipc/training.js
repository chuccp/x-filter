const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const db = require('../database');
const modelManager = require('../model-manager');

let trainingProcess = null;

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

  ipcMain.handle('train:install-deps', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const py = await getPythonCommand();
      if (!py) return { success: false, error: 'Python not found' };

      const cuda = checkCuda();
      const torchPkg = cuda.available
        ? [`--index-url`, `https://download.pytorch.org/whl/${cuda.cudaTag}`, `torch`]
        : [`torch`];

      if (win && cuda.available) {
        win.webContents.send('train:install-log', `检测到 CUDA ${cuda.version}，将安装 PyTorch ${cuda.cudaTag} 版本\n`);
      }

      const proc = spawn(py.cmd, [
        '-m', 'pip', 'install', ...torchPkg, 'transformers', 'datasets', 'optimum[onnxruntime]', 'scikit-learn', 'pandas'
      ], { shell: true });

      proc.stdout.on('data', d => {
        if (win) win.webContents.send('train:install-log', d.toString());
      });
      proc.stderr.on('data', d => {
        if (win) win.webContents.send('train:install-log', d.toString());
      });

      const code = await new Promise(r => proc.on('close', r));
      return { success: code === 0, error: code !== 0 ? `pip exited with code ${code}` : null };
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

      let trainScript = path.join(__dirname, '..', '..', '..', 'train.py');
      if (!fs.existsSync(trainScript)) {
        trainScript = path.join(app.getAppPath(), 'train.py');
      }
      if (!fs.existsSync(trainScript)) {
        return { success: false, error: 'train.py not found' };
      }

      if (win) win.webContents.send('train:progress', { type: 'status', text: 'Starting training...' });

      trainingProcess = spawn(py.cmd, [
        trainScript,
        '--csv', csvPath,
        '--output', modelDir,
        '--epochs', '5',
      ], {
        cwd: path.dirname(trainScript),
        shell: true,
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
}

module.exports = { register };
