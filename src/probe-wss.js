import { writeFile, mkdir } from 'node:fs/promises';
const url = process.env.MONAD_WSS_URL;
if (!url || !url.startsWith('wss://')) throw new Error('WSS_URL_REQUIRED');
const report = { protocol: 'JSON-RPC WebSocket', heads: [], calls: [], status: 'BLOCKED' };
const started = performance.now();
const ws = new WebSocket(url);
const pending = new Map(); let id = 0, subscription;
const request = (method, params) => new Promise((resolve, reject) => {
  const key = ++id, begin = performance.now();
  const timeout = setTimeout(() => { pending.delete(key); reject(new Error('RPC_TIMEOUT')); }, 8000);
  pending.set(key, { resolve: result => { clearTimeout(timeout); report.calls.push({ method, ms: Math.round(performance.now() - begin) }); resolve(result); }, reject });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }));
});
await new Promise(resolve => {
  const deadline = setTimeout(() => { ws.close(); resolve(); }, 20000);
  ws.addEventListener('error', () => { report.error = 'WSS_CONNECTION_ERROR'; clearTimeout(deadline); resolve(); });
  ws.addEventListener('message', event => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const item = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) item.reject(new Error('RPC_ERROR')); else item.resolve(msg.result);
      } else if (msg.method === 'eth_subscription' && msg.params?.subscription === subscription) {
        const head = msg.params.result;
        report.heads.push({ number: head.number, hash: head.hash, arrival_ms: Math.round(performance.now() - started) });
      }
    } catch { report.error = 'INVALID_WSS_MESSAGE'; }
  });
  ws.addEventListener('open', async () => {
    try {
      report.chain_id = await request('eth_chainId', []);
      if (report.chain_id !== '0x8f') throw new Error('CHAIN_MISMATCH');
      subscription = await request('eth_subscribe', ['newHeads']);
      report.subscription = subscription;
      report.block_number = await request('eth_blockNumber', []);
    } catch { report.error = 'WSS_RPC_PROBE_FAILED'; ws.close(); clearTimeout(deadline); resolve(); }
  });
});
ws.close();
if (!report.error && report.heads.length > 0 && report.chain_id === '0x8f') report.status = 'PASS';
report.note = 'Connectivity and head delivery only. No HTTP comparison, replay or reconnect proof.';
await mkdir('reports', { recursive: true });
await writeFile('reports/wss-probe.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, heads: report.heads.length }, null, 2));
