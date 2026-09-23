// Market-share context: open interest of perp venues from DefiLlama's public
// open-interest overview. Like the Perpl reference, it is never used to compute
// a Plumb metric; it only places Perpl among other perps, labelled with its
// source. (DefiLlama's derivatives volume overview requires a paid plan.)
export const DEFAULT_LANDSCAPE_URL = 'https://api.llama.fi/overview/open-interest?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';
const SOURCE = { name: 'DefiLlama', url: 'https://defillama.com/open-interest' };

// Venues only: front-ends built on another venue ('Interface') would count its
// open interest twice, and prediction markets are not perps.
const CATEGORIES = new Set(['Derivatives']);

export function summarize(body, { top = 10, self = 'Perpl', chain = 'Monad' } = {}) {
  if (!Array.isArray(body?.protocols)) throw new Error('LANDSCAPE_SHAPE');
  const rows = body.protocols
    .filter(p => CATEGORIES.has(p.category))
    .map(p => ({ name: String(p.displayName || p.name || ''), oi: Number(p.total24h), chains: Array.isArray(p.chains) ? p.chains.map(String) : [] }))
    .filter(p => p.name && Number.isFinite(p.oi) && p.oi > 0)
    .sort((a, b) => b.oi - a.oi);
  const total = rows.reduce((a, p) => a + p.oi, 0);
  const isSelf = p => p.name.toLowerCase() === self.toLowerCase();
  const index = rows.findIndex(isSelf);
  const onChain = rows.filter(p => p.chains.includes(chain));
  const chainTotal = onChain.reduce((a, p) => a + p.oi, 0);
  const share = (v, of) => (of > 0 ? Math.round(v / of * 10000) / 100 : null);
  const selfRow = index >= 0 ? rows[index] : null;
  return {
    source: SOURCE,
    metric: 'open_interest',
    venues: rows.length,
    total_oi: total,
    perpl: selfRow ? { oi: selfRow.oi, rank: index + 1, share_pct: share(selfRow.oi, total), share_of_chain_pct: share(selfRow.oi, chainTotal) } : null,
    chain: { name: chain, total_oi: chainTotal, venues: onChain.map(p => ({ name: p.name, oi: p.oi, share_pct: share(p.oi, chainTotal), self: isSelf(p) })) },
    top: rows.slice(0, top).map((p, i) => ({ rank: i + 1, name: p.name, oi: p.oi, share_pct: share(p.oi, total) }))
  };
}

export function createLandscape({ url = DEFAULT_LANDSCAPE_URL, fetcher = fetch, ttlMs = 10 * 60000, timeoutMs = 15000, now = () => Date.now() } = {}) {
  let last = null, error = null, pending = null;
  async function refresh() {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`LANDSCAPE_HTTP_${response.status}`);
      last = { at: now(), data: summarize(await response.json()) };
      error = null;
    } catch (e) { error = { message: String(e.message).slice(0, 80), at: now() }; }
  }
  // Serves the cached summary; refreshes when older than the TTL (errors retry after a minute).
  async function get() {
    const stale = !last || now() - last.at >= ttlMs;
    const retry = !error || now() - error.at >= 60000;
    if (stale && retry) { pending ??= refresh().finally(() => { pending = null; }); await pending; }
    if (!last) throw Object.assign(new Error('LANDSCAPE_UNAVAILABLE'), { status: 503 });
    return { fetched_at: last.at, error: error?.message ?? null, ...last.data };
  }
  return { get };
}
