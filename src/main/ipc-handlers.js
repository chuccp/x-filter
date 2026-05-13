function registerIpcHandlers() {
  require('./ipc/cdp').register();
  require('./ipc/scrape').register();
  require('./ipc/labels').register();
  require('./ipc/model').register();
  require('./ipc/block').register();
  require('./ipc/training').register();
  require('./ipc/app').register();
  require('./ipc/i18n').register();
}

module.exports = { registerIpcHandlers };
