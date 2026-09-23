// Synthetic exchange logs for index and analytics tests.
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { eventsAbi } from '../../src/abi.js';

export const EXCHANGE = '0x34b6552d57a35a1d042ccae1951bd1c370112a6f';
const hex = v => '0x' + BigInt(v).toString(16);
const hash = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
// Synthetic block times: one block per second from a fixed epoch.
export const BLOCK_TS = block => 1790000000 + Number(block);

// Builds a log for `name` at `block`; logs sharing `tx` belong to one transaction.
export function makeLog(name, values, { block, tx, logIndex }) {
  const item = eventsAbi.find(e => e.type === 'event' && e.name === name);
  if (!item) throw new Error('UNKNOWN_EVENT:' + name);
  const indexed = item.inputs.filter(i => i.indexed), plain = item.inputs.filter(i => !i.indexed);
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(indexed.map(i => [i.name, values[i.name]])) });
  return { address: EXCHANGE, blockNumber: hex(block), blockHash: hash(1000000n + BigInt(block)), blockTimestamp: hex(BLOCK_TS(block)), transactionHash: hash(tx), transactionIndex: hex(tx), logIndex: hex(logIndex), topics, data: encodeAbiParameters(plain, plain.map(i => { if (values[i.name] === undefined) throw new Error(`MISSING:${name}.${i.name}`); return values[i.name]; })), removed: false };
}

// A sequential log builder: `tx()` starts a transaction, `add(name, values)` appends.
export function logBuilder() {
  const logs = [];
  let block = 100n, txN = 0, idx = 0;
  return {
    logs,
    at(b) { block = BigInt(b); return this; },
    tx() { txN++; return this; },
    add(name, values) { logs.push(makeLog(name, values, { block, tx: txN, logIndex: idx++ })); return this; }
  };
}

export const ev = {
  open: (perpId, accountId, side, pricePNS, lotLNS, extra = {}) => ['PositionOpenedV2', { perpId: BigInt(perpId), accountId: BigInt(accountId), positionType: side, leverageHdths: 1000n, depositCNS: 1000000000n, pnlCollateralizedCNS: 0n, pricePNS, lotLNS, insFeeCNS: 100n, protFeeCNS: 900n, priceResiduePNSQ16: 0n, ...extra }],
  increase: (perpId, accountId, side, blendedPNS, startLot, endLot, extra = {}) => ['PositionIncreasedV2', { perpId: BigInt(perpId), accountId: BigInt(accountId), positionType: side, leverageHdths: 1000n, startDepositCNS: 1000000000n, endDepositCNS: 2000000000n, pnlCollateralizedCNS: 0n, premiumPnlSettledCNS: 0n, maxNegPnlCollatBPS: 0n, pricePNS: blendedPNS, startLotLNS: startLot, endLotLNS: endLot, insFeeCNS: 50n, protFeeCNS: 450n, priceResiduePNSQ16: 0n, ...extra }],
  decrease: (perpId, accountId, side, startLot, endLot, pnl, funding = 0n) => ['PositionDecreased', { perpId: BigInt(perpId), accountId: BigInt(accountId), positionType: side, startDepositCNS: 2000000000n, endDepositCNS: 1000000000n, startLotLNS: startLot, endLotLNS: endLot, deltaPnlCNS: pnl, fundingCNS: funding }],
  close: (perpId, accountId, side, pricePNS, pnl, funding = 0n) => ['PositionClosed', { perpId: BigInt(perpId), accountId: BigInt(accountId), positionType: side, pricePNS, deltaPnlCNS: pnl, fundingCNS: funding }],
  invert: (perpId, accountId, side, pricePNS, startLot, endLot, pnl) => ['PositionInverted', { perpId: BigInt(perpId), accountId: BigInt(accountId), positionType: side, leverageHdths: 1000n, startDepositCNS: 1000000000n, endDepositCNS: 1000000000n, pnlCollateralizedCNS: 0n, pricePNS, startLotLNS: startLot, endLotLNS: endLot, deltaPnlCNS: pnl, fundingCNS: 0n, insFeeCNS: 10n, protFeeCNS: 90n }],
  liquidation: (perpId, accountId, side, liqPNS, liqLot, remaining, pnl) => ['PositionLiquidated', { perpId: BigInt(perpId), accountId: BigInt(accountId), posAccountId: BigInt(accountId), positionType: side, markPricePNS: liqPNS, liqPricePNS: liqPNS, liqLotLNS: liqLot, posLotLNS: remaining, deltaPnlCNS: pnl, fundingCNS: 0n, posAmountCNS: 0n, posDepositCNS: 0n, accAmountCNS: 0n, accBalanceCNS: 0n, onOrderBook: false }],
  makerFill: (perpId, accountId, pricePNS, lotLNS, feeCNS = 0n) => ['MakerOrderFilledV2', { perpId: BigInt(perpId), accountId: BigInt(accountId), orderId: 1n, pricePNS, lotLNS, feeCNS, lockedBalanceCNS: 0n, amountCNS: 0n, balanceCNS: 0n, builderId: 0n, builderFeeCNS: 0n }],
  takerFill: (pricePNS, lotLNS, feeCNS = 0n, builderFeeCNS = 0n) => ['TakerOrderFilledV2', { entryPricePNS: pricePNS, collatPricePNS: pricePNS, pnlPricePNS: pricePNS, lotLNS, feeCNS, amountCNS: 0n, balanceCNS: 0n, builderId: 0n, builderFeeCNS }],
  deposit: (accountId, amountCNS) => ['CollateralDeposit', { accountId: BigInt(accountId), amountCNS, balanceCNS: amountCNS }],
  withdrawal: (accountId, amountCNS) => ['CollateralWithdrawal', { accountId: BigInt(accountId), amountCNS, balanceCNS: 0n }],
  account: (id, address) => ['AccountCreated', { account: address, id: BigInt(id) }]
};
