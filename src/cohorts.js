// Who holds the open interest: live positions grouped into cohorts of
// accounts, by size (total open notional now) and by track record (net PnL
// over the indexed history). For each cohort: accounts long and short, their
// notional, unrealized PnL and how many are in profit, plus the largest
// accounts so every cohort drills down to wallets.
export const SIZE_COHORTS = [
  { key: 'whale', label: 'Whales', rule: '≥ $100K open', min: 100000 },
  { key: 'dolphin', label: 'Dolphins', rule: '$10K–100K open', min: 10000 },
  { key: 'fish', label: 'Fish', rule: '$1K–10K open', min: 1000 },
  { key: 'shrimp', label: 'Shrimp', rule: '< $1K open', min: -Infinity }
];
export const PNL_COHORTS = [
  { key: 'top', label: 'Top winners', rule: 'net PnL ≥ +$10K', min: 10000 },
  { key: 'winner', label: 'Profitable', rule: '$0 to +$10K', min: 0.000001 },
  { key: 'loser', label: 'Losing', rule: '−$10K to $0', min: -10000 },
  { key: 'rekt', label: 'Rekt', rule: '≤ −$10K', min: -Infinity }
];

// positions: [{ account, market, symbol, side: 'long'|'short', notional, upnl }] (numbers, USD)
// pnlOf: account -> net PnL over the indexed history (or undefined: no trades indexed)
export function cohortTable(positions, pnlOf, { top = 8 } = {}) {
  const accounts = new Map();
  for (const p of positions) {
    let a = accounts.get(p.account);
    if (!a) { a = { account: p.account, long: 0, short: 0, upnl: 0, markets: new Map() }; accounts.set(p.account, a); }
    a[p.side === 'long' ? 'long' : 'short'] += p.notional;
    a.upnl += p.upnl;
    const m = a.markets.get(p.market) ?? { market: p.market, symbol: p.symbol, long: 0, short: 0 };
    m[p.side === 'long' ? 'long' : 'short'] += p.notional;
    a.markets.set(p.market, m);
  }
  const list = [...accounts.values()].map(a => ({ ...a, notional: a.long + a.short, net: a.long - a.short, pnl: pnlOf(a.account) }));
  const group = (defs, value) => defs.map(def => {
    // An account belongs to the first cohort whose floor it reaches; no value, no cohort.
    const members = list.filter(a => { const v = value(a); return v !== undefined && v !== null && defs.find(d => v >= d.min) === def; });
    const sum = f => members.reduce((s, a) => s + f(a), 0);
    const long = sum(a => a.long), short = sum(a => a.short);
    const byMarket = new Map();
    for (const a of members) for (const m of a.markets.values()) { const b = byMarket.get(m.market) ?? { market: m.market, symbol: m.symbol, long: 0, short: 0 }; b.long += m.long; b.short += m.short; byMarket.set(m.market, b); }
    return {
      key: def.key, label: def.label, rule: def.rule,
      accounts: members.length,
      net_long_accounts: members.filter(a => a.net > 0).length, net_short_accounts: members.filter(a => a.net < 0).length,
      long_notional: long, short_notional: short, net_notional: long - short,
      long_share_pct: long + short > 0 ? Math.round(long / (long + short) * 10000) / 100 : null,
      unrealized_pnl: sum(a => a.upnl), in_profit: members.filter(a => a.upnl > 0).length,
      markets: [...byMarket.values()].sort((x, y) => (y.long + y.short) - (x.long + x.short)).slice(0, 6),
      top: members.sort((x, y) => y.notional - x.notional).slice(0, top).map(a => ({ account: a.account, notional: a.notional, net: a.net, upnl: a.upnl, pnl: a.pnl ?? null }))
    };
  });
  return {
    accounts: list.length,
    by_size: group(SIZE_COHORTS, a => a.notional),
    by_pnl: group(PNL_COHORTS, a => a.pnl),
    unranked: list.filter(a => a.pnl === undefined || a.pnl === null).length
  };
}
