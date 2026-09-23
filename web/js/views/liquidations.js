// Liquidations: window totals, liquidated notional over time by side, and the
// full feed (on-book liquidations and auto-deleveraging), live.
import { get, stream } from '../api.js';
import { usd, int, price, esc, dateTime, ago, num, size } from '../format.js';
import { kpi, seg, table, mktLink, sideTag, addr, pnl, skeleton, skChart, empty, ICON, colorOf, hasColor, OTHER_HEX, assignColors, chartTools, mergeByAsset } from '../ui.js';
import { stackedBars } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '7d';
  let market = query.get('market') ?? '';
  let alive = true, markets = [];
  el.innerHTML = `
    <div class="page-head"><div><h1>Liquidations</h1><div class="sub">Forced closes from exchange events: liquidations on the order book and auto-deleveraging.</div></div><div id="win">${seg('window', WINDOWS, w)}</div></div>
    <div class="stack"><div class="kpis k4" id="kpis"></div>
      <section class="panel"><div class="panel-head"><h2>Liquidated notional</h2><div class="head-right"><div class="legend" id="legend"></div>${chartTools('chart', 'liquidations')}</div></div><div class="panel-body"><div class="chart" id="chart">${skChart()}</div></div></section>
      <section class="panel"><div class="panel-head"><h2>Feed</h2><div style="display:flex;gap:10px;align-items:center"><select id="mf" class="btn ghost" aria-label="Market filter"><option value="">All markets</option></select><a class="btn ghost" id="csv">${ICON.download} CSV</a></div></div><div class="panel-body flush" id="feed">${skeleton(10)}</div></section></div>`;
  const $ = s => el.querySelector(`#${s}`);
  async function load() {
    const [p, s, l] = await Promise.all([get(`protocol?window=${w}`), get(`protocol/series?window=${w}`), get(`liquidations?limit=200${market ? `&market=${market}` : ''}`)]);
    if (!alive) return;
    markets = p.markets;
    assignColors([...p.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => ({ id: m.id, symbol: m.symbol })));
    const h = p.headline;
    // Largest inside the selected window (from the latest 200 rows the feed holds).
    const span = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 }[w];
    const inWindow = span ? l.rows.filter(r => Number(r.ts) >= Date.now() / 1000 - span) : l.rows;
    const largest = inWindow.reduce((a, r) => (num(r.notional) > num(a?.notional ?? 0) ? r : a), null);
    $('kpis').innerHTML = [
      kpi({ label: `Liquidated ${w}`, value: usd(h.liquidated.value), delta: p.meta.previous_complete === false ? undefined : h.liquidated.change_pct, invert: true, note: `${int(h.liquidations.value)} liquidations` }),
      kpi({ label: 'Share of volume', value: `${num(h.volume.value) ? (num(h.liquidated.value) / num(h.volume.value) * 100).toFixed(2) : '0.00'}%`, note: `of ${usd(h.volume.value)} traded` }),
      kpi({ label: 'ADL and force closes', value: int(h.deleverages), note: 'positions closed by the protocol', tip: 'PositionDeleveraged events: auto-deleveraging against a bankrupt position, or a force close at the mark price (flagged on the event).' }),
      kpi({ label: `Largest · ${w === 'all' ? 'recent' : w}`, value: largest ? usd(largest.notional) : '—', note: largest ? `${esc(largest.symbol)} ${esc(largest.side ?? '')} · ${ago(largest.ts)}` : '' })
    ].join('');
    const node = $('chart'); node.innerHTML = '';
    const withLiq = mergeByAsset(s.by_market ?? [], ['liquidated']).filter(m => m.liquidated.some(v => num(v) > 0));
    const top = withLiq.filter(m => hasColor(m.id)), rest = withLiq.filter(m => !hasColor(m.id));
    const list = top.map(m => ({ name: m.symbol, color: colorOf(m.id), data: m.liquidated.map(num) }));
    if (rest.length) list.push({ name: 'Other', color: OTHER_HEX, data: s.times.map((_, i) => rest.reduce((a, m) => a + num(m.liquidated[i]), 0)) });
    $('legend').innerHTML = list.map(x => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('') + '<span><i style="background:#fff;height:2px"></i>Cumulative</span>';
    if (list.length) stackedBars(node, { times: s.times, series: list, bucketSeconds: s.meta.bucket_seconds, cumulative: true, zoom: true }); else node.innerHTML = empty('No liquidations in this window');
    $('mf').innerHTML = `<option value="">All markets</option>${markets.filter(m => m.liquidations || m.id === Number(market)).map(m => `<option value="${m.id}" ${String(m.id) === market ? 'selected' : ''}>${esc(m.symbol)}</option>`).join('')}`;
    $('csv').href = `/api/v1/liquidations?limit=500&format=csv${market ? `&market=${market}` : ''}`;
    renderFeed(l.rows);
  }
  function renderFeed(rows) {
    $('feed').innerHTML = table({ id: 'liq', columns: [
      { key: 't', label: 'Time (UTC)', render: r => `<span class="muted num">${dateTime(r.ts)}</span>` },
      { key: 'm', label: 'Market', render: r => mktLink(r.market, r.symbol) },
      { key: 'k', label: 'Type', render: r => (r.kind === 'deleverage' ? (r.force_close ? '<span class="tag warn">Force close</span>' : '<span class="tag warn">ADL</span>') : `<span class="tag">${r.on_book ? 'Order book' : 'Liquidation'}</span>`) },
      { key: 's', label: 'Position', render: r => sideTag(r.side) },
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account) },
      { key: 'sz', label: 'Size', n: true, render: r => size(r.size) },
      { key: 'p', label: 'Price', n: true, render: r => price(r.price) },
      { key: 'mk', label: 'Mark', n: true, render: r => price(r.mark) },
      { key: 'n', label: 'Notional', n: true, render: r => usd(r.notional) },
      { key: 'pnl', label: 'Realized', n: true, render: r => pnl(r.pnl) },
      { key: 'rem', label: 'Remaining', n: true, render: r => (num(r.remaining) ? size(r.remaining) : '<span class="faint">closed</span>') }
    ], rows, rowAttrs: r => `class="link ${r.fresh ? 'flash' : ''}" data-href="#/wallet/${esc(r.address || r.account)}"`, emptyText: 'No liquidations indexed in this range' });
  }
  $('mf').addEventListener('change', e => setQuery({ market: e.target.value || null }));
  const off = stream.on('liquidations', () => get(`liquidations?limit=200${market ? `&market=${market}` : ''}`, { maxAge: 0 }).then(l => alive && renderFeed(l.rows.map((r, i) => ({ ...r, fresh: i === 0 })))).catch(() => {}));
  load().catch(error => { $('feed').innerHTML = empty(error.message); });
  return {
    onSeg(name, v) { if (name === 'window') setQuery({ window: v === '7d' ? null : v }); },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '7d'; market = q.get('market') ?? ''; $('win').innerHTML = seg('window', WINDOWS, w); load().catch(() => {}); },
    destroy() { alive = false; off(); }
  };
}
