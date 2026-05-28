/**
 * Hugging Face Hub downloader — pure JS, no Python required.
 * Downloads all files from a HF repo to a local directory with progress reporting.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

let _cancelled = false;

function cancel() {
  _cancelled = true;
}

function resetCancel() {
  _cancelled = false;
}

function _get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: opts.headers || {} }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return resolve(_get(res.headers.location, opts));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      if (opts.stream) {
        const total = parseInt(res.headers['content-length'], 10) || 0;
        resolve({ stream: res, total, headers: res.headers });
      } else {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(JSON.parse(data)));
      }
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function listFiles(repo) {
  const url = `https://huggingface.co/api/models/${repo}`;
  const data = await _get(url, { headers: { 'User-Agent': 'x-filter/1.0' } });
  return (data.siblings || []).map((s) => ({
    name: s.rfilename,
    size: s.size || 0,
  }));
}

async function downloadFile(repo, file, outputDir, onProgress) {
  if (_cancelled) throw new Error('Cancelled');

  const url = `https://huggingface.co/${repo}/resolve/main/${file.name}`;
  const dest = path.join(outputDir, file.name);
  const destDir = path.dirname(dest);

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const { stream, total } = await _get(url, {
    headers: { 'User-Agent': 'x-filter/1.0' },
    stream: true,
  });

  const ws = fs.createWriteStream(dest);
  let downloaded = 0;
  let lastReport = 0;

  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      if (_cancelled) {
        stream.destroy();
        ws.close();
        return reject(new Error('Cancelled'));
      }
      downloaded += chunk.length;
      ws.write(chunk);
      if (total > 0 && downloaded - lastReport > 1024 * 64) {
        const pct = Math.round((downloaded / total) * 100);
        onProgress({ name: file.name, downloaded, total, percent: pct });
        lastReport = downloaded;
      }
    });

    stream.on('end', () => {
      ws.end();
      if (total > 0) {
        onProgress({ name: file.name, downloaded: total, total, percent: 100 });
      }
      resolve();
    });

    stream.on('error', (e) => {
      ws.close();
      reject(e);
    });

    ws.on('error', (e) => {
      stream.destroy();
      reject(e);
    });
  });
}

async function downloadRepo(repo, outputDir, onStatus, onProgress) {
  resetCancel();

  const repoId = repo || 'chuccp/x-spam-classifier';

  if (fs.existsSync(outputDir)) {
    const hasModel =
      fs.existsSync(path.join(outputDir, 'onnx', 'model.onnx')) ||
      fs.existsSync(path.join(outputDir, 'model.onnx'));
    const hasConfig = fs.existsSync(path.join(outputDir, 'config.json'));
    if (hasModel && hasConfig) {
      onStatus('Model already exists, skipping download');
      return;
    }
  }

  onStatus(`Listing files from ${repoId}...`);
  const files = await listFiles(repoId);

  if (files.length === 0) {
    throw new Error(`No files found in repo: ${repoId}`);
  }

  // Download LFS pointer files as is (Hugging Face resolves them automatically via the /resolve/ endpoint)
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  let totalDownloaded = 0;

  onStatus(`Downloading ${files.length} files from ${repoId}...`);

  for (const file of files) {
    if (_cancelled) throw new Error('Cancelled');

    await downloadFile(repoId, file, outputDir, (p) => {
      totalDownloaded += p.total > 0 ? Math.min(p.total, p.downloaded) - (totalDownloaded % p.total) : 0;
      onProgress({
        file: p.name,
        downloaded: totalDownloaded,
        total: totalBytes,
        percent: totalBytes > 0 ? Math.round((totalDownloaded / totalBytes) * 100) : 0,
      });
    });
  }

  onStatus(`Model downloaded to ${outputDir}`);
}

module.exports = { downloadRepo, cancel };
