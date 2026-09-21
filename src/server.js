// Entry point: collector + HTTP API + dashboard.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { configuration, rpcClient } from './gate.js';
import { createCollector, collectorOptions } from './collector.js';
import { createReference } from './reference.js';
import { createApi } from './api.js';

const log = (level, message) => console.log(JSON.stringify({ t: new Date().toISOString(), level, message }));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const config = configuration(process.env);
const rpc = rpcClient(config.url, fetch, { timeoutMs: Number(process.env.RPC_TIMEOUT_MS || 15000), maxBytes: Number(process.env.RPC_MAX_BYTES || 4 * 1024 * 1024) });
const collector = createCollector({ config, options: collectorOptions(process.env), rpc, log });
const reference = process.env.REFERENCE_DISABLED === '1' ? null : createReference({ url: process.env.PERPL_CONTEXT_URL || undefined });
const api = createApi({ collector, reference, version: pkg.version });
const port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0';
const server = createServer((req, res) => { api.handle(req, res).catch(error => { log('error', `request failed: ${error.message}`); if (!res.headersSent) { res.writeHead(500); res.end(); } }); });
server.listen(port, host, () => log('info', `perpl-scope ${pkg.version} listening on ${host}:${port} (chain ${config.chain})`));
reference?.start();
const run = collector.start();
let stopping = false;
async function shutdown(signal) {
  if (stopping) return; stopping = true;
  log('info', `${signal} received; checkpointing`);
  collector.stop(); reference?.stop();
  try { await collector.checkpoint(); } catch (error) { log('warn', `checkpoint failed: ${error.message}`); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
run.catch(error => { log('error', `collector stopped: ${error.message}`); process.exitCode = 1; });
