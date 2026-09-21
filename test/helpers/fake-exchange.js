// A stateful in-memory stand-in for the Perpl exchange contract plus a
// minimal chain, used to exercise the collector end to end without a network.
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem';
import { readAbi, eventsAbi } from '../../src/abi.js';
import { MULTICALL3 } from '../../src/exchange.js';

const multiAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
export const EXCHANGE = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
const hex = n => '0x' + BigInt(n).toString(16);
const blockHash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');

export function createFakeExchange({ markets = [1, 20], fundingInterval = 8571n } = {}) {
  const chain = { head: 1000n, logs: [], forkFrom: null };
  const state = {
    markets: new Map(markets.map(id => [id, { id, symbol: id === 1 ? 'BTC' : 'ETH', priceDecimals: 1n, lotDecimals: 5n, markPNS: 1000000n, oraclePNS: 1000100n, maintHdths: 2500n, initHdths: 1500n, insurance: 5000000000n, positions: new Map(), longOI: 0n, shortOI: 0n }])),
    accounts: 0n, halted: false, fundingInterval
  };
  const info = market => ({ name: market.symbol + ' Perp', symbol: market.symbol, priceDecimals: market.priceDecimals, lotDecimals: market.lotDecimals, linkFeedId: '0x' + '00'.repeat(32), priceTolPer100K: 5000n, marginTol: 100n, marginTolDecimals: 9n, refPriceMaxAgeSec: 60n, positionBalanceCNS: 0n, insuranceBalanceCNS: market.insurance, markPNS: market.markPNS, markTimestamp: 1790000000n, lastPNS: market.markPNS, lastTimestamp: 1790000000n, oraclePNS: market.oraclePNS, oracleTimestampSec: 1790000000n, longOpenInterestLNS: market.longOI, shortOpenInterestLNS: market.shortOI, fundingStartBlock: 0n, fundingRatePct100k: -4, absFundingClampPctPer100K: 10n, status: 4, basePricePNS: 0n, maxBidPriceONS: 0n, minBidPriceONS: 0n, maxAskPriceONS: 0n, minAskPriceONS: 0n, numOrders: 0n, ignOracle: false, fundingSumScalingExp: 0n });
  const positionOf = (market, accountId) => {
    const p = market.positions.get(accountId.toString());
    return p ? { accountId, nextNodeId: 0n, prevNodeId: 0n, positionType: p.positionType, depositCNS: p.depositCNS, pricePNS: p.pricePNS, lotLNS: p.lotLNS, entryBlock: p.entryBlock, pnlCNS: 0n, deltaPnlCNS: 0n, premiumPnlCNS: p.premiumPnlCNS, priceResiduePNSQ16: 0n }
      : { accountId: 0n, nextNodeId: 0n, prevNodeId: 0n, positionType: 0, depositCNS: 0n, pricePNS: 0n, lotLNS: 0n, entryBlock: 0n, pnlCNS: 0n, deltaPnlCNS: 0n, premiumPnlCNS: 0n, priceResiduePNSQ16: 0n };
  };
  function bitmapFor(accountId) {
    const banks = [0n, 0n, 0n, 0n];
    for (const market of state.markets.values()) if (market.positions.has(accountId.toString())) {
      const id = market.id;
      if (id < 253) banks[0] |= 1n << BigInt(id); else if (id < 509) banks[1] |= 1n << BigInt(id - 253); else if (id < 765) banks[2] |= 1n << BigInt(id - 509); else banks[3] |= 1n << BigInt(id - 765);
    }
    return { bank1: banks[0], bank2: banks[1], bank3: banks[2], bank4: banks[3] };
  }
  function dispatch(name, args) {
    const market = id => { const m = state.markets.get(Number(id)); if (!m) throw new Error('NO_MARKET'); return m; };
    switch (name) {
      case 'getExchangeInfo': return [0n, 0n, 0n, 6n, '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', '0x0000000000000000000000000000000000000001'];
      case 'numberOfAccounts': return state.accounts;
      case 'getFundingInterval': return state.fundingInterval;
      case 'getContractVersion': return [1n, 7n, 4n];
      case 'isHalted': return state.halted;
      case 'getPerpetualExistsBitmap': { const words = [0n, 0n, 0n, 0n]; for (const id of state.markets.keys()) words[Math.floor(id / 256)] |= 1n << BigInt(id % 256); return words; }
      case 'getPerpetualInfoV2': return info(market(args[0]));
      case 'getMarginFractions': { const m = market(args[0]); return [m.initHdths, m.maintHdths, m.initHdths, 30000000n, 90n, 95n]; }
      case 'getLiquidationInfo': return { liqInsAmtPer100K: 10000n, liqUserAmtPer100K: 80000n, liqProtocolAmtPer100K: 10000n, btlPriceThreshPer100K: 95000n, btlInsAmtPer100K: 25000n, btlUserAmtPer100K: 25000n, btlBuyerAmtPer100K: 25000n, btlProtocolAmtPer100K: 25000n, btlRestrictBuyers: true };
      case 'getUnwindInfo': return [4, 0n, 0n];
      case 'getPositionsV2': {
        const m = market(args[0]); const perPage = Number(args[2]);
        const ids = [...m.positions.keys()].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
        const start = args[1] === 0n ? 0 : ids.indexOf(args[1]);
        const page = ids.slice(start, start + perPage).map((id, i, all) => ({ ...positionOf(m, id), nextNodeId: ids[start + i + 1] ?? 0n }));
        const padded = [...page, ...Array.from({ length: perPage - page.length }, () => positionOf(m, 0n))];
        return [padded, BigInt(page.length), m.markPNS, true];
      }
      case 'getPositionV2': return [positionOf(market(args[0]), args[1]), market(args[0]).markPNS, true];
      case 'getAccountById': return { accountId: args[0], balanceCNS: 0n, lockedBalanceCNS: 0n, frozen: 0, accountAddr: '0x' + args[0].toString(16).padStart(40, '0'), positions: bitmapFor(args[0]) };
      default: throw new Error('UNSUPPORTED:' + name);
    }
  }
  const stats = { requests: 0, byMethod: {} };
  async function rpc(method, params) {
    stats.requests++; stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0];
      const number = tag === 'latest' || tag === 'finalized' ? chain.head : BigInt(tag);
      if (number > chain.head) return null;
      const forked = chain.forkFrom !== null && number >= chain.forkFrom;
      return { number: hex(number), hash: blockHash(forked ? number + 1000000n : number), parentHash: blockHash(number - 1n), timestamp: hex(1790000000n + number) };
    }
    if (method === 'eth_getLogs') {
      const { fromBlock, toBlock, topics } = params[0];
      return chain.logs.filter(l => BigInt(l.blockNumber) >= BigInt(fromBlock) && BigInt(l.blockNumber) <= BigInt(toBlock) && (!topics || topics[0].includes(l.topics[0])));
    }
    if (method !== 'eth_call') throw new Error('UNSUPPORTED_METHOD:' + method);
    const { to, data } = params[0];
    if (to.toLowerCase() === MULTICALL3) {
      const { args: [calls] } = decodeFunctionData({ abi: multiAbi, data });
      const results = calls.map(c => { const { functionName, args } = decodeFunctionData({ abi: readAbi, data: c.callData }); return { success: true, returnData: encodeFunctionResult({ abi: readAbi, functionName, result: dispatch(functionName, args) }) }; });
      return encodeFunctionResult({ abi: multiAbi, functionName: 'aggregate3', result: results });
    }
    const { functionName, args } = decodeFunctionData({ abi: readAbi, data });
    return encodeFunctionResult({ abi: readAbi, functionName, result: dispatch(functionName, args) });
  }
  function emit(name, values, block = chain.head) {
    const item = eventsAbi.find(e => e.name === name);
    const indexed = item.inputs.filter(i => i.indexed), plain = item.inputs.filter(i => !i.indexed);
    const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(indexed.map(i => [i.name, values[i.name]])) });
    chain.logs.push({ address: EXCHANGE, blockNumber: hex(block), blockHash: blockHash(block), transactionHash: '0x' + chain.logs.length.toString(16).padStart(64, '0'), transactionIndex: '0x0', logIndex: hex(chain.logs.length), topics, data: encodeAbiParameters(plain, plain.map(i => values[i.name])), removed: false });
  }
  // Test-side mutations that keep OI counters consistent and emit events.
  function open(perpId, accountId, positionType, lotLNS, depositCNS = 10000000000n, pricePNS = null) {
    const m = state.markets.get(perpId);
    m.positions.set(accountId.toString(), { positionType, lotLNS, depositCNS, pricePNS: pricePNS ?? m.markPNS, entryBlock: chain.head, premiumPnlCNS: 0n });
    if (positionType === 0) m.longOI += lotLNS; else m.shortOI += lotLNS;
    if (accountId > state.accounts) state.accounts = accountId;
    emit('PositionOpenedV2', { perpId: BigInt(perpId), accountId, positionType, leverageHdths: 1000n, depositCNS, pnlCollateralizedCNS: 0n, pricePNS: m.markPNS, lotLNS, insFeeCNS: 0n, protFeeCNS: 0n, priceResiduePNSQ16: 0n });
  }
  function close(perpId, accountId) {
    const m = state.markets.get(perpId); const p = m.positions.get(accountId.toString());
    if (p.positionType === 0) m.longOI -= p.lotLNS; else m.shortOI -= p.lotLNS;
    m.positions.delete(accountId.toString());
    emit('PositionClosed', { perpId: BigInt(perpId), accountId, positionType: p.positionType, pricePNS: m.markPNS, deltaPnlCNS: 0n, fundingCNS: 0n });
  }
  function silentDrift(perpId, accountId, lotLNS) { // corrupts OI without an event, to simulate a missed update
    const m = state.markets.get(perpId); const p = m.positions.get(accountId.toString()); p.lotLNS += lotLNS; if (p.positionType === 0) m.longOI += lotLNS; else m.shortOI += lotLNS;
  }
  function funding(perpId, paymentPNS) {
    const m = state.markets.get(perpId);
    for (const p of m.positions.values()) p.premiumPnlCNS += (p.positionType === 0 ? -1n : 1n) * paymentPNS * p.lotLNS * 1000000n / (10n ** m.priceDecimals * 10n ** m.lotDecimals);
  }
  return { rpc, chain, state, stats, emit, open, close, silentDrift, funding, advance: (n = 1n) => { chain.head += n; return chain.head; }, fork: from => { chain.forkFrom = from; } };
}
