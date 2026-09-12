export async function connectRpc(url, onNotification = () => {}) {
  if (!url?.startsWith('wss://')) throw new Error('INVALID_WSS_URL');
  const ws = new WebSocket(url); let id = 0;
  const pending = new Map();
  function rejectAll() {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('WSS_DISCONNECTED')); }
    pending.clear();
  }
  ws.addEventListener('close', rejectAll);
  ws.addEventListener('error', rejectAll);
  ws.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      const item = pending.get(message.id);
      if (item) {
        clearTimeout(item.timer); pending.delete(message.id);
        if (message.error) item.reject(new Error('WSS_RPC_ERROR')); else item.resolve(message.result);
      } else if (message.method === 'eth_subscription') onNotification(message.params);
    } catch { ws.close(); rejectAll(); }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('WSS_CONNECT_TIMEOUT')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WSS_CONNECT_ERROR')); }, { once: true });
  });
  return {
    close: () => ws.close(),
    request: (method, params = []) => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('WSS_DISCONNECTED'));
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('WSS_RPC_TIMEOUT')); }, 10000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }));
    })
  };
}
