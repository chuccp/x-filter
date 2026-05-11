const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const cdp = require('./cdp-manager');
const db = require('./database');
const scraper = require('./x-scraper');
const modelManager = require('./model-manager');
const blocker = require('./x-blocker');

function registerIpcHandlers() {
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

      // 2. Run model prediction on all comments
      const texts = comments.map(c => c.text);
      const predictions = await modelManager.predictBatch(texts);
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

      return { success: true, scanned: comments.length, spam: spamComments.length, blocked: result.blocked, errors: result.errors };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('block:cancel', async () => {
    blocker.cancel();
    scraper.cancel();
    return { success: true };
  });

  // ── Training Environment ────────────────────────────────────
  ipcMain.handle('train:check-env', async () => {
    const result = { python: false, packages: {} };

    // Check Python
    try {
      const pyCheck = spawn('python', ['--version'], { shell: true });
      let ver = '';
      pyCheck.stdout.on('data', d => ver += d.toString());
      pyCheck.stderr.on('data', d => ver += d.toString());
      const code = await new Promise(r => pyCheck.on('close', r));
      if (code === 0) {
        result.python = true;
        result.pythonVersion = ver.trim();
      }
    } catch (e) {
      result.python = false;
    }

    // Check required packages
    if (result.python) {
      const pkgCheck = spawn('python', ['-c',
        'import transformers, torch, datasets, sklearn, pandas; print("all ok")'
      ], { shell: true });
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
      const proc = spawn('pip', [
        'install', 'transformers', 'torch', 'datasets', 'optimum[onnxruntime]', 'scikit-learn', 'pandas'
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
      const pyCheck = spawn('python', ['--version'], { shell: true });
      let pyVersion = '';
      pyCheck.stdout.on('data', d => pyVersion += d.toString());
      pyCheck.stderr.on('data', d => pyVersion += d.toString());

      await new Promise((resolve, reject) => {
        pyCheck.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error('Python not found. Please install Python 3.'));
        });
      });
      if (win) win.webContents.send('train:progress', { type: 'status', text: 'Python found: ' + pyVersion.trim() });

      // Export labeled data
      const rows = db.exportLabeledComments();
      if (rows.length < 10) {
        return { success: false, error: `Need at least 10 labeled comments, got ${rows.length}` };
      }

      const csvDir = path.join(app.getPath('userData'), 'training');
      fs.mkdirSync(csvDir, { recursive: true });
      const csvPath = path.join(csvDir, 'labeled.csv');
      const header = 'text,label\n';
      const csvRows = rows.map(r => `"${r.text.replace(/"/g, '""')}",${r.label}`).join('\n');
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
      trainingProcess = spawn('python', [
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
