// Aggregate definitions shared by the hourly rollups and by window queries
// over raw events, so a number is computed by exactly one SQL expression
// whether it comes from a closed hour or from the last few minutes.
//
//   volume    maker-fill notional (each match once)
//   fees      maker + taker fill fees (= insurance + protocol fee on the
//             position events); a builder's share is part of the fill fee
//             and of the protocol fee, never added on top
//   realized  deltaPnl + funding on decrease, close, invert, liquidation and
//             deleverage events, plus the funding settled when a position is
//             increased (the contract realizes it whenever the lot changes)
//   oi_*      signed lot changes per side; their running sum from the
//             deployment block is the open interest (checked against the
//             contract's counters)
export const USER = "('open','increase','decrease','close','invert')";
export const REALIZING = "('increase','decrease','close','invert','liquidation','deleverage')";
export const FILLS = "('maker_fill','taker_fill')";
export const ACCOUNT_TRADES = `(kind IN ${USER} OR (kind = 'liquidation' AND role = 'taker'))`;

// [column, raw expression over ev, merge expression over rollup rows]
export const MARKET = [
  ['volume', "sumIf(notional, kind = 'maker_fill')", 'sum(volume)'],
  ['lots', "sumIf(lot, kind = 'maker_fill')", 'sum(lots)'],
  ['fills', "countIf(kind = 'maker_fill')", 'sum(fills)'],
  ['maker_fees', "sumIf(fee, kind = 'maker_fill')", 'sum(maker_fees)'],
  ['taker_fees', "sumIf(fee, kind = 'taker_fill')", 'sum(taker_fees)'],
  ['builder_fees', `sumIf(builder_fee, kind IN ${FILLS})`, 'sum(builder_fees)'],
  ['ins_fees', "sumIf(ins_fee, kind IN ('open','increase','invert'))", 'sum(ins_fees)'],
  ['prot_fees', "sumIf(prot_fee, kind IN ('open','increase','invert'))", 'sum(prot_fees)'],
  ['taker_buy', `sumIf(notional, kind IN ${USER} AND role = 'taker' AND buy = 1)`, 'sum(taker_buy)'],
  ['taker_sell', `sumIf(notional, kind IN ${USER} AND role = 'taker' AND buy = 0)`, 'sum(taker_sell)'],
  ['trades', `countIf(kind IN ${USER})`, 'sum(trades)'],
  ['opens', "countIf(kind = 'open')", 'sum(opens)'],
  ['closes', "countIf(kind = 'close')", 'sum(closes)'],
  ['liquidations', "countIf(kind = 'liquidation')", 'sum(liquidations)'],
  ['liquidated', "sumIf(notional, kind = 'liquidation')", 'sum(liquidated)'],
  ['deleverages', "countIf(kind = 'deleverage')", 'sum(deleverages)'],
  ['deleveraged', "sumIf(notional, kind = 'deleverage')", 'sum(deleveraged)'],
  ['realized', `sumIf(pnl + funding, kind IN ${REALIZING})`, 'sum(realized)'],
  ['funding_paid', `sumIf(funding, kind IN ${REALIZING})`, 'sum(funding_paid)'],
  ['oi_long', 'sum(oi_long)', 'sum(oi_long)'],
  ['oi_short', 'sum(oi_short)', 'sum(oi_short)'],
  ['open_price', "argMinIf(price, (block, log_index), kind = 'maker_fill')", 'argMinIf(open_price, open_key, fills > 0)'],
  ['open_key', "minIf(block * 4294967296 + log_index, kind = 'maker_fill')", 'minIf(open_key, fills > 0)'],
  ['high_price', "maxIf(price, kind = 'maker_fill')", 'max(high_price)'],
  ['low_price', "minIf(price, kind = 'maker_fill')", 'minIf(low_price, fills > 0)'],
  ['close_price', "argMaxIf(price, (block, log_index), kind = 'maker_fill')", 'argMaxIf(close_price, close_key, fills > 0)'],
  ['close_key', "maxIf(block * 4294967296 + log_index, kind = 'maker_fill')", 'max(close_key)']
];

export const PROTOCOL = [
  ['deposits', "sumIf(amount, kind = 'deposit')", 'sum(deposits)'],
  ['deposit_count', "countIf(kind = 'deposit')", 'sum(deposit_count)'],
  ['withdrawals', "sumIf(amount, kind = 'withdrawal')", 'sum(withdrawals)'],
  ['withdrawal_count', "countIf(kind = 'withdrawal')", 'sum(withdrawal_count)'],
  ['protocol_in', "sumIf(amount, kind = 'protocol_deposit')", 'sum(protocol_in)'],
  ['protocol_out', "sumIf(amount, kind = 'protocol_withdrawal')", 'sum(protocol_out)'],
  ['new_accounts', "countIf(kind = 'account')", 'sum(new_accounts)']
];

export const ACCOUNT = [
  ['volume', `sumIf(notional, ${ACCOUNT_TRADES})`, 'sum(volume)'],
  ['maker_volume', `sumIf(notional, kind IN ${USER} AND role = 'maker')`, 'sum(maker_volume)'],
  ['trades', `countIf(${ACCOUNT_TRADES})`, 'sum(trades)'],
  ['fees', `sumIf(fee, kind IN ${USER} OR kind = 'liquidation')`, 'sum(fees)'], // trading fees and liquidation fees
  ['realized', `sumIf(pnl + funding, kind IN ${REALIZING})`, 'sum(realized)'],
  ['funding_paid', `sumIf(funding, kind IN ${REALIZING})`, 'sum(funding_paid)'],
  ['liquidations', "countIf(kind = 'liquidation')", 'sum(liquidations)'],
  ['liquidated', "sumIf(notional, kind = 'liquidation')", 'sum(liquidated)'],
  ['deposits', "sumIf(amount, kind = 'deposit')", 'sum(deposits)'],
  ['withdrawals', "sumIf(amount, kind = 'withdrawal')", 'sum(withdrawals)']
];

// Aliases never shadow the raw columns they are computed from.
export const SQL_SETTINGS = { prefer_column_name_to_alias: 1 };
export const raw = defs => defs.map(([c, e]) => `${e} AS ${c}`).join(',\n  ');
export const merged = defs => defs.map(([c, , e]) => `${e} AS ${c}`).join(',\n  ');
export const columns = defs => defs.map(([c]) => c).join(', ');
