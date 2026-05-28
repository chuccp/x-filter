const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { initDatabase, closeDatabase } = require('./src/main/database');
const { registerIpcHandlers } = require('./src/main/ipc-handlers');
const { t } = require('./src/main/i18n');

let mainWindow;

app.disableHardwareAcceleration();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'x-filter — X Spam Filter',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = Menu.buildFromTemplate([
      { label: t('context_menu.cut'), role: 'cut', visible: params.editFlags.canCut },
      { label: t('context_menu.copy'), role: 'copy', visible: params.editFlags.canCopy },
      { label: t('context_menu.paste'), role: 'paste', visible: params.editFlags.canPaste },
      { type: 'separator', visible: params.editFlags.canSelectAll },
      { label: t('context_menu.select_all'), role: 'selectAll', visible: params.editFlags.canSelectAll },
    ]);
    menu.popup();
  });
}

app.whenReady().then(async () => {
  await initDatabase();
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  closeDatabase();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
