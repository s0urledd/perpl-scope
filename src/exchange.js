// Bounded, pinned-block reader over the Perpl exchange contract.
//
// Every read is an eth_call at an explicit block so that all values inside one
// snapshot are mutually consistent. Batches go through Multicall3 and split
// adaptively when the provider rejects a batch. Nothing here retries a failed
// request; callers decide how to recover.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { readAbi } from './abi.js';
import { bitmapIds } from './snapshot-core.js';

export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const multiAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const hash32 = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;

export const hex = value => '0x' + BigInt(value).toString(16);

export function createReader({ rpc, exchange, multicall = MULTICALL3, batchSize = 50, pageSize = 200, maxPages = 500 }) {
  if (!address.test(exchange)) throw new Error('INVALID_EXCHANGE');
  const stats = { requests: 0, calls: 0, splits: 0, failures: 0 };
  const metered = async (method, params) => {
    stats.requests++;
    try { return await rpc(method, params); } catch (error) { stats.failures++; throw error; }
  };
  const encode = (name, args = []) => encodeFunctionData({ abi: readAbi, functionName: name, args });
  const decode = (name, data) => decodeFunctionResult({ abi: readAbi, functionName: name, data });
  const tag = block => typeof block === 'bigint' ? hex(block) : block;

  async function call(name, args = [], block = 'latest') {
    stats.calls++;
    return decode(name, await metered('eth_call', [{ to: exchange, data: encode(name, args) }, tag(block)]));
  }

  // Executes [{ name, args }] through Multicall3 at one block, in order.
  async function multi(calls, block) {
    const results = new Array(calls.length);
    async function run(indices) {
      const data = encodeFunctionData({ abi: multiAbi, functionName: 'aggregate3', args: [indices.map(i =>
        ({ target: exchange, allowFailure: false, callData: encode(calls[i].name, calls[i].args) }))] });
      let raw;
      try { raw = await metered('eth_call', [{ to: multicall, data }, tag(block)]); }
      catch (error) {
        if (indices.length <= 1) throw error;
        stats.splits++;
        const middle = indices.length >> 1;
        await run(indices.slice(0, middle));
        await run(indices.slice(middle));
        return;
      }
      const out = decodeFunctionResult({ abi: multiAbi, functionName: 'aggregate3', data: raw });
      if (out.length !== indices.length) throw new Error('INCOMPLETE_BATCH');
      indices.forEach((i, k) => {
        if (!out[k].success) throw new Error('CALL_FAILED');
        results[i] = decode(calls[i].name, out[k].returnData);
        stats.calls++;
      });
    }
    for (let first = 0; first < calls.length; first += batchSize) {
      await run(Array.from({ length: Math.min(batchSize, calls.length - first) }, (_, k) => first + k));
    }
    return results;
  }

  async function getBlock(blockTag = 'latest') {
    const block = await metered('eth_getBlockByNumber', [tag(blockTag), false]);
    if (!block || !quantity.test(block.number) || !hash32.test(block.hash) || !hash32.test(block.parentHash) || !quantity.test(block.timestamp)) throw new Error('INVALID_BLOCK');
    return { number: BigInt(block.number), hash: block.hash, parentHash: block.parentHash, timestamp: Number(BigInt(block.timestamp)) };
  }

  async function getLogs({ fromBlock, toBlock, topics }) {
    const logs = await metered('eth_getLogs', [{ address: exchange, fromBlock: hex(fromBlock), toBlock: hex(toBlock), ...(topics ? { topics: [topics] } : {}) }]);
    if (!Array.isArray(logs)) throw new Error('INVALID_LOGS');
    for (const log of logs) {
      if (log.removed || !quantity.test(log.blockNumber) || !hash32.test(log.blockHash) || !hash32.test(log.transactionHash) || !quantity.test(log.logIndex) || !quantity.test(log.transactionIndex) || !Array.isArray(log.topics)) throw new Error('INVALID_LOG');
      if (BigInt(log.blockNumber) < BigInt(fromBlock) || BigInt(log.blockNumber) > BigInt(toBlock)) throw new Error('LOG_OUT_OF_RANGE');
      if (log.address.toLowerCase() !== exchange.toLowerCase()) throw new Error('LOG_ADDRESS_MISMATCH');
    }
    return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  }

  async function readExchange(block) {
    const numeric = typeof block === 'bigint';
    const [info, accounts, interval, version, halted, allowance] = await multi([
      { name: 'getExchangeInfo' }, { name: 'numberOfAccounts' }, { name: 'getFundingInterval' }, { name: 'getContractVersion' }, { name: 'isHalted' },
      ...(numeric ? [{ name: 'getWithdrawAllowanceData', args: [block] }] : [])], block);
    return {
      balanceCNS: info[0], protocolBalanceCNS: info[1], recycleBalanceCNS: info[2],
      collateralDecimals: Number(info[3]), collateralToken: info[4],
      numberOfAccounts: accounts, fundingInterval: interval,
      version: version.map(Number).join('.'), halted: Boolean(halted),
      // Global withdrawal rate limit at this block: remaining allowance, when it expires, refill rate.
      withdrawAllowance: allowance ? { allowanceCNS: allowance[0], expiryBlock: allowance[1], lastAllowanceBlock: allowance[2], cnsPerBlock: allowance[3] } : null
    };
  }

  async function readMarketIds(block) { return bitmapIds(await call('getPerpetualExistsBitmap', [], block)); }

  async function readMarkets(ids, block) {
    const calls = ids.flatMap(id => [
      { name: 'getPerpetualInfoV2', args: [BigInt(id)] },
      { name: 'getMarginFractions', args: [BigInt(id), 0n] },
      { name: 'getLiquidationInfo', args: [BigInt(id)] },
      { name: 'getUnwindInfo', args: [BigInt(id)] }]);
    const results = await multi(calls, block);
    return ids.map((id, i) => {
      const [info, margins, liquidation, unwind] = results.slice(i * 4, i * 4 + 4);
      return {
        id: Number(id), info,
        margins: { initHdths: margins[0], maintHdths: margins[1], dynamicInitHdths: margins[2], oiMaxLNS: margins[3], unityDescentHdths: margins[4], overColDescentHdths: margins[5] },
        liquidation,
        unwind: { status: Number(unwind[0]), sumPositiveFmvCNS: unwind[1], initPositionBalanceCNS: unwind[2] }
      };
    });
  }

  // All open positions of one market via the contract's own paged getter.
  async function readAllPositions(id, block) {
    const positions = [], seen = new Set();
    let start = 0n, markPNS = 0n, markValid = false;
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new Error('PAGE_LIMIT_EXCEEDED');
      const [entries, count, mark, valid] = await call('getPositionsV2', [BigInt(id), start, BigInt(pageSize)], block);
      const filled = entries.slice(0, Number(count));
      if (filled.length > entries.length) throw new Error('INVALID_PAGE');
      markPNS = mark; markValid = Boolean(valid);
      for (const position of filled) {
        const key = position.accountId.toString();
        if (seen.has(key)) throw new Error('DUPLICATE_POSITION');
        seen.add(key);
        if (position.lotLNS === 0n) throw new Error('EMPTY_POSITION_IN_PAGE');
        positions.push(position);
      }
      const last = filled.at(-1);
      if (!last || filled.length < pageSize || last.nextNodeId === 0n) break;
      start = last.nextNodeId;
    }
    return { positions, markPNS, markValid };
  }

  async function readPositions(pairs, block) {
    const results = await multi(pairs.map(p => ({ name: 'getPositionV2', args: [BigInt(p.perpId), BigInt(p.accountId)] })), block);
    return pairs.map((p, i) => ({ perpId: Number(p.perpId), accountId: BigInt(p.accountId), position: results[i][0], markPNS: results[i][1], markValid: Boolean(results[i][2]) }));
  }

  async function readAccounts(ids, block) {
    return multi(ids.map(id => ({ name: 'getAccountById', args: [BigInt(id)] })), block);
  }

  async function readFundingSum(id, atBlock, block) {
    const [sum, eventBlock] = await call('getFundingSumAtBlock', [BigInt(id), BigInt(atBlock)], block);
    return { fundingSumPNS: BigInt(sum), fundingEventBlock: BigInt(eventBlock) };
  }

  return { exchange, stats, call, multi, getBlock, getLogs, readExchange, readMarketIds, readMarkets, readAllPositions, readPositions, readAccounts, readFundingSum };
}
