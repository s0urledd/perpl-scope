// Markets list: price, change, volume, open interest, funding, skew and risk
// for every market over the chosen window.
import { get, stream } from '../api.js';
import { usd, int, price, pct, num, esc } from '../format.js';
import { seg, table, mkt, ratio, pctCell, skeleton, assignColors } from '../ui.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let sort = { key: 'volume', dir: 'desc' }, data = null, alive = true;
  el.innerHTML = `
    <div class="page-head"><div><h1>Markets</h1><div class="sub">Every Perpl market with live prices, open interest and funding.</div></div><div id="win">${seg('window', WINDOWS, w)}</div></div>
    <section class="panel"><div class="panel-body flush" id="list">${skeleton(10)}</div></section>`;
  const COLS = [
    { key: 'symbol', label: 'Market', sort: r => r.symbol, render: r => mkt(r.id, r.symbol, r.name) },
    { key: 'mark', label: 'Mark', n: true, sort: r => num(r.mark ?? r.close), render: r => price(r.mark ?? r.close) },
    { key: 'change_pct', label: 'Change', n: true, sort: r => num(r.change_pct) ?? -1e9, render: r => pctCell(r.change_pct) },
    { key: 'range', label: 'Low – High', n: true, render: r => r.low ? `<span class="muted">${price(r.low)} – ${price(r.high)}</span>` : '—' },
    { key: 'volume', label: 'Volume', n: true, sort: r => num(r.volume), render: r => usd(r.volume) },
    { key: 'trades', label: 'Trades', n: true, sort: r => r.trades ?? 0, render: r => int(r.trades) },
    { key: 'fees', label: 'Fees', n: true, sort: r => num(r.fees) ?? 0, render: r => usd(r.fees) },
    { key: 'open_interest', label: 'Open interest', n: true, sort: r => num(r.open_interest) ?? 0, render: r => `${usd(r.open_interest)}${r.oi_cap_pct !== null && r.oi_cap_pct !== undefined ? `<div class="sub">${pct(r.oi_cap_pct, { digits: 1 })} of cap</div>` : ''}` },
    { key: 'funding', label: 'Funding 8h', n: true, sort: r => r.funding?.rate_8h_pct ?? 0, render: r => r.funding ? `<span class="${r.funding.rate_8h_pct > 0 ? 'pos' : r.funding.rate_8h_pct < 0 ? 'neg' : 'muted'}">${pct(r.funding.rate_8h_pct, { digits: 4, sign: true })}</span>` : '—' },
    { key: 'ls', label: 'Long / short', sort: r => r.long_position_share_pct ?? 0, render: r => ratio(r.long_positions, r.short_positions) },
    { key: 'lev', label: 'Avg lev. L / S', n: true, render: r => r.long_leverage || r.short_leverage ? `${r.long_leverage ? r.long_leverage.toFixed(1) + 'x' : '—'} / ${r.short_leverage ? r.short_leverage.toFixed(1) + 'x' : '—'}` : '—' },
    { key: 'max_leverage', label: 'Max lev.', n: true, sort: r => r.max_leverage ?? 0, render: r => (r.max_leverage ? `${r.max_leverage}x` : '—') },
    { key: 'insurance', label: 'Insurance', n: true, sort: r => num(r.insurance) ?? 0, render: r => usd(r.insurance) }
  ];
  function render() { if (data) el.querySelector('#list').innerHTML = table({ id: 'm', columns: COLS, rows: data.markets, sortKey: sort.key, sortDir: sort.dir, rowAttrs: r => `class="link" data-href="#/markets/${r.id}"` }); }
  async function load() { data = await get(`protocol?window=${w}`); if (!alive) return; assignColors([...data.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => m.id)); render(); }
  const off = stream.on('protocol', () => { if (w === '24h') load().catch(() => {}); });
  load().catch(error => { el.querySelector('#list').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  return {
    onSeg(name, v) { if (name === 'window') setQuery({ window: v === '24h' ? null : v }); },
    onSort(id, key) { sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' }; render(); },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; el.querySelector('#win').innerHTML = seg('window', WINDOWS, w); load().catch(() => {}); },
    destroy() { alive = false; off(); }
  };
}
