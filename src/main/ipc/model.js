const { ipcMain, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const modelManager = require('../model-manager');
const { getPythonCommand } = require('../python-utils');
const { downloadRepo, cancel: cancelDownload } = require('../hf-downloader');
const { t } = require('../i18n');

let downloadProcess = null;
let pretrainedDownloadProcess = null;

function register() {
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

  // ── Download fine-tuned model from Hugging Face Hub (pure JS) ──

  ipcMain.handle('model:download-finetuned', async (event, repo) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);

      const modelDir = path.join(
        app.getPath('userData'),
        'models',
        'x-spam-classifier',
      );

      const send = (data) => {
        if (win) win.webContents.send('model:download-finetuned-progress', data);
      };

      await downloadRepo(
        repo || 'chuccp/x-spam-classifier',
        modelDir,
        (text) => send({ type: 'status', text }),
        (p) => send({ type: 'progress', ...p }),
      );

      send({ type: 'status', text: t('train.download_done') });
      return { success: true, path: modelDir };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('model:download-finetuned-cancel', async () => {
    cancelDownload();
    return { success: true };
  });

  ipcMain.handle('model:download-finetuned-status', async () => {
    try {
      const modelDir = path.join(
        app.getPath('userData'),
        'models',
        'x-spam-classifier',
      );
      const hasModel =
        fs.existsSync(path.join(modelDir, 'onnx', 'model.onnx')) ||
        fs.existsSync(path.join(modelDir, 'model.onnx'));
      return {
        downloaded:
          hasModel && fs.existsSync(path.join(modelDir, 'config.json')),
        path: modelDir,
      };
    } catch (e) {
      return { downloaded: false, error: e.message };
    }
  });

  // ── Upload trained model to Hugging Face Hub ───────────────

  ipcMain.handle('model:upload-finetuned', async (event, repo, token) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const py = await getPythonCommand();
      if (!py)
        return { success: false, error: t('train.python_not_found_error') };

      const projectRoot = path.join(__dirname, '..', '..', '..');
      const script = path.join(projectRoot, 'upload_to_hf.py');
      if (!fs.existsSync(script)) {
        return { success: false, error: 'upload_to_hf.py not found' };
      }

      const repoId = repo || 'chuccp/x-spam-classifier';
      const modelDir = path.join(
        app.getPath('userData'),
        'models',
        'x-spam-classifier',
      );

      const env = { ...process.env };
      if (token) env.HF_TOKEN = token;

      downloadProcess = spawn(
        py.cmd,
        [script, '--repo', repoId, '--input', modelDir],
        { cwd: path.dirname(script), env },
      );

      downloadProcess.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          if (win) {
            if (line.startsWith('[STATUS]')) {
              win.webContents.send('model:upload-finetuned-progress', {
                type: 'status',
                text: line.slice(9),
              });
            } else {
              win.webContents.send('model:upload-finetuned-progress', {
                type: 'log',
                text: line,
              });
            }
          }
        }
      });

      downloadProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text && win) {
          win.webContents.send('model:upload-finetuned-progress', {
            type: 'log',
            text: '[stderr] ' + text,
          });
        }
      });

      const exitCode = await new Promise((resolve) => {
        downloadProcess.on('close', resolve);
      });
      downloadProcess = null;

      if (exitCode === 0) {
        if (win)
          win.webContents.send('model:upload-finetuned-progress', {
            type: 'status',
            text: t('train.upload_done'),
          });
        return { success: true, repo: repoId };
      } else {
        return { success: false, error: `Upload exited with code ${exitCode}` };
      }
    } catch (e) {
      downloadProcess = null;
      return { success: false, error: e.message };
    }
  });

  // ── Pretrained model download (bert-base-multilingual-cased) ──

  ipcMain.handle('model:download-status', async () => {
    const projectRoot = path.join(__dirname, '..', '..', '..');
    const modelDir = path.join(
      projectRoot,
      'model',
      'bert-base-multilingual-cased',
    );
    const dirExists = fs.existsSync(modelDir);
    const hasFiles = dirExists && fs.readdirSync(modelDir).length > 0;

    const requiredFiles = ['config.json', 'tokenizer_config.json', 'vocab.txt'];
    const hasWeights =
      fs.existsSync(path.join(modelDir, 'model.safetensors')) ||
      fs.existsSync(path.join(modelDir, 'pytorch_model.bin'));

    const missing = [];
    for (const f of requiredFiles) {
      if (!fs.existsSync(path.join(modelDir, f))) missing.push(f);
    }
    if (!hasWeights)
      missing.push('model weights (model.safetensors or pytorch_model.bin)');

    const complete = missing.length === 0;
    return {
      downloaded: complete,
      partial: hasFiles && !complete,
      missing,
      path: modelDir,
    };
  });

  ipcMain.handle('model:download', async (event, force) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const py = getPythonCommand();
      if (!py)
        return { success: false, error: t('train.python_not_found_error') };

      const projectRoot = path.join(__dirname, '..', '..', '..');
      const modelDir = path.join(
        projectRoot,
        'model',
        'bert-base-multilingual-cased',
      );

      const script = path.join(projectRoot, 'download_model.py');
      if (!fs.existsSync(script)) {
        return { success: false, error: t('train.download_script_not_found') };
      }

      if (win)
        win.webContents.send('model-download:progress', {
          type: 'status',
          text: force
            ? t('train.download_status_force')
            : t('train.download_status'),
        });

      const spawnArgs = [
        script,
        '--output',
        modelDir,
        '--model',
        'bert-base-multilingual-cased',
      ];
      if (force) spawnArgs.push('--force');

      pretrainedDownloadProcess = spawn(py.cmd, spawnArgs, {
        cwd: path.dirname(script),
      });

      pretrainedDownloadProcess.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          if (win) {
            if (line.startsWith('[STATUS]')) {
              win.webContents.send('model-download:progress', {
                type: 'status',
                text: line.slice(9),
              });
            } else if (line.startsWith('[PROGRESS]')) {
              try {
                const info = JSON.parse(line.slice(11));
                win.webContents.send('model-download:progress', {
                  type: 'progress',
                  ...info,
                });
              } catch (e) {
                /* ignore */
              }
            } else {
              win.webContents.send('model-download:progress', {
                type: 'log',
                text: line,
              });
            }
          }
        }
      });

      pretrainedDownloadProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text && win) {
          if (text.includes('UserWarning') || text.includes('warnings.warn')) {
            win.webContents.send('model-download:progress', {
              type: 'log',
              text: '[warn] ' + text,
            });
          } else {
            win.webContents.send('model-download:progress', {
              type: 'log',
              text: '[stderr] ' + text,
            });
          }
        }
      });

      const exitCode = await new Promise((resolve) => {
        pretrainedDownloadProcess.on('close', resolve);
      });
      pretrainedDownloadProcess = null;

      if (exitCode === 0) {
        if (win)
          win.webContents.send('model-download:progress', {
            type: 'status',
            text: t('train.download_done'),
          });
        return { success: true, path: modelDir };
      } else {
        return {
          success: false,
          error: t('train.download_exit', { code: exitCode }),
        };
      }
    } catch (e) {
      pretrainedDownloadProcess = null;
      return { success: false, error: e.message };
    }
  });

  // ── Check trained model on disk ────────────────────────────

  ipcMain.handle('model:check-trained', async () => {
    try {
      const modelDir = path.join(
        app.getPath('userData'),
        'models',
        'x-spam-classifier',
      );
      const exists = fs.existsSync(modelDir);
      if (!exists) {
        return { success: true, exists: false, path: modelDir };
      }

      const hasOnnx = fs.existsSync(path.join(modelDir, 'onnx', 'model.onnx'));
      const hasConfig = fs.existsSync(path.join(modelDir, 'config.json'));
      let metrics = null;
      let trainedAt = null;

      const metricsPath = path.join(modelDir, 'metrics.json');
      if (fs.existsSync(metricsPath)) {
        try {
          metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
        } catch (e) {
          /* ignore */
        }
      }

      // Get last modified time as training date
      const filesToCheck = [
        path.join(modelDir, 'onnx', 'model.onnx'),
        path.join(modelDir, 'metrics.json'),
      ];
      for (const f of filesToCheck) {
        if (fs.existsSync(f)) {
          const stat = fs.statSync(f);
          trainedAt = stat.mtime.toISOString();
          break;
        }
      }

      // Try to read model type from config
      let modelType = null;
      if (hasConfig) {
        try {
          const config = JSON.parse(
            fs.readFileSync(path.join(modelDir, 'config.json'), 'utf-8'),
          );
          modelType = config.model_type || config.architectures?.[0] || null;
        } catch (e) {
          /* ignore */
        }
      }

      // List ONNX files
      const onnxFiles = [];
      const onnxDir = path.join(modelDir, 'onnx');
      if (fs.existsSync(onnxDir)) {
        const files = fs.readdirSync(onnxDir);
        onnxFiles.push(...files);
      }

      return {
        success: true,
        exists: true,
        path: modelDir,
        hasOnnx,
        hasConfig,
        modelType,
        metrics,
        trainedAt,
        onnxFiles,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('model:download-cancel', async () => {
    if (pretrainedDownloadProcess) {
      pretrainedDownloadProcess.kill();
      pretrainedDownloadProcess = null;
    }
    return { success: true };
  });
}

module.exports = { register };
