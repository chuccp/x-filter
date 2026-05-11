import { showStatus, apiInvoke, updateSidebarStatus } from '../ui.js';

export default class ConnectionView {
  constructor() {
    this.bindEvents();
  }

  bindEvents() {
    document.getElementById('btn-connect').addEventListener('click', () => this.connect());
    document.getElementById('btn-disconnect').addEventListener('click', () => this.disconnect());
  }

  async connect() {
    const host = document.getElementById('host').value;
    const port = parseInt(document.getElementById('port').value);
    showStatus('conn-status', '正在连接 Chrome...', true);
    const res = await apiInvoke('cdp:connect', host, port);
    if (res.success) {
      showStatus('conn-status', '已连接到 Chrome 浏览器');
      document.getElementById('btn-connect').style.display = 'none';
      document.getElementById('btn-disconnect').style.display = 'inline-flex';
      updateSidebarStatus(true);
    } else {
      showStatus('conn-status', '连接失败：' + res.error, false);
    }
  }

  async disconnect() {
    await apiInvoke('cdp:disconnect');
    showStatus('conn-status', '已断开连接');
    document.getElementById('btn-connect').style.display = 'inline-flex';
    document.getElementById('btn-disconnect').style.display = 'none';
    updateSidebarStatus(false);
  }
}
