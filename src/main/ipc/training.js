const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('../database');
const modelManager = require('../model-manager');

let trainingProcess = null;

function tryCommand(cmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, ['--version'], { shell: true });
    let ver = '';
    proc.stdout.on('data', d => ver += d.toString());
    proc.stderr.on('data', d => ver += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve(ver.trim());
      else reject(new Error(`exit ${code}`));
    });
    proc.on('error', e => reject(e));
  });
}

async function getPythonCommand() {
  const cmd = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const ver = await tryCommand(cmd);
    if (ver) return { cmd, version: ver, source: 'system' };
  } catch (e) { /* fall through */ }
  return null;
}

function register() {
  ipcMain.handle('train:check-env', async () => {
    const result = { python: false, pythonCmd: null, packages: {} };

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

      const proc = spawn(py.cmd, [
        '-m', 'pip', 'install', 'transformers', 'torch', 'datasets', 'optimum[onnxruntime]', 'scikit-learn', 'pandas'
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
