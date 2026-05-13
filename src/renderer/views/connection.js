import { showStatus, apiInvoke, updateSidebarStatus } from '../ui.js';
import { t } from '../../i18n/index.js';

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
    showStatus('conn-status', t('connect.connecting'), true);
    const res = await apiInvoke('cdp:connect', host, port);
    if (res.success) {
      showStatus('conn-status', t('connect.connected'));
      document.getElementById('btn-connect').style.display = 'none';
      document.getElementById('btn-disconnect').style.display = 'inline-flex';
      updateSidebarStatus(true);
    } else {
      showStatus('conn-status', t('connect.connect_fail', { error: res.error }), false);
    }
  }

  async disconnect() {
    await apiInvoke('cdp:disconnect');
    showStatus('conn-status', t('connect.disconnected'));
    document.getElementById('btn-connect').style.display = 'inline-flex';
    document.getElementById('btn-disconnect').style.display = 'none';
    updateSidebarStatus(false);
  }
}
