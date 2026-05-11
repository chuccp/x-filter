import { updateSidebarStatus } from './ui.js';

const { ipcRenderer } = require('electron');

let currentRole = 'admin';
const viewModules = {};
const loadedViews = {};

const adminOnlyViews = new Set(['collect', 'label', 'export', 'train', 'settings']);

const viewMap = {
  connect: 'connection',
  collect: 'admin-collect',
  label: 'admin-label',
  export: 'admin-export',
  train: 'admin-train',
  block: 'user-block',
  settings: 'admin-settings',
};

function init() {
  // Sidebar nav clicks
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      const viewName = item.dataset.view;
      if (currentRole === 'user' && adminOnlyViews.has(viewName)) return;
      switchView(viewName);
    });
  });

  // Role toggle
  document.querySelectorAll('.role-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setRole(btn.dataset.role);
    });
  });

  switchView('connect');

  ipcRenderer.on('cdp:disconnected', () => updateSidebarStatus(false));
}

function setRole(role) {
  currentRole = role;
  document.querySelectorAll('.role-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.role === role);
  });

  if (role === 'user') {
    document.body.classList.add('user-mode');
    // If currently on an admin view, switch to block
    const activeView = document.querySelector('.view.active');
    if (activeView && adminOnlyViews.has(activeView.id.replace('view-', ''))) {
      switchView('block');
    }
  } else {
    document.body.classList.remove('user-mode');
  }
}

async function switchView(name) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (navItem) navItem.classList.add('active');

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = document.getElementById('view-' + name);
  if (viewEl) viewEl.classList.add('active');

  if (!loadedViews[name]) {
    loadedViews[name] = true;
    await loadView(name);
  }
}

async function loadView(name) {
  const moduleName = viewMap[name];
  if (!moduleName) return;
  try {
    const module = await import(`./views/${moduleName}.js`);
    viewModules[name] = new module.default();
  } catch (e) {
    console.error('Failed to load view:', name, e);
  }
}

document.addEventListener('DOMContentLoaded', init);
