const { ipcMain } = require('electron');
const modelManager = require('../model-manager');

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
}

module.exports = { register };
