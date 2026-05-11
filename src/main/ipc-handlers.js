const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const cdp = require('./cdp-manager');
const db = require('./database');
const scraper = require('./x-scraper');
const modelManager = require('./model-manager');
const blocker = require('./x-blocker');

function registerIpcHandlers() {
  // ── Python resolver ──────────────────────────────────────────
  const pythonDir = path.join(__dirname, '..', '..', 'python');
  const pythonExe = process.platform === 'win32'
    ? path.join(pythonDir, 'python.exe')
    : path.join(pythonDir, 'bin', 'python3');

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
    // First, try project python/ directory
    if (fs.existsSync(pythonExe)) {
      try {
        const ver = await tryCommand(pythonExe);
        if (ver) return { cmd: pythonExe, version: ver, source: 'local' };
      } catch (e) { /* fall through */ }
    }

    // On macOS/Linux, fall back to system python3
    if (process.platform !== 'win32') {
      try {
        const ver = await tryCommand('python3');
        if (ver) return { cmd: 'python3', version: ver, source: 'system' };
      } catch (e) { /* fall through */ }
    }

    return null;
  }

  // ── Python download ───────────────────────────────────────────
  let downloadActive = false;

  ipcMain.handle('python:download', async (event) => {
    // Windows only — macOS/Linux users must provide Python manually
    if (process.platform !== 'win32') {
      return { success: false, error: 'Download only supported on Windows. Please install Python manually.' };
    }
    if (downloadActive) return { success: false, error: 'Download already in progress' };
    downloadActive = true;
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const https = require('https');

      const PY_VERSION = '3.12.7';
      const dlFile = `python-${PY_VERSION}-embed-amd64.zip`;
      const url = `https://registry.npmmirror.com/-/binary/python/${PY_VERSION}/${dlFile}`;
      const dlPath = path.join(pythonDir, dlFile);

      fs.mkdirSync(pythonDir, { recursive: true });

      const result = await downloadWithRedirect(https, url, dlPath, win, 0);
      if (!result.ok) {
        return { success: false, error: `Download failed: HTTP ${result.status}` };
      }

      if (win) win.webContents.send('python:download-progress', { phase: 'extract', text: '正在解压...' });
      execSync(`powershell -Command "Expand-Archive -Path '${dlPath}' -DestinationPath '${pythonDir}' -Force"`, { stdio: 'ignore' });
      fs.unlinkSync(dlPath);

      // Enable site-packages on Windows embeddable Python
      const pthFile = path.join(pythonDir, `python${PY_VERSION.replace(/\./g, '')}._pth`);
      if (fs.existsSync(pthFile)) {
        let content = fs.readFileSync(pthFile, 'utf-8');
        content = content.replace(/#import site/, 'import site');
        fs.writeFileSync(pthFile, content);
      }

      // Install pip via ensurepip
      if (win) win.webContents.send('python:download-progress', { phase: 'setup', text: '正在配置 pip...' });
      await runPython([pythonExe, '-m', 'ensurepip', '--default-pip'], pythonDir, win, 'ensurepip');
      await runPython([pythonExe, '-m', 'pip', 'install', '--upgrade', 'pip'], pythonDir, win, 'pip upgrade');

      if (win) win.webContents.send('python:download-progress', { phase: 'done', text: 'Python 已就绪' });

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      downloadActive = false;
    }
  });

  // Follow HTTP redirects up to 5 levels, then download with progress polling
  function downloadWithRedirect(https, url, filePath, win, depth) {
    if (depth > 5) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          res.resume(); // drain the redirect response body
          resolve(downloadWithRedirect(https, redirectUrl, filePath, win, depth + 1));
        } else {
          resolve(downloadStream(res, filePath, win));
        }
      }).on('error', reject);
    });
  }

  function runPython(args, cwd, win, label) {
    return new Promise((resolve, reject) => {
      const proc = spawn(args[0], args.slice(1), { shell: true, cwd });
      let out = '';
      proc.stdout.on('data', d => {
        out += d.toString();
        if (win) win.webContents.send('python:download-progress', { phase: 'setup', text: `[${label}] ${d.toString().trim()}` });
      });
      proc.stderr.on('data', d => {
        out += d.toString();
        if (win) win.webContents.send('python:download-progress', { phase: 'setup', text: `[${label}] ${d.toString().trim()}` });
      });
      proc.on('close', code => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`${label} failed (exit ${code}): ${out.trim().slice(-200)}`));
      });
      proc.on('error', e => reject(e));
    });
  }

  async function downloadStream(response, filePath, win) {
    const total = parseInt(response.headers['content-length'] || '0', 10);
    const file = fs.createWriteStream(filePath);

    // Poll bytesWritten for progress — file.bytesWritten reflects all writes regardless of disk flush
    let pollTimer = null;
    let lastBytes = 0;
    let lastTime = Date.now();
    let finished = false;

    if (win && total > 0) {
      pollTimer = setInterval(() => {
        const size = file.bytesWritten;
        if (size === lastBytes) return;
        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        const delta = size - lastBytes;
        const speed = elapsed > 0.1 ? delta / elapsed : 0;
        lastBytes = size;
        lastTime = now;
        const pct = Math.min(100, Math.round((size / total) * 100));
        win.webContents.send('python:download-progress', {
          phase: 'download', downloaded: size, total,
          pct, speed,
        });
      }, 300);
    }

    return new Promise((resolve, reject) => {
      response.on('data', chunk => { file.write(chunk); });
      response.on('end', () => {
        finished = true;
        file.end();
        if (pollTimer) clearInterval(pollTimer);
        if (win && total > 0) {
          win.webContents.send('python:download-progress', {
            phase: 'download', downloaded: file.bytesWritten, total,
            pct: 100, speed: 0,
          });
        }
        resolve({ ok: response.statusCode === 200, status: response.statusCode });
      });
      response.on('error', (e) => {
        if (pollTimer) clearInterval(pollTimer);
        reject(e);
      });
    });
  }

  // ── CDP Connection ──────────────────────────────────────────
  ipcMain.handle('cdp:connect', async (event, host, port) => {
    try {
      await cdp.connect(host, port);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('cdp:disconnect', async () => {
    cdp.disconnect();
    return { success: true };
  });

  ipcMain.handle('cdp:status', async () => {
    return { connected: cdp.isConnected() };
  });

  // ── Scraping ────────────────────────────────────────────────
  ipcMain.handle('scrape:start', async (event, url) => {
    try {
      const sessionId = db.createScrapeSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('scrape:progress', progress);
      });

      if (comments.length > 0) {
        const commentData = comments.map(c => ({ ...c, source_url: url }));
        const newCount = db.insertComments(commentData);
        db.completeScrapeSession(sessionId, newCount);
        return { success: true, count: newCount, total: comments.length };
      } else {
        db.completeScrapeSession(sessionId, 0);
        return { success: true, count: 0, total: 0 };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('scrape:cancel', async () => {
    scraper.cancel();
    return { success: true };
  });

  // ── Labels ─────────────────────────────────────────────────
  ipcMain.handle('labels:get-unlabeled', async (event, limit, offset) => {
    try {
      const comments = db.getUnlabeledComments(limit || 20, offset || 0);
      return { success: true, comments };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:get-all', async (event, filter, limit, offset) => {
    try {
      const comments = db.getAllComments(filter || 'all', limit || 50, offset || 0);
      return { success: true, comments };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:set', async (event, id, label) => {
    try {
      db.setLabel(id, label);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:batch-set', async (event, ids, label) => {
    try {
      db.batchSetLabel(ids, label);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('labels:stats', async () => {
    try {
      return { success: true, stats: db.getLabelStats() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('export:csv', async () => {
    try {
      const rows = db.exportLabeledComments();
      return { success: true, rows };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Model ───────────────────────────────────────────────────
  ipcMain.handle('model:load', async (event, modelPath) => {
    try {
      const status = await modelManager.loadModel(modelPath);
      return { success: status.loaded, status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('model:status', async () => {
    return modelManager.getStatus();
  });

  ipcMain.handle('model:predict', async (event, text) => {
    try {
      const result = await modelManager.predict(text);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('model:predict-batch', async (event, texts) => {
    try {
      const results = await modelManager.predictBatch(texts);
      return { success: true, results };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Blocking ────────────────────────────────────────────────
  ipcMain.handle('block:start', async (event, url, options) => {
    try {
      const threshold = options?.threshold || parseFloat(db.getSetting('spam_threshold')) || 0.8;
      const sessionId = db.createBlockSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      // Check model is loaded
      if (!modelManager.getStatus().loaded) {
        return { success: false, error: 'Model not loaded. Load a model first or train one with train.py.' };
      }

      // 1. Scrape comments from the URL
      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('block:progress', { phase: 'scraping', ...progress });
      });

      if (comments.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: 0, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: 0, spam: 0, blocked: 0 };
      }

      // 2. Run model prediction on all comments (pass post_text for relevance check)
      const predictions = await modelManager.predictBatch(
        comments.map(c => ({ text: c.text, post_text: c.post_text }))
      );
      const spamComments = comments.filter((c, i) => predictions[i] && predictions[i].spam && predictions[i].confidence >= threshold);

      if (win) win.webContents.send('block:progress', { phase: 'predicting', total: comments.length, spam: spamComments.length });

      // 3. Block spam users
      const result = await blocker.blockSpamUsers(url, spamComments, (progress) => {
        if (win) win.webContents.send('block:progress', progress);
      });

      db.completeBlockSession(sessionId, {
        comments_scanned: comments.length,
        spam_detected: spamComments.length,
        users_blocked: result.blocked,
        errors: result.errors,
      });

      // Auto-save blocked users to the blocklist
      const blockedUsernames = spamComments.map(c => c.username);
      db.markMultipleBlockedInBlocklist(blockedUsernames);

      return { success: true, scanned: comments.length, spam: spamComments.length, blocked: result.blocked, errors: result.errors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('block:all', async (event, url) => {
    try {
      const sessionId = db.createBlockSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      // Scrape comments from the URL
      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('block:progress', { phase: 'scraping', ...progress });
      });

      if (comments.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: 0, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: 0, blocked: 0 };
      }

      // Block all users without model filtering
      const result = await blocker.blockAllUsers(url, comments, (progress) => {
        if (win) win.webContents.send('block:progress', progress);
      });

      db.completeBlockSession(sessionId, {
        comments_scanned: comments.length,
        spam_detected: comments.length,
        users_blocked: result.blocked,
        errors: result.errors,
      });

      // Auto-save blocked users to the blocklist
      const blockedUsernames = comments.map(c => c.username);
      db.markMultipleBlockedInBlocklist(blockedUsernames);

      return { success: true, scanned: comments.length, blocked: result.blocked, errors: result.errors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('block:cancel', async () => {
    blocker.cancel();
    scraper.cancel();
    return { success: true };
  });

  // ── Blocklist ───────────────────────────────────────────────
  ipcMain.handle('blocklist:get', async () => {
    try {
      return { success: true, entries: db.getBlocklist() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:add', async (event, username) => {
    try {
      const added = db.addToBlocklist(username);
      return { success: true, added, count: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:remove', async (event, username) => {
    try {
      db.removeFromBlocklist(username);
      return { success: true, count: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:clear', async () => {
    try {
      db.clearBlocklist();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:import', async (event, text) => {
    try {
      const usernames = text.split(/[\n,]+/).filter(Boolean);
      const count = db.importBlocklist(usernames);
      return { success: true, count, total: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:import-file', async (event) => {
    try {
      const { dialog } = require('electron');
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: '导入拉黑名单',
        filters: [
          { name: '文本文件', extensions: ['txt', 'csv'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'cancelled' };
      }
      const content = fs.readFileSync(result.filePaths[0], 'utf-8');
      const usernames = content.split(/[\n,]+/).filter(Boolean);
      const count = db.importBlocklist(usernames);
      return { success: true, count, total: db.getBlocklist().length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:export', async () => {
    try {
      const entries = db.getBlocklist();
      const text = entries.map(e => e.username).join('\n');
      return { success: true, text };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:export-file', async (event) => {
    try {
      const { dialog } = require('electron');
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win, {
        title: '导出拉黑名单',
        defaultPath: 'blocklist.txt',
        filters: [
          { name: '文本文件', extensions: ['txt'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'cancelled' };
      }
      const entries = db.getBlocklist();
      const text = entries.map(e => e.username).join('\n');
      fs.writeFileSync(result.filePath, text);
      return { success: true, path: result.filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('blocklist:block', async (event, url) => {
    try {
      const entries = db.getBlocklist();
      if (entries.length === 0) {
        return { success: false, error: '拉黑名单为空，请先添加用户名' };
      }
      const blocklist = entries.map(e => e.username);
      const sessionId = db.createBlockSession(url);
      const win = BrowserWindow.fromWebContents(event.sender);

      // Scrape comments from the URL
      const { comments } = await scraper.scrapeComments(url, (progress) => {
        if (win) win.webContents.send('block:progress', { phase: 'scraping', ...progress });
      });

      if (comments.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: 0, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: 0, blocked: 0 };
      }

      // Filter comments by blocklist
      const matched = comments.filter(c => {
        const u = (c.username || '').toLowerCase();
        return blocklist.some(b => b.toLowerCase() === u);
      });

      if (matched.length === 0) {
        db.completeBlockSession(sessionId, { comments_scanned: comments.length, spam_detected: 0, users_blocked: 0, errors: 0 });
        return { success: true, scanned: comments.length, matched: 0, blocked: 0 };
      }

      // Auto-save matched users to blocklist as blocked
      db.markMultipleBlockedInBlocklist(matched.map(c => c.username));

      // Block matched users
      const result = await blocker.blockByList(url, matched, (progress) => {
        if (win) win.webContents.send('block:progress', progress);
      });

      db.completeBlockSession(sessionId, {
        comments_scanned: comments.length,
        spam_detected: matched.length,
        users_blocked: result.blocked,
        errors: result.errors,
      });

      return { success: true, scanned: comments.length, matched: matched.length, blocked: result.blocked, errors: result.errors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Training Environment ────────────────────────────────────
  ipcMain.handle('train:check-env', async () => {
    const result = { python: false, pythonCmd: null, packages: {} };

    // Check Python — try py, python3, python
    const py = await getPythonCommand();
    if (py) {
      result.python = true;
      result.pythonCmd = py.cmd;
      result.pythonVersion = py.version;
    }

    // Check required packages
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

  // ── Training ────────────────────────────────────────────────
  let trainingProcess = null;

  ipcMain.handle('train:start', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);

      // Check python
      const py = await getPythonCommand();
      if (!py) {
        return { success: false, error: 'Python not found. Please install Python 3 from python.org.' };
      }
      if (win) win.webContents.send('train:progress', { type: 'status', text: 'Python found: ' + py.version });

      // Export labeled data
      const rows = db.exportLabeledComments();
      if (rows.length < 10) {
        return { success: false, error: `Need at least 10 labeled comments, got ${rows.length}` };
      }

      const csvDir = path.join(app.getPath('userData'), 'training');
      fs.mkdirSync(csvDir, { recursive: true });
      const csvPath = path.join(csvDir, 'labeled.csv');
      const header = 'text,post_text,label\n';
      const csvRows = rows.map(r => `"${r.text.replace(/"/g, '""')}","${(r.post_text || '').replace(/"/g, '""')}",${r.label}`).join('\n');
      fs.writeFileSync(csvPath, header + csvRows);

      if (win) win.webContents.send('train:progress', { type: 'status', text: `Exported ${rows.length} labeled comments` });

      // Determine model output path
      const modelDir = path.join(app.getPath('userData'), 'models', 'x-spam-classifier');

      // Determine train.py path
      let trainScript = path.join(__dirname, '..', '..', 'train.py');
      if (!fs.existsSync(trainScript)) {
        trainScript = path.join(app.getAppPath(), 'train.py');
      }
      if (!fs.existsSync(trainScript)) {
        return { success: false, error: 'train.py not found' };
      }

      if (win) win.webContents.send('train:progress', { type: 'status', text: 'Starting training...' });

      // Spawn training
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
        // Auto-load the trained model
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

  // ── App info ─────────────────────────────────────────────────
  ipcMain.handle('app:paths', async () => {
    const workDir = path.join(__dirname, '..', '..');
    return {
      workDir,
      pythonDir,
      pythonExe,
      pythonReady: fs.existsSync(pythonExe),
    };
  });

  // ── Settings ────────────────────────────────────────────────
  ipcMain.handle('settings:get-all', async () => {
    try {
      return { success: true, settings: db.getAllSettings() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('settings:set', async (event, key, value) => {
    try {
      db.setSetting(key, value);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerIpcHandlers };
