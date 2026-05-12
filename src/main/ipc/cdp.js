const { ipcMain } = require('electron');
const cdp = require('../cdp-manager');

function register() {
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
}

module.exports = { register };
