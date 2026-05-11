export { showStatus, el, apiInvoke, updateSidebarStatus };

function showStatus(elementId, message, ok = true) {
  const el = typeof elementId === 'string' ? document.getElementById(elementId) : elementId;
  if (!el) return;
  el.textContent = message;
  el.className = 'status-line ' + (ok ? 'success' : 'error');
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k === 'style') {
      if (typeof v === 'string') e.style.cssText = v;
      else Object.assign(e.style, v);
    } else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') e.appendChild(document.createTextNode(child));
    else if (child) e.appendChild(child);
  }
  return e;
}

function apiInvoke(channel, ...args) {
  try {
    if (window.api) return window.api.invoke(channel, ...args);
    const { ipcRenderer } = require('electron');
    return ipcRenderer.invoke(channel, ...args);
  } catch (e) {
    return Promise.reject(e);
  }
}

function updateSidebarStatus(connected) {
  const dot = document.getElementById('sidebar-status-dot');
  const text = document.getElementById('sidebar-status-text');
  if (!dot || !text) return;
  if (connected) {
    dot.classList.add('connected');
    text.textContent = '已连接';
  } else {
    dot.classList.remove('connected');
    text.textContent = '未连接';
  }
}
