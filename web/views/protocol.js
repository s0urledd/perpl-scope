// Protocol-level views: overview with timeframe switching, traders leaderboard and liquidations.
import { h, fmt, num, view, API, colors, chartWidth, columnChart, lineChart, legend, tableView, card, cardWithActions, tile, statusPill, table, segmented, skewBar, shareCell, timeLabel, dateTime, since, binPoints, binFor, WINDOWS, windowLabel, watchButton, accountLink, txLink, pnlClass, signedUsd, coverageNote, sparkline } from '../ui.js';
import { liquidationTable } from './risk.js';

const usdAxis = (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v);
const countAxis = (v, axis) => axis ? fmt.int(v) : fmt.int(v);

// Bars over binned buckets with a shared tooltip layout.
function seriesBars(points, window, series, formatValue, extraRows = () => []) {
  return columnChart({ width: chartWidth(2), categories: points.map(p => timeLabel(p.ts, window)), series: series.map(sr => ({ ...sr, values: points.map(p => Math.abs(num(p[sr.key]) ?? 0)) })), formatValue, tooltipRows: i => [...series.map(sr => ({ color: sr.color, name: sr.name, value: formatValue(num(points[i][sr.key]) ?? 0) })), ...extraRows(points[i]), ...(points[i].complete === false ? [{ name: 'Coverage', value: 'partial hour' }] : [])] });
}
function levelLines(points, window, series, formatValue) {
  const usable = points.filter(p => series.every(sr => num(p[sr.key]) !== null));
  if (usable.length < 2) return h('div', { class: 'empty' }, 'Level snapshots appear as the index samples them');
  return lineChart({ width: chartWidth(2), series: series.map(sr => ({ name: sr.name, color: sr.color, points: usable.map(p => ({ y: num(p[sr.key]), p })) })), formatValue, labelOf: p => timeLabel(p.p.ts, window), rowsOf: i => [...series.map(sr => ({ color: sr.color, name: sr.name, value: formatValue(num(usable[i][sr.key])) })), { name: 'Block', value: fmt.int(usable[i].block) }] });
}

