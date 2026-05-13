const WebSocket = require('ws');

let browserWs = null;
let pendingCommands = new Map();
let commandId = 0;
let onDisconnectCallback = null;
let reconnectInfo = null; // { host, port } for auto-reconnect

function isConnected() {
  return browserWs && browserWs.readyState === WebSocket.OPEN;
}

function setOnDisconnect(callback) {
  onDisconnectCallback = callback;
}

function connect(host = '127.0.0.1', port = 9222) {
  reconnectInfo = { host, port };
  return new Promise((resolve, reject) => {
    if (browserWs) {
      try { browserWs.close(); } catch (e) { /* ignore */ }
      browserWs = null;
    }
    for (const [, pending] of pendingCommands) {
      pending.reject(new Error('Connection reset'));
    }
    pendingCommands.clear();
    commandId = 0;

    const ws = new WebSocket(`ws://${host}:${port}/devtools/browser`);

    ws.on('open', () => {
      console.log('[cdp] Connected to Chrome at', host, port);
      browserWs = ws;
      resolve();
    });

    ws.on('error', (e) => {
      console.log('[cdp] Connection error:', e.message);
      browserWs = null;
      reject(new Error(e.message));
    });

    ws.on('close', () => {
      console.log('[cdp] WebSocket closed');
      browserWs = null;
      for (const [, pending] of pendingCommands) {
        pending.reject(new Error('WebSocket closed'));
      }
      pendingCommands.clear();
      if (onDisconnectCallback) onDisconnectCallback();
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && msg.id !== null) {
          const pending = pendingCommands.get(msg.id);
          if (pending) {
            pendingCommands.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else {
          console.log('[cdp] Event:', msg.method);
        }
      } catch (e) {
        console.log('[cdp] Parse error:', e.message);
      }
    });
  });
}

function disconnect() {
  if (browserWs) {
    try { browserWs.close(); } catch (e) { /* ignore */ }
    browserWs = null;
  }
  for (const [, pending] of pendingCommands) {
    pending.reject(new Error('Disconnected'));
  }
  pendingCommands.clear();
}

function sendCommand(method, params) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(new Error('未连接 Chrome，请先在左侧「连接」页面点击连接按钮'));
      return;
    }
    commandId++;
    pendingCommands.set(commandId, { resolve, reject });
    browserWs.send(JSON.stringify({ id: commandId, method, params }));
    setTimeout(() => {
      if (pendingCommands.has(commandId)) {
        pendingCommands.delete(commandId);
        reject(new Error('操作超时: ' + method));
      }
    }, 10000);
  });
}

function sendCommandWithSession(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) {
      reject(new Error('未连接 Chrome，请先在左侧「连接」页面点击连接按钮'));
      return;
    }
    commandId++;
    pendingCommands.set(commandId, { resolve, reject });
    const msg = { id: commandId, method, params };
    if (sessionId) msg.sessionId = sessionId;
    browserWs.send(JSON.stringify(msg));
    setTimeout(() => {
      if (pendingCommands.has(commandId)) {
        pendingCommands.delete(commandId);
        reject(new Error('Command timed out: ' + method));
      }
    }, 10000);
  });
}

// Get all page targets
async function getPageTargets() {
  const result = await sendCommand('Target.getTargets', {});
  return (result.targetInfos || []).filter(t => t.type === 'page');
}

// Attach to a target and get sessionId
async function attachToTarget(targetId) {
  const result = await sendCommand('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  return result.sessionId;
}

async function detachFromTarget(sessionId) {
  await sendCommandWithSession('Target.detachFromTarget', {}, sessionId);
}

// Navigate a page (via session)
async function navigatePage(sessionId, url) {
  const result = await sendCommandWithSession('Page.navigate', { url }, sessionId);
  return result;
}

// Wait for page to finish loading
function waitForPageLoad(sessionId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Page load timeout')), timeout);

    const check = async () => {
      try {
        const result = await evaluate(sessionId, 'document.readyState');
        if (result === 'complete') {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 500);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };
    setTimeout(check, 1000);
  });
}

// Wait for a CSS selector to match at least one element in the page.
// Useful for SPAs where readyState completes before content renders (e.g. X.com / React).
function waitForSelector(sessionId, selector, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitForSelector timeout: "${selector}"`)), timeout);

    const check = async () => {
      try {
        const result = await evaluate(sessionId,
          `document.querySelectorAll('${selector.replace(/'/g, "\\'")}').length`
        );
        if (result > 0) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 800);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };
    setTimeout(check, 1000);
  });
}

// Open a new tab and return targetId + sessionId
async function openNewTab(url) {
  const result = await sendCommand('Target.createTarget', { url });
  const sessionId = await attachToTarget(result.targetId);
  return { targetId: result.targetId, sessionId };
}

// Evaluate JavaScript in page context
async function evaluate(sessionId, expression) {
  const result = await sendCommandWithSession(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new Error(
      'Eval error: ' + (result.exceptionDetails.text || JSON.stringify(result.exceptionDetails))
    );
  }
  return result.result ? result.result.value : null;
}

// Click an element by selector
async function clickElement(sessionId, selector) {
  const expr = `
    (function() {
      const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { found: true };
    })()
  `;
  return evaluate(sessionId, expr);
}

module.exports = {
  connect,
  disconnect,
  isConnected,
  setOnDisconnect,
  getPageTargets,
  attachToTarget,
  detachFromTarget,
  navigatePage,
  waitForPageLoad,
  waitForSelector,
  openNewTab,
  evaluate,
  clickElement,
};
