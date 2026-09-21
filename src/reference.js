// Optional cross-check against Perpl's public context endpoint. The endpoint
// is never used to compute a metric; it is compared with the on-chain state
// so that divergences between the venue's own numbers and the contract are
// visible. Values are labelled as reference data throughout the API.
export const DEFAULT_CONTEXT_URL = 'https://app.perpl.xyz/api/v1/pub/context';

export function createReference({ url = DEFAULT_CONTEXT_URL, fetcher = fetch, intervalMs = 30000, timeoutMs = 10000 } = {}) {
  let last = null, error = null, timer = null;
  async function refresh() {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error('REFERENCE_HTTP');
      const context = await response.json();
      if (!Array.isArray(context.markets) || !context.chain) throw new Error('REFERENCE_SHAPE');
      last = { at: Date.now(), chainId: String(context.chain.chain_id), markets: context.markets.map(x => ({ id: Number(x.perpetual_id), name: x.name, isOpen: Boolean(x.config?.is_open), priceDecimals: Number(x.config?.price_decimals), sizeDecimals: Number(x.config?.size_decimals), initialMargin: Number(x.config?.initial_margin), maintenanceMargin: Number(x.config?.maintenance_margin), mark: x.state?.mrk ?? null, oracle: x.state?.orl ?? null, oi: x.state?.oi ?? null, tvl: x.state?.tvl ?? null, dailyVolume: x.state?.dva ?? null, stateBlock: x.state?.at?.b ?? null, fundingRate: x.funding?.rate ?? null, fundingSum: x.funding?.sum ?? null, fundingEventBlock: x.funding?.feb ?? null, contractVersion: Array.isArray(x.config?.contract_version) ? x.config.contract_version.join('.') : null })) };
      error = null;
    } catch (e) { error = { message: e.message.slice(0, 80), at: Date.now() }; }
    return last;
  }
  function start() { refresh(); timer = setInterval(refresh, intervalMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); }
  // Compares the reference with the on-chain market record at the state block.
  function compare(market, latestFundingSum = null) {
    if (!last) return null;
    const ref = last.markets.find(x => x.id === market.id);
    if (!ref) return { found: false };
    const bps = (a, b) => b ? Number((a - b) * 10000n / b) : null;
    const mark = ref.mark === null ? null : BigInt(ref.mark), oi = ref.oi === null ? null : BigInt(ref.oi);
    const rate = ref.fundingRate === null ? null : BigInt(ref.fundingRate);
    return {
      found: true, referenceBlock: ref.stateBlock, referenceAgeMs: Date.now() - last.at,
      markDeltaBps: mark === null ? null : bps(market.markPNS, mark), oiDeltaBps: oi === null ? null : bps(market.longOpenInterestLNS, oi),
      marginFractionsMatch: ref.initialMargin === Number(market.initHdths) && ref.maintenanceMargin === Number(market.maintHdths),
      fundingRateMatch: rate === null ? null : rate === market.fundingRatePct100k * 10n,
      fundingSumMatch: latestFundingSum === null || ref.fundingSum === null ? null : BigInt(ref.fundingSum) === latestFundingSum,
      reference: { mark: ref.mark, oi: ref.oi, fundingRate: ref.fundingRate, fundingSum: ref.fundingSum, fundingEventBlock: ref.fundingEventBlock, tvl: ref.tvl, dailyVolume: ref.dailyVolume, contractVersion: ref.contractVersion }
    };
  }
  return { refresh, start, stop, compare, get last() { return last; }, get error() { return error; } };
}