export function overviewView({ stats: d, series: s, overview: o, window, onWindow }) {
  const c = colors();
  const binSeconds = binFor(window, s?.bucket_seconds ?? 3600);
  const points = s ? binPoints(s.points, binSeconds) : [];
  const a = d.activity, f = d.fees, fl = d.flows, l = d.liquidations, cur = d.current, ch = d.change, v = d.venue;
  const risk = o?.totals ?? null, liq = risk?.liquidity ?? null;
  const w = cur.withdrawal_limit;
  const oiChange = ch && ch.open_interest_pct !== null ? `${fmt.signedPct(ch.open_interest_pct, 1)} vs ${windowLabel(window)} ago` : null;
  const fundingOf = new Map((o?.markets ?? []).map(m => [m.id, m]));
  const volumeChart = seriesBars(points, window, [{ key: 'volume', name: 'Volume', color: c.blue }], usdAxis, p => [{ name: 'Trades', value: fmt.int(p.trades) }, { name: 'Fees', value: fmt.usdFull(p.fees) }]);
  const levels = levelLines(points, window, [{ key: 'open_interest', name: 'Open interest', color: c.blue }, { key: 'tvl', name: 'TVL', color: c.accent }], usdAxis);
  const flowChart = seriesBars(points, window, [{ key: 'deposits', name: 'Deposits', color: c.long }, { key: 'withdrawals', name: 'Withdrawals', color: c.short }], usdAxis, p => [{ name: 'Net', value: signedUsd(p.net_flow) }]);
  const traderChart = seriesBars(points, window, [{ key: 'active_traders', name: binSeconds > 3600 ? 'Active traders (peak hour)' : 'Active traders', color: c.blue }, { key: 'new_accounts', name: 'New accounts', color: c.accent }], countAxis);
  const liqChart = seriesBars(points, window, [{ key: 'liquidated_notional', name: 'Liquidated notional', color: c.short }], usdAxis, p => [{ name: 'Liquidations', value: fmt.int(p.liquidations) }]);
  const takerChart = seriesBars(points, window, [{ key: 'taker_buy', name: 'Taker buys', color: c.long }, { key: 'taker_sell', name: 'Taker sells', color: c.short }], usdAxis, p => { const b = num(p.taker_buy) ?? 0, sl = num(p.taker_sell) ?? 0; return [{ name: 'Buy share', value: b + sl > 0 ? fmt.pct(b / (b + sl) * 100, 1) : '—' }]; });
  const tableRows = points.slice().reverse().slice(0, 48).map(p => [timeLabel(p.ts, window), fmt.usdFull(p.volume), fmt.int(p.trades), fmt.usdFull(p.fees), fmt.int(p.active_traders), fmt.usdFull(p.deposits), fmt.usdFull(p.withdrawals), fmt.int(p.liquidations), fmt.usdFull(p.liquidated_notional), p.open_interest === null ? '—' : fmt.usdFull(p.open_interest), p.tvl === null ? '—' : fmt.usdFull(p.tvl)]);
  const dataTable = tableView('Show data table', ['Time', 'Volume', 'Trades', 'Fees', 'Traders', 'Deposits', 'Withdrawals', 'Liquidations', 'Liquidated', 'Open interest', 'TVL'], tableRows);
  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Perpl on Monad'), h('p', { class: 'sub' }, `${fmt.int(cur.accounts)} accounts · ${cur.markets} markets · ${fmt.int(cur.positions)} open positions · contract ${o?.exchange?.version ?? '—'} · every figure from chain state and events`)),
      segmented(WINDOWS, window, onWindow)),
    coverageNote(d.coverage, window),
    h('div', { class: 'tiles' },
      tile(`Volume · ${windowLabel(window)}`, fmt.usd(a.volume), v && window === '24h' && v.delta_pct !== null ? `${fmt.int(a.trades)} trades · Perpl reports ${fmt.usd(v.volume_24h)} (${fmt.signedPct(v.delta_pct, 3)})` : `${fmt.int(a.trades)} trades · ${fmt.int(a.position_changes)} position changes`),
      tile('Open interest', fmt.usd(cur.open_interest), oiChange ?? `${fmt.int(cur.long_positions)} long · ${fmt.int(cur.short_positions)} short positions`, ch && ch.open_interest_pct !== null ? (ch.open_interest_pct >= 0 ? 'good' : 'critical') : null, sparkline(points.map(p => p.open_interest).filter(x => x !== null))),
      tile('TVL', fmt.usd(cur.tvl), ch && ch.tvl_pct !== null ? `${fmt.signedPct(ch.tvl_pct, 2)} vs ${windowLabel(window)} ago · exchange collateral balance` : 'exchange collateral balance', null, sparkline(points.map(p => p.tvl).filter(x => x !== null))),
      tile(`Fees · ${windowLabel(window)}`, fmt.usd(f.total), `${fmt.usd(f.insurance)} to insurance · ${fmt.usd(f.protocol)} to protocol · ${f.take_rate_bps === null ? '—' : `${f.take_rate_bps} bps`} of volume`),
      tile(`Active traders · ${windowLabel(window)}`, fmt.int(a.active_traders), `${fmt.int(a.new_accounts)} new accounts · ${fmt.int(cur.accounts)} total`),
      tile(`Net flows · ${windowLabel(window)}`, signedUsd(fl.net), `${fmt.usd(fl.deposits)} in (${fl.deposit_count}) · ${fmt.usd(fl.withdrawals)} out (${fl.withdrawal_count})`, pnlClass(fl.net) === 'status-bad' ? 'critical' : pnlClass(fl.net) === 'status-ok' ? 'good' : null),
      tile(`Liquidations · ${windowLabel(window)}`, fmt.int(l.count), `${fmt.usd(l.notional)} notional · ${fmt.pct(l.share_of_volume_pct, 2)} of volume${l.deleverages ? ` · ${l.deleverages} deleverages` : ''}`, l.count ? null : 'good'),
      tile(`Traders' realized PnL · ${windowLabel(window)}`, signedUsd(a.realized_pnl), `before fees · taker buy share ${a.taker_buy_share_pct === null ? '—' : fmt.pct(a.taker_buy_share_pct, 1)}`, pnlClass(a.realized_pnl) === 'status-bad' ? 'critical' : pnlClass(a.realized_pnl) === 'status-ok' ? 'good' : null)),
    h('div', { class: 'grid' },
      card('Volume', 'Maker-fill notional per period, each match counted once.', legend([{ name: 'Volume', color: c.blue }]), points.length ? volumeChart : h('div', { class: 'empty' }, 'No data in this window')),
      card('Open interest and TVL', 'Sampled from the contract at every hour boundary and at bootstrap.', legend([{ name: 'Open interest', color: c.blue }, { name: 'TVL', color: c.accent }]), levels)),
    h('div', { class: 'grid' },
      card('Deposits and withdrawals', 'CollateralDeposit and CollateralWithdrawal events.', legend([{ name: 'Deposits', color: c.long }, { name: 'Withdrawals', color: c.short }]), points.length ? flowChart : h('div', { class: 'empty' }, 'No data')),
      card('Active traders', 'Accounts that traded in the period; new accounts from AccountCreated.', legend([{ name: 'Active traders', color: c.blue }, { name: 'New accounts', color: c.accent }]), points.length ? traderChart : h('div', { class: 'empty' }, 'No data'))),
    h('div', { class: 'grid' },
      card('Liquidations', 'Notional liquidated per period, from PositionLiquidated events.', legend([{ name: 'Liquidated notional', color: c.short }]), points.length ? liqChart : h('div', { class: 'empty' }, 'No data')),
      card('Taker flow', 'Aggressor direction: buying builds longs or unwinds shorts. Perpl\'s long and short open interest are always equal, so this is where skew shows.', legend([{ name: 'Taker buys', color: c.long }, { name: 'Taker sells', color: c.short }]), points.length ? takerChart : h('div', { class: 'empty' }, 'No data'))),
    h('div', { class: 'grid wide' }, card('Periods', null, dataTable)),
    card(`Markets · ${windowLabel(window)}`, 'Click a market for its liquidation ladder, order-book cover, stress test and positions.',
      table(['Market', 'Mark', 'Volume', 'Share', 'Open interest', 'Positions L / S', 'Taker buy share', 'Funding 8h', 'Liquidations', 'Fees', 'Realized PnL'],
        d.markets.map(m => { const fo = fundingOf.get(m.id); return h('tr', { class: 'clickable', onclick: () => { location.hash = `#/market/${m.id}`; } },
          h('td', { class: 'left' }, h('strong', {}, m.symbol), ' ', h('span', { class: 'mono muted' }, `#${m.id}`), m.active ? null : h('span', { class: 'pill' }, 'inactive')),
          h('td', {}, fmt.price(m.mark, m.price_decimals)),
          shareCell(fmt.usd(m.volume), m.volume_share_pct),
          h('td', {}, fmt.pct(m.volume_share_pct, 1)),
          h('td', {}, fmt.usd(m.open_interest)),
          h('td', {}, skewBar(m.skew.long_position_share_pct, `${m.skew.long_positions} long / ${m.skew.short_positions} short positions`), ' ', h('span', { class: 'muted' }, `${m.skew.long_positions}/${m.skew.short_positions}`)),
          h('td', {}, m.skew.taker_buy_share_pct === null ? '—' : fmt.pct(m.skew.taker_buy_share_pct, 0)),
          h('td', {}, fo ? fmt.signedPct(fo.funding.rate_8h_pct, 4) : '—'),
          h('td', {}, `${fmt.int(m.liquidations)} `, h('span', { class: 'muted' }, `(${fmt.usd(m.liquidated_notional)})`)),
          h('td', {}, fmt.usd(m.fees)),
          h('td', { class: pnlClass(m.realized_pnl) }, signedUsd(m.realized_pnl))); }))),
    risk ? h('div', { class: 'risk-strip' }, h('h2', {}, 'Risk now'), h('div', { class: 'tiles' },
      tile('Within 10% of liquidation', fmt.usd(risk.notional_at_10pct), `${fmt.pct(num(risk.notional_at_10pct) / num(risk.total_notional) * 100, 1)} of open interest`),
      tile('Bad debt at a 10% move', fmt.usd(risk.shortfall_at_10pct), risk.insurance_coverage_at_10pct === null ? 'none beyond bankruptcy' : `insurance covers ${fmt.cover(risk.insurance_coverage_at_10pct)}`, risk.insurance_coverage_at_10pct === null || risk.insurance_coverage_at_10pct >= 100 ? 'good' : 'critical'),
      tile('On-chain liquidity cover at 10%', liq && liq.cover_at_10pct_pct !== null ? fmt.cover(liq.cover_at_10pct_pct) : '—', liq ? `${fmt.usd(liq.depth_at_10pct)} resting depth vs ${fmt.usd(liq.demand_at_10pct)} liquidation demand` : 'book not read yet', liq && liq.cover_at_10pct_pct !== null && liq.cover_at_10pct_pct < 100 ? 'critical' : null),
      tile('Withdrawal limit', w ? fmt.usd(w.allowance) : '—', w ? `${fmt.pct(w.share_of_tvl_pct, 1)} of TVL withdrawable now · refills ${fmt.usd(w.refill_per_hour)} per hour` : 'getWithdrawAllowanceData not available'),
      tile('Insurance funds', fmt.usd(cur.insurance), `${fmt.pct(num(cur.insurance) / num(cur.open_interest) * 100, 2)} of open interest`),
      tile('Liquidatable now', fmt.int(cur.liquidatable), risk.bankrupt > 0 ? `${risk.bankrupt} bankrupt` : 'positions at or below maintenance', cur.liquidatable > 0 ? 'critical' : 'good'),
      tile('Reconciliation', risk.all_reconciled ? 'Exact' : 'Mismatch', 'positions vs contract OI counters', risk.all_reconciled ? 'good' : 'critical'))) : null);
}

