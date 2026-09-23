// Configuration and a bounded JSON-RPC client. Provider error text can carry
// URLs or credentials, so it never leaves this module: callers get a fixed
// message plus a coarse `kind` that tells the ingest whether to split a
// range (limit), try an archive (pruned), back off (rate, timeout) or give up.
const hexAddress = /^0x[0-9a-f]{40}$/i;

export const DEFAULT_EXCHANGE = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
export const DEFAULT_DEPLOY_BLOCK = 54773010n;

function httpUrl(value, code) {
  let url;
  try { url = new URL(value); } catch { throw new Error(code); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`${code}_PROTOCOL`);
  return url.href;
}

export function configuration(env) {
  if (!env.MONAD_RPC_URL) throw new Error('MISSING_RPC');
  const url = httpUrl(env.MONAD_RPC_URL, 'INVALID_RPC_URL');
  const chain = env.CHAIN_ID || '143';
  if (!/^[1-9][0-9]*$/.test(chain)) throw new Error('INVALID_CHAIN_ID');
  const exchange = env.EXCHANGE_ADDRESS || DEFAULT_EXCHANGE;
  if (!hexAddress.test(exchange)) throw new Error('INVALID_EXCHANGE');
  const deployBlock = BigInt(env.EXCHANGE_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK);
  const archives = (env.ARCHIVE_RPC_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(u => httpUrl(u, 'INVALID_ARCHIVE_URL'));
  return { url, chain, exchange, deployBlock, archives, wsUrl: env.MONAD_WS_URL ? env.MONAD_WS_URL : null, monodeUrl: env.MONODE_WS_URL || null };
}

const LIMIT = /range|too (many|large|big)|exceed|limit|maximum|max (block|result|log)|response size|query returned more/i;
const PRUNED = /triedb|archive|prun|missing trie|not (found|available)|header not found|unknown block|historical state/i;
const RATE = /rate|throttl|capacity|busy/i;

export function classify({ status = null, error = null, cause = null } = {}) {
  if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') return 'timeout';
  if (status === 429) return 'rate';
  const message = String(error?.message ?? '');
  if (LIMIT.test(message) || error?.code === -32005) return 'limit';
  if (PRUNED.test(message)) return 'pruned';
  if (RATE.test(message)) return 'rate';
  return 'other';
}

const rpcError = kind => Object.assign(new Error('RPC_UNAVAILABLE_OR_INVALID'), { kind });

export function rpcClient(url, fetcher = fetch, { timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  let id = 0;
  const stats = { requests: 0, failures: 0, bytes: 0 };
  const call = async (method, params) => {
    const requestId = ++id;
    stats.requests++;
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) { stats.failures++; throw rpcError(classify({ cause })); }
    try {
      if (!response.ok) throw rpcError(classify({ status: response.status }));
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); throw rpcError('limit'); }
        chunks.push(Buffer.from(value));
      }
      stats.bytes += size;
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (data.error) throw rpcError(classify({ error: data.error }));
      if (data.jsonrpc !== '2.0' || data.id !== requestId || !Object.hasOwn(data, 'result')) throw rpcError('other');
      return data.result;
    } catch (error) {
      stats.failures++;
      if (error.message === 'RPC_UNAVAILABLE_OR_INVALID') throw error;
      throw rpcError(classify({ cause: error }));
    }
  };
  call.stats = stats;
  return call;
}
