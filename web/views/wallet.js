// Wallet-level views: full account profile (positions, history, performance, observations) and side-by-side comparison.
import { h, fmt, num, API, colors, chartWidth, columnChart, lineChart, legend, tableView, card, cardWithActions, tile, table, expandableTable, dateTime, watchButton, accountLink, txLink, pnlClass, signedUsd } from '../ui.js';

const hold = seconds => { const n = num(seconds); if (n === null) return '—'; if (n < 90) return `${Math.round(n)} s`; if (n < 5400) return `${Math.round(n / 60)} min`; if (n < 172800) return `${(n / 3600).toFixed(1)} h`; return `${(n / 86400).toFixed(1)} d`; };
const sideSpan = side => h('span', { class: `side-${side}` }, side);
const TYPE_LABEL = { open: 'Open', increase: 'Increase', decrease: 'Reduce', close: 'Close', invert: 'Flip', liquidation: 'Liquidated', deleverage: 'Deleveraged' };

export function accountView(a) {
  const c = colors();
  const p = a.performance, s = a.summary, t = a.totals, cov = a.coverage;
  const closest = a.closest_liquidation;
  const curve = p.equity_curve;
  const equityChart = curve.length > 1 ? lineChart({ width: chartWidth(2), signed: true, series: [{ name: 'Cumulative realized PnL', color: c.blue, points: curve.map(x => ({ y: num(x.equity), x })) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v), labelOf: pt => dateTime(pt.x.ts), rowsOf: i => [{ color: c.blue, name: 'Cumulative realized', value: fmt.usdFull(curve[i].equity) }, { name: 'Block', value: fmt.int(curve[i].block) }] }) : h('div', { class: 'empty' }, 'Needs at least two closed round trips');
  const byMarket = p.markets;
  const marketChart = byMarket.length ? columnChart({ width: chartWidth(2), categories: byMarket.map(x => x.symbol ?? `#${x.market_id}`), series: [{ name: 'Realized PnL', color: c.blue, values: byMarket.map(x => Math.abs(num(x.realized_pnl))) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v), tooltipRows: i => [{ name: 'Realized PnL', value: signedUsd(byMarket[i].realized_pnl) }, { name: 'Round trips', value: `${byMarket[i].trips} (${byMarket[i].wins} wins)` }, { name: 'Fees', value: fmt.usdFull(byMarket[i].fees) }] }) : null;
  const coverageText = cov.from_ts ? `History covers chain events since ${dateTime(cov.from_ts)} (${cov.records} records)${cov.backfill?.running ? ' · backfill still running' : ''}. Balances and positions are live from the contract.` : 'History index is still warming up. Balances and positions are live from the contract.';
  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Account #${a.account.id}`), h('p', { class: 'sub' }, h('a', { href: `https://monadscan.com/address/${a.account.address}`, target: '_blank', rel: 'noopener', class: 'mono' }, a.account.address), ` · read at block ${fmt.int(a.account_read_block)}${a.account.frozen ? ' · frozen' : ''}`)),
      h('div', { class: 'actions' }, watchButton(a.account.id, `#${a.account.id}`), h('a', { class: 'ghost-link', href: `#/compare?add=${a.account.id}` }, 'Compare'), h('a', { class: 'ghost-link', href: `${API}/accounts/${a.account.id}/trades?format=csv`, download: '' }, 'Trades CSV'))),
    h('p', { class: 'coverage' }, coverageText),
    h('div', { class: 'tiles' },
      tile('Account value', fmt.usd(t.account_value), `${fmt.usd(a.account.balance)} free · ${fmt.usd(a.account.locked_balance)} in orders · ${fmt.usd(t.equity)} in positions`),
      tile('Open positions', String(t.positions), `${fmt.usd(t.notional)} notional · ${t.effective_leverage === null ? '—' : fmt.lev(t.effective_leverage)} of account value · margin used ${t.margin_usage_pct === null ? '—' : fmt.pct(t.margin_usage_pct, 0)}`),
      tile('Unrealized PnL', signedUsd(t.pnl), closest ? `closest liquidation ${closest.symbol} ${closest.side} at ${fmt.price(closest.liquidation_price)} (${fmt.pct(closest.distance_pct, 1)} away)` : 'no open positions', num(t.pnl) < 0 ? 'critical' : num(t.pnl) > 0 ? 'good' : null),
      tile('Realized PnL', signedUsd(s.realized_pnl), `${signedUsd(s.net_pnl)} after ${fmt.usd(s.fees)} fees · funding ${signedUsd(s.funding)}`, pnlClass(s.realized_pnl) === 'status-bad' ? 'critical' : pnlClass(s.realized_pnl) === 'status-ok' ? 'good' : null),
      tile('Win rate', p.win_rate_pct === null ? '—' : fmt.pct(p.win_rate_pct, 0), `${p.wins} wins · ${p.losses} losses of ${p.closed_trips} round trips`),
      tile('Profit factor', p.profit_factor === null ? (p.wins && !p.losses ? '∞' : '—') : p.profit_factor.toFixed(2), `${fmt.usd(p.gross_profit)} gross profit vs ${fmt.usd(p.gross_loss)} gross loss`, p.profit_factor === null ? null : p.profit_factor >= 1 ? 'good' : 'critical'),
      tile('Max drawdown', fmt.usd(p.max_drawdown), 'peak-to-trough of cumulative realized PnL', num(p.max_drawdown) > 0 ? 'critical' : null),
      tile('Streaks', `${p.best_streak}W / ${p.worst_streak}L`, `current ${p.current_streak > 0 ? `${p.current_streak} wins` : p.current_streak < 0 ? `${-p.current_streak} losses` : '—'}`),
      tile('Average hold', hold(p.average_hold_seconds), `median ${hold(p.median_hold_seconds)} · ${p.long_share_pct === null ? '—' : fmt.pct(p.long_share_pct, 0)} of trips long`),
      tile('Volume traded', fmt.usd(s.volume), `${fmt.int(s.trades)} trades · ${signedUsd(s.net_flow)} net deposits`),
      tile('Best / worst market', p.best_market ? `${p.best_market.symbol ?? '#' + p.best_market.market_id}${p.worst_market ? ` / ${p.worst_market.symbol ?? '#' + p.worst_market.market_id}` : ''}` : '—', p.best_market ? `${signedUsd(p.best_market.realized_pnl)}${p.worst_market ? ` / ${signedUsd(p.worst_market.realized_pnl)}` : ''}` : 'no closed round trips'),
      tile('Largest win / loss', `${fmt.usd(p.largest_win)} / ${fmt.usd(p.largest_loss)}`, `${p.liquidated_trips} liquidated${p.deleveraged_trips ? ` · ${p.deleveraged_trips} deleveraged` : ''}`, p.liquidated_trips ? 'critical' : null)),
    a.observations.length ? card('Observations', 'Rule-based reading of the numbers above; no model involved.', h('ul', { class: 'observations' }, a.observations.map(o => h('li', {}, o)))) : null,
    card('Open positions', 'Liquidation prices use the current maintenance fraction and the contract\'s premium PnL.', a.positions.length ? table(['Market', 'Side', 'Size', 'Notional', 'Entry', 'Mark', 'Liq. price', 'Distance', 'Leverage', 'Health', 'Unrealized PnL'], a.positions.map(q => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/market/${q.market_id}`; } }, h('td', { class: 'left' }, h('strong', {}, q.symbol)), h('td', { class: 'left' }, sideSpan(q.side)), h('td', {}, fmt.size(q.size)), h('td', {}, fmt.usd(q.notional)), h('td', {}, fmt.price(q.entry_price)), h('td', {}, fmt.price(q.mark)), h('td', {}, num(q.liquidation_price) > 0 ? fmt.price(q.liquidation_price) : '—'), h('td', { class: q.status !== 'healthy' ? 'status-bad' : num(q.liquidation_distance_pct) < 5 ? 'status-warn' : null }, q.status !== 'healthy' ? q.status : fmt.pct(q.liquidation_distance_pct, 1)), h('td', {}, fmt.lev(q.leverage)), h('td', {}, fmt.pct(q.health_pct, 0)), h('td', { class: pnlClass(q.pnl) }, signedUsd(q.pnl)))), 2) : h('div', { class: 'empty' }, 'No open positions')),
    h('div', { class: 'grid' },
      card('Cumulative realized PnL', 'Equity curve over closed round trips, oldest first.', equityChart),
      card('Performance by market', null, marketChart ? [legend([{ name: 'Realized PnL (bars show magnitude)', color: c.blue }]), marketChart, tableView('Show data table', ['Market', 'Round trips', 'Wins', 'Realized PnL', 'Fees', 'Entry volume'], byMarket.map(x => [x.symbol ?? `#${x.market_id}`, String(x.trips), String(x.wins), signedUsd(x.realized_pnl), fmt.usdFull(x.fees), fmt.usdFull(x.volume)]))] : h('div', { class: 'empty' }, 'No closed round trips in the indexed window'))),
    card('Round trips', 'One row per position lifetime on a market and side; incomplete rows started before the indexed window.', a.trips.length || a.open_trips.length ? expandableTable(['Market', 'Side', 'Opened', 'Closed', 'Hold', 'Entry notional', 'Max size', 'Realized PnL', 'Return', 'Fees', 'Ended by'],
      [...a.open_trips.map(x => tripRow(x, true)), ...a.trips.map(x => tripRow(x, false))], 2, 15) : h('div', { class: 'empty' }, 'No position changes indexed for this account')),
    cardWithActions('Trade history', `${a.history.length} most recent position changes, newest first. Prices come from the fill that settled each change.`, [h('a', { href: `${API}/accounts/${a.account.id}/trades?format=csv`, download: '' }, 'Download CSV')],
      a.history.length ? expandableTable(['Time', 'Type', 'Role', 'Market', 'Side', 'Price', 'Size', 'Notional', 'Realized PnL', 'Fee', 'Leverage', 'Tx'], a.history.map(e => h('tr', {}, h('td', { class: 'left' }, dateTime(e.timestamp)), h('td', { class: 'left' }, h('span', { class: `pill ${e.type === 'liquidation' ? 'bad' : ''}` }, TYPE_LABEL[e.type] ?? e.type)), h('td', { class: 'left' }, e.role ?? '—'), h('td', { class: 'left' }, h('strong', {}, e.symbol ?? `#${e.market_id}`)), h('td', { class: 'left' }, sideSpan(e.side)), h('td', {}, fmt.price(e.price)), h('td', {}, fmt.size(e.size)), h('td', {}, fmt.usd(e.notional)), h('td', { class: pnlClass(e.realized_pnl) }, num(e.realized_pnl) === 0 ? '—' : signedUsd(e.realized_pnl)), h('td', {}, num(e.fee) ? fmt.usdFull(e.fee) : '—'), h('td', {}, e.leverage === null ? '—' : fmt.lev(e.leverage)), h('td', {}, txLink(e.tx)))), 5, 30) : h('div', { class: 'empty' }, 'No trades indexed for this account')),
    card('Deposits and withdrawals', null, a.flows.length ? expandableTable(['Time', 'Type', 'Amount', 'Balance after', 'Tx'], a.flows.map(f => h('tr', {}, h('td', { class: 'left' }, dateTime(f.timestamp)), h('td', { class: 'left' }, f.type), h('td', { class: f.type === 'deposit' ? 'status-ok' : 'status-bad' }, `${f.type === 'deposit' ? '+' : '−'}${fmt.usdFull(f.amount)}`), h('td', {}, fmt.usdFull(f.balance_after)), h('td', {}, txLink(f.tx)))), 2, 10) : h('div', { class: 'empty' }, 'No collateral flows indexed for this account')));
}
function tripRow(x, open) {
  return h('tr', {}, h('td', { class: 'left' }, h('strong', {}, x.symbol ?? `#${x.market_id}`)), h('td', { class: 'left' }, sideSpan(x.side)), h('td', {}, x.complete ? dateTime(x.open_ts) : `before ${dateTime(x.open_ts)}`), h('td', {}, open ? h('span', { class: 'pill accent' }, 'open') : dateTime(x.close_ts)), h('td', {}, hold(x.hold_seconds)), h('td', {}, fmt.usd(x.entry_notional)), h('td', {}, fmt.size(x.max_size)), h('td', { class: pnlClass(x.realized_pnl) }, signedUsd(x.realized_pnl)), h('td', { class: pnlClass(x.realized_pnl) }, x.return_on_notional_pct === null ? '—' : fmt.signedPct(x.return_on_notional_pct, 2)), h('td', {}, fmt.usdFull(x.fees)), h('td', { class: 'left' }, open ? '—' : x.liquidated ? h('span', { class: 'status-bad' }, 'liquidation') : x.deleveraged ? 'deleveraging' : 'trader'));
}

// Side-by-side comparison of watched wallets (plus any added through the URL).
export function compareView(entries, { onRemove, onAdd }) {
  const input = h('input', { type: 'text', placeholder: 'Account ID or 0x address', 'aria-label': 'Add a wallet to compare' });
  const form = h('form', { class: 'search inline', onsubmit: evt => { evt.preventDefault(); const key = input.value.trim(); if (key) { onAdd(key); input.value = ''; } } }, input, h('button', { type: 'submit', class: 'ghost' }, 'Add'));
  if (!entries.length) return h('div', {}, h('h1', {}, 'Compare wallets'), h('p', { class: 'sub' }, 'Watch wallets from any account page or leaderboard row and they line up here side by side. The watchlist lives only in this browser.'), form);
  const ok = entries.filter(e => e.data);
  const metric = (label, get, cls = () => null) => h('tr', {}, h('th', { class: 'left', scope: 'row' }, label), ...entries.map(e => e.data ? h('td', { class: cls(e.data) }, get(e.data)) : h('td', { class: 'muted' }, e.error ?? '—')));
  const best = get => { const values = ok.map(e => num(get(e.data))).filter(v => v !== null); return values.length ? Math.max(...values) : null; };
  const hi = (get, invert = false) => d => { const v = num(get(d)); const b = best(x => invert ? -num(get(x)) : get(x)); return v !== null && b !== null && (invert ? -v : v) === b && ok.length > 1 ? 'best' : null; };
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Compare wallets'), h('p', { class: 'sub' }, `${entries.length} wallets · live balances and positions from the contract, history from the indexed window`)), form),
    card(null, null, h('div', { class: 'table-wrap' }, h('table', { class: 'compare' },
      h('thead', {}, h('tr', {}, h('th', { class: 'left' }, 'Metric'), ...entries.map(e => h('th', {}, e.data ? accountLink(e.data.account.id) : h('span', { class: 'mono' }, e.key), ' ', h('button', { type: 'button', class: 'ghost small', onclick: () => onRemove(e.key), 'aria-label': `Remove ${e.key}` }, '×'))))),
      h('tbody', {},
        metric('Address', d => h('span', { class: 'mono', title: d.account.address }, fmt.short(d.account.address))),
        metric('Account value', d => fmt.usd(d.totals.account_value), hi(d => d.totals.account_value)),
        metric('Free balance', d => fmt.usd(d.account.balance)),
        metric('Open positions', d => `${d.totals.positions} · ${fmt.usd(d.totals.notional)}`),
        metric('Effective leverage', d => d.totals.effective_leverage === null ? '—' : fmt.lev(d.totals.effective_leverage)),
        metric('Unrealized PnL', d => signedUsd(d.totals.pnl), d => pnlClass(d.totals.pnl)),
        metric('Closest liquidation', d => d.closest_liquidation ? `${d.closest_liquidation.symbol} ${fmt.pct(d.closest_liquidation.distance_pct, 1)} away` : '—', d => d.closest_liquidation && d.closest_liquidation.distance_pct < 5 ? 'status-bad' : null),
        metric('Realized PnL (indexed)', d => signedUsd(d.summary.realized_pnl), hi(d => d.summary.realized_pnl)),
        metric('Net PnL after fees', d => signedUsd(d.summary.net_pnl), d => pnlClass(d.summary.net_pnl)),
        metric('Volume traded', d => fmt.usd(d.summary.volume), hi(d => d.summary.volume)),
        metric('Trades', d => fmt.int(d.summary.trades)),
        metric('Fees paid', d => fmt.usd(d.summary.fees)),
        metric('Win rate', d => d.performance.win_rate_pct === null ? '—' : fmt.pct(d.performance.win_rate_pct, 0), hi(d => d.performance.win_rate_pct)),
        metric('Profit factor', d => d.performance.profit_factor === null ? '—' : d.performance.profit_factor.toFixed(2), hi(d => d.performance.profit_factor)),
        metric('Max drawdown', d => fmt.usd(d.performance.max_drawdown), hi(d => d.performance.max_drawdown, true)),
        metric('Best / worst streak', d => `${d.performance.best_streak}W / ${d.performance.worst_streak}L`),
        metric('Average hold', d => hold(d.performance.average_hold_seconds)),
        metric('Long share of trips', d => d.performance.long_share_pct === null ? '—' : fmt.pct(d.performance.long_share_pct, 0)),
        metric('Liquidated round trips', d => String(d.performance.liquidated_trips), d => d.performance.liquidated_trips ? 'status-bad' : null),
        metric('Best market', d => d.performance.best_market ? `${d.performance.best_market.symbol} ${signedUsd(d.performance.best_market.realized_pnl)}` : '—'),
        metric('Net deposits', d => signedUsd(d.summary.net_flow), d => pnlClass(d.summary.net_flow)))))));
}