const BY = [{ value: 'pnl', label: 'Realized PnL' }, { value: 'loss', label: 'Largest losses' }, { value: 'volume', label: 'Volume' }, { value: 'trades', label: 'Trades' }, { value: 'fees', label: 'Fees paid' }, { value: 'liquidated', label: 'Liquidated' }, { value: 'deposits', label: 'Deposits' }, { value: 'withdrawals', label: 'Withdrawals' }];
export function tradersView({ board, window, by, onWindow, onBy }) {
  const rows = board.rows;
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Traders'), h('p', { class: 'sub' }, `${fmt.int(board.accounts)} accounts active in the window · ranked from chain events · click an account for its full profile`)), segmented(WINDOWS, window, onWindow)),
    coverageNote(board.coverage, window),
    h('div', { class: 'controls' }, h('span', {}, 'Rank by'), segmented(BY, by, onBy, 'Rank by')),
    card(null, null, rows.length ? table(['#', 'Account', 'Realized PnL', 'Volume', 'Trades', 'Fees', 'Liquidations', 'Net flow', 'Open now', 'Markets', 'Last active', ''],
      rows.map(r => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/account/${r.account_id}`; } },
        h('td', { class: 'left' }, String(r.rank)), h('td', { class: 'left' }, accountLink(r.account_id)),
        h('td', { class: pnlClass(r.realized_pnl) }, signedUsd(r.realized_pnl)), h('td', {}, fmt.usd(r.volume)), h('td', {}, fmt.int(r.trades)), h('td', {}, fmt.usd(r.fees)),
        h('td', { class: r.liquidations ? 'status-bad' : null }, r.liquidations ? `${r.liquidations} (${fmt.usd(r.liquidated_notional)})` : '—'),
        h('td', { class: pnlClass(r.net_flow) }, signedUsd(r.net_flow)),
        h('td', {}, r.open_positions ? `${r.open_positions} · ${fmt.usd(r.open_notional)}` : '—'),
        h('td', { class: 'left' }, r.markets.join(', ')), h('td', {}, since(r.last_ts)), h('td', {}, watchButton(r.account_id, `#${r.account_id}`)))), 2) : h('div', { class: 'empty' }, 'No trading activity indexed in this window yet')));
}

export function liquidationsView(d, stats, series, window, onWindow) {
  const c = colors();
  const points = series ? binPoints(series.points, binFor(window, series.bucket_seconds)) : [];
  const chart = points.length ? seriesBars(points, window, [{ key: 'liquidated_notional', name: 'Liquidated notional', color: c.short }], usdAxis, p => [{ name: 'Liquidations', value: fmt.int(p.liquidations) }]) : null;
  const markets = (stats?.markets ?? []).filter(m => m.liquidations > 0).sort((a, b) => num(b.liquidated_notional) - num(a.liquidated_notional));
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Liquidations'), h('p', { class: 'sub' }, `${fmt.int(stats?.liquidations.count ?? 0)} liquidations · ${fmt.usd(stats?.liquidations.notional)} notional in the window · feed below newest first`)), segmented(WINDOWS, window, onWindow)),
    stats ? coverageNote(stats.coverage, window) : null,
    h('div', { class: 'grid' },
      card('Liquidated notional', 'Exit-price notional of PositionLiquidated events per period.', legend([{ name: 'Liquidated notional', color: c.short }]), chart ?? h('div', { class: 'empty' }, 'No data')),
      card('By market', null, markets.length ? table(['Market', 'Liquidations', 'Notional', 'Share of market volume', 'Open interest'], markets.map(m => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/market/${m.id}`; } }, h('td', { class: 'left' }, h('strong', {}, m.symbol)), h('td', {}, fmt.int(m.liquidations)), h('td', {}, fmt.usd(m.liquidated_notional)), h('td', {}, num(m.volume) > 0 ? fmt.pct(num(m.liquidated_notional) / num(m.volume) * 100, 2) : '—'), h('td', {}, fmt.usd(m.open_interest))))) : h('div', { class: 'empty' }, 'No liquidations in this window'))),
    d.liquidations.length ? cardWithActions('Recent liquidations', `${d.total} PositionLiquidated events kept in memory; deleveraging events: ${d.deleverages.length}.`, [h('a', { href: `${API}/liquidations?format=csv&limit=1000`, download: '' }, 'Download CSV')], liquidationTable(d.liquidations)) : card('Recent liquidations', null, h('div', { class: 'empty' }, 'No liquidations collected yet.')));
}
