/**
 * Shared Python detection and CUDA utilities.
 * Used by both training and model IPC handlers.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Cache for repeated lookups within the same process
let _pythonCache = null;
let _cudaCache = null;

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
  try {
    const names = ['python', 'python3', 'py'];
    for (const name of names) {
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
  if (_pythonCache) return _pythonCache;

  // 1. Use cmd.exe "where" to locate python (most reliable PATH resolution)
  let cmd = getPythonFromWhere();
  if (cmd) {
    const ver = tryExec(cmd);
    if (ver) {
      _pythonCache = { cmd, version: ver, source: 'system' };
      return _pythonCache;
    }
  }

  // 2. On macOS, scan Homebrew paths first (prefer Python 3.12+)
  if (process.platform === 'darwin') {
    const homebrewPaths = [
      '/opt/homebrew/opt/x-filter-venv/bin/python3',
      '/opt/homebrew/bin/python3.12',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3.12',
      '/usr/local/bin/python3',
    ];
    const found = findPythonInPaths(homebrewPaths);
    if (found) {
      const ver = tryExec(found);
      if (ver) {
        _pythonCache = { cmd: found, version: ver, source: 'homebrew' };
        return _pythonCache;
      }
    }
  }

  // 3. Try commands via execSync (shell PATH)
  if (process.platform === 'win32') {
    const names = ['python', 'python3', 'py'];
    for (const name of names) {
      const ver = tryExec(name);
      if (ver) {
        _pythonCache = { cmd: name, version: ver, source: 'system' };
        return _pythonCache;
      }
    }
  } else {
    for (const name of ['python3', 'python']) {
      const ver = tryExec(name);
      if (ver) {
        _pythonCache = { cmd: name, version: ver, source: 'system' };
        return _pythonCache;
      }
    }
  }

  // 4. Fallback: scan common Windows install directories
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
      if (ver) {
        _pythonCache = { cmd: found, version: ver, source: 'detected' };
        return _pythonCache;
      }
    }
  }

  return null;
}

function checkCuda() {
  if (_cudaCache) return _cudaCache;

  try {
    const out = execSync('nvidia-smi', { encoding: 'utf-8', shell: true, stdio: 'pipe' });
    const m = out.match(/CUDA Version:\s*(\d+\.\d+)/i);
    if (m) {
      const ver = m[1];
      const major = parseInt(ver.split('.')[0], 10);
      const minor = parseInt(ver.split('.')[1] || '0', 10);
      let cudaTag;
      if (major >= 13) cudaTag = 'cu130';
      else if (major >= 12) {
        if (minor >= 8) cudaTag = 'cu128';
        else if (minor >= 4) cudaTag = 'cu124';
        else cudaTag = 'cu121';
      } else if (major >= 11) cudaTag = 'cu118';
      else {
        _cudaCache = { available: false };
        return _cudaCache;
      }
      _cudaCache = { available: true, version: ver, cudaTag };
      return _cudaCache;
    }
  } catch (e) { /* nvidia-smi not found */ }
  _cudaCache = { available: false };
  return _cudaCache;
}

module.exports = { getPythonCommand, checkCuda };
