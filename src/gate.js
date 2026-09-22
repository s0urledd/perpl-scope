const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const hash = /^0x[0-9a-f]{64}$/i;
export function configuration(env) {
  if (!env.MONAD_RPC_URL) throw new Error('MISSING_RPC');
  let url;
  try { url = new URL(env.MONAD_RPC_URL); } catch { throw new Error('INVALID_RPC_URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('INVALID_RPC_PROTOCOL');
  const chain = env.CHAIN_ID || '143';
  if (!/^[1-9][0-9]*$/.test(chain)) throw new Error('INVALID_CHAIN_ID');
  const exchange = env.EXCHANGE_ADDRESS || '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
  if (!/^0x[0-9a-f]{40}$/i.test(exchange)) throw new Error('INVALID_EXCHANGE');
  return { url: url.href, chain, exchange };
}

export function rpcClient(url, fetcher = fetch, { timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  let id = 0;
  return async (method, params) => {
    const requestId = ++id;
    try {
      const response = await fetcher(url, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error('RPC_HTTP');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error('RPC_TOO_LARGE'); }
        chunks.push(Buffer.from(value));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (data.jsonrpc !== '2.0' || data.id !== requestId || data.error || !Object.hasOwn(data, 'result')) throw new Error('RPC_RESPONSE');
      return data.result;
    } catch {
      // Provider messages may include URLs or credentials. Never forward them.
      throw new Error('RPC_UNAVAILABLE_OR_INVALID');
    }
  };
}

export async function preflight(config, rpc) {
  const report = { status: 'BLOCKED', coverage: 'unknown', chain_id: config.chain,
    exchange_address: config.exchange, checks: [],
    remaining: ['SDK and ABI validation', 'Collateral metadata', 'Complete account discovery',
      'Pinned full snapshot', 'Independent position reconciliation', 'Replay reconciliation', 'Resource measurements'] };
  const chain = await rpc('eth_chainId', []);
  if (!quantity.test(chain) || BigInt(chain) !== BigInt(config.chain)) return { ...report, status: 'FAIL', reason: 'CHAIN_MISMATCH' };
  report.checks.push('chain_id');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block || !quantity.test(block.number) || !hash.test(block.hash)) throw new Error('INVALID_BLOCK');
  report.block_number = BigInt(block.number).toString(); report.block_hash = block.hash;
  const code = await rpc('eth_getCode', [config.exchange, block.number]);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) return { ...report, status: 'FAIL', reason: 'EXCHANGE_CODE_MISSING_OR_INVALID' };
  report.checks.push('exchange_bytecode_present');
  const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
  if (!canonical || canonical.hash !== block.hash) return { ...report, status: 'FAIL', reason: 'BLOCK_HASH_CHANGED' };
  report.checks.push('block_hash_rechecked');
  return report;
}
