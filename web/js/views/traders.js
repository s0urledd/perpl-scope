// Trader leaderboard over a window: net PnL, volume, losses, liquidations,
// with open positions from the live contract state.
import { get } from '../api.js';
import { usd, int, pct, num, esc } from '../format.js';
import { seg, table, addr, pnl, skeleton, mkt, ICON } from '../ui.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const SORTS = [['pnl', 'Top PnL'], ['loss', 'Top losses'], ['volume', 'Volume'], ['liquidated', 'Liquidated'], ['fees', 'Fees paid']];

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '7d';
  let by = SORTS.some(([v]) => v === query.get('by')) ? query.get('by') : 'pnl';
  let page = 0, alive = true, data = null;
  const LIMIT = 50;
  el.innerHTML = `
    <div class="page-head"><div><h1>Traders</h1><div class="sub">Every Perpl account ranked from indexed trades. Net PnL = realized PnL + funding − fees.</div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><div id="by">${seg('by', SORTS, by)}</div><div id="win">${seg('window', WINDOWS, w)}</div></div></div>
    <section class="panel"><div class="panel-head"><h2 id="title">Leaderboard</h2><div style="display:flex;gap:10px;align-items:center"><span class="meta" id="meta"></span><a class="btn ghost" id="csv">${ICON.download} CSV</a></div></div>
      <div class="panel-body flush" id="list">${skeleton(12)}</div>
      <div class="panel-foot"><span id="count"></span><span><button class="btn ghost" data-action="prev">← Prev</button> <button class="btn ghost" data-action="next">Next →</button></span></div></section>`;
  const $ = s => el.querySelector(`#${s}`);
  const COLS = [
    { key: 'rank', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
    { key: 'addr', label: 'Trader', render: r => addr(r.address, r.account) },
    { key: 'pnl', label: 'Net PnL', n: true, render: r => pnl(r.pnl) },
    { key: 'roi', label: 'PnL / volume', n: true, render: r => r.roi_on_volume_bps === null ? '—' : `<span class="${r.roi_on_volume_bps > 0 ? 'pos' : r.roi_on_volume_bps < 0 ? 'neg' : ''}">${(r.roi_on_volume_bps / 100).toFixed(2)}%</span>` },
    { key: 'volume', label: 'Volume', n: true, render: r => usd(r.volume) },
    { key: 'trades', label: 'Trades', n: true, render: r => int(r.trades) },
    { key: 'maker', label: 'Maker share', n: true, render: r => pct(r.maker_share_pct, { digits: 0 }) },
    { key: 'fees', label: 'Fees', n: true, render: r => usd(r.fees) },
    { key: 'liq', label: 'Liquidated', n: true, render: r => (num(r.liquidated) > 0 ? `<span class="neg">${usd(r.liquidated)}</span>` : '<span class="faint">—</span>') },
    { key: 'open', label: 'Open now', n: true, render: r => (r.open_positions ? `${usd(r.open_notional)}<div class="sub">${r.open_positions} pos · uPnL ${usd(r.unrealized_pnl, { sign: true })}</div>` : '<span class="faint">—</span>') },
    { key: 'markets', label: 'Markets', render: r => `<span class="muted">${esc(r.markets.slice(0, 4).join(' · '))}${r.markets.length > 4 ? ` +${r.markets.length - 4}` : ''}</span>` }
  ];
  async function load() {
    $('list').innerHTML = skeleton(12);
    data = await get(`leaderboard?window=${w}&by=${by}&limit=${LIMIT}&offset=${page * LIMIT}`);
    if (!alive) return;
    $('title').textContent = SORTS.find(([v]) => v === by)[1];
    $('meta').textContent = `${w === 'all' ? 'All-time' : w}${data.meta.coverage && !data.meta.coverage.complete ? ' · history still indexing' : ''}`;
    $('list').innerHTML = table({ id: 'lb', columns: COLS, rows: data.rows, rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.address || r.account)}"`, emptyText: 'No traders in this window' });
    $('count').textContent = `${int(data.total)} accounts · showing ${page * LIMIT + 1}–${page * LIMIT + data.rows.length}`;
    $('csv').href = `/api/v1/leaderboard?window=${w}&by=${by}&limit=200&format=csv`;
  }
  load().catch(error => { $('list').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  return {
    onSeg(name, v) { if (name === 'window') setQuery({ window: v === '7d' ? null : v }); if (name === 'by') setQuery({ by: v === 'pnl' ? null : v }); },
    onAction(a) { if (a === 'next' && data && (page + 1) * LIMIT < data.total) { page++; load().catch(() => {}); } if (a === 'prev' && page > 0) { page--; load().catch(() => {}); } },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '7d'; by = SORTS.some(([v]) => v === q.get('by')) ? q.get('by') : 'pnl'; page = 0; $('win').innerHTML = seg('window', WINDOWS, w); $('by').innerHTML = seg('by', SORTS, by); load().catch(() => {}); },
    destroy() { alive = false; }
  };
}
export { mkt };
