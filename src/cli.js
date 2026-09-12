import { configuration, rpcClient, preflight } from './gate.js';
let report;
try {
  const config = configuration(process.env);
  report = await preflight(config, rpcClient(config.url));
} catch (error) {
  const known = ['MISSING_RPC', 'INVALID_RPC_URL', 'INVALID_RPC_PROTOCOL', 'INVALID_CHAIN_ID', 'INVALID_EXCHANGE', 'INVALID_BLOCK', 'RPC_UNAVAILABLE_OR_INVALID'];
  report = { status: 'BLOCKED', coverage: 'unknown', reason: known.includes(error.message) ? error.message : 'PREFLIGHT_ERROR' };
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'FAIL' ? 1 : 2;
