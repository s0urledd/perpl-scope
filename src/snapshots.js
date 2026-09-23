// Contract-state samples written to ClickHouse at most once per interval
// (default every 5 minutes, aligned): mark and oracle prices, open interest,
// funding rate and insurance per market, TVL and account count per exchange.
// Events cannot reproduce these (mark prices and balances are state), so the
// history accumulates from the day the service runs.
import { metrics as computeMetrics } from './state.js';

export function createSnapshots({ ch, collector, log = () => {}, everySeconds = 300 }) {
  const { state } = collector;
  let last = null, writing = false;
  async function maybeRecord() {
    if (writing || !state.block || !state.exchangeInfo) return false;
    const slot = Math.floor(state.block.timestamp / everySeconds) * everySeconds;
    if (slot === last) return false;
    writing = true;
    try {
      const computed = computeMetrics(state);
      const rows = computed.markets.map(({ market, metrics: x }) => ({ ts: slot, block: state.block.number, market: market.id, mark: market.markPNS, oracle: market.oraclePNS, long_oi: market.longOpenInterestLNS, short_oi: market.shortOpenInterestLNS, funding_rate: market.fundingRatePct100k, insurance: market.insuranceBalanceCNS, positions: x.positions.length, longs: x.long.count, shorts: x.short.count }));
      await ch.insert('snapshots', rows);
      await ch.insert('exchange_snapshots', [{ ts: slot, block: state.block.number, tvl: state.exchangeInfo.balanceCNS, protocol_balance: state.exchangeInfo.protocolBalanceCNS, accounts: Number(state.exchangeInfo.numberOfAccounts) }]);
      last = slot;
      return true;
    } catch (error) { log('warn', `snapshot failed: ${error.message}`); return false; }
    finally { writing = false; }
  }
  return { maybeRecord };
}
