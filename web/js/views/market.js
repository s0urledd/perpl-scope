// One market: price candles and volume, positioning, funding history,
// liquidation ladder from live positions, top traders and recent trades.
import { get, stream } from '../api.js';
import { usd, int, price, pct, num, esc, timeOnly, dateTime, duration } from '../format.js';
import { kpi, seg, table, mkt, sideTag, addr, ratio, pnl, pctCell, fundingCell, tradeAction, skeleton, skChart, empty, colorOf, chartTools } from '../ui.js';
import { candles, signedBars, mirrored } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];

export function mount(el, { params, query, setQuery }) {
  const id = Number(params[0]);
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let alive = true, row = null, risk = null;
  el.innerHTML = `
    <div class="page-head">
      <div><div class="sub"><a href="#/markets">Markets</a> /</div><h1 id="title">Market #${id}</h1><div class="sub" id="subtitle"></div></div>
      <div id="win">${seg('window', WINDOWS, w)}</div>
    </div>
    <div class="stack">
      <div class="kpis" id="kpis"></div>
      <div class="grid g-main">
        <section class="panel"><div class="panel-head"><h2>Price and volume</h2><span class="head-right"><span class="meta" id="c-meta"></span>${chartTools('candles', `market-${id}-candles`)}</span></div><div class="panel-body"><div class="chart lg" id="candles">${skChart()}</div></div></section>
        <section class="panel"><div class="panel-head"><h2>Positioning</h2><span class="meta">Live positions</span></div><div id="positioning">${skeleton(8)}</div></section>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><h2>Funding rate</h2><span class="head-right"><span class="meta" id="f-meta"></span>${chartTools('funding', `market-${id}-funding`)}</span></div><div class="panel-body"><div class="chart sm" id="funding">${skChart()}</div></div></section>
        <section class="panel"><div class="panel-head"><h2>Liquidation ladder</h2><span class="head-right"><span class="meta">Notional liquidated by an adverse move of the mark</span>${chartTools('ladder', `market-${id}-ladder`, { csv: false })}</span></div><div class="panel-body"><div class="chart sm" id="ladder">${skChart()}</div></div></section>
      </div>
      <div class="grid g-2">
        <section class="panel"><div class="panel-head"><h2>Top traders</h2><span class="meta" id="lb-meta"></span></div><div class="panel-body flush" id="lb">${skeleton(6)}</div></section>
        <section class="panel fill"><div class="panel-head"><h2>Recent trades</h2><span class="meta">Aggressor side</span></div><div class="panel-body flush scroll" id="trades">${skeleton(6)}</div></section>
      </div>
    </div>`;
  const $ = s => el.querySelector(`#${s}`);

  async function load() {
    const [p, s] = await Promise.all([get(`protocol?window=${w}`), get(`protocol/series?window=${w}&market=${id}`)]);
    if (!alive) return;
    row = p.markets.find(m => m.id === id) ?? null;
    if (!row) { el.querySelector('.stack').innerHTML = empty('Market not found'); return; }
    $('title').innerHTML = `<span class="mkt" style="gap:10px"><i class="sw" style="width:12px;height:12px;border-radius:3px;background:${colorOf(id)}"></i>${esc(row.symbol)}<span class="muted" style="font-size:14px;font-weight:400;margin-left:2px">${esc(row.name && row.name !== row.symbol ? row.name : 'Perpetual')}</span></span>`;
    $('subtitle').innerHTML = `Mark <b class="num" style="color:var(--text)">${price(row.mark ?? row.close)}</b> · ${pctCell(row.change_pct)} ${w} · max leverage ${row.max_leverage ?? '—'}x`;
    $('kpis').innerHTML = [
      kpi({ label: `Volume ${w}`, value: usd(row.volume), note: `${pct(row.share_pct, { digits: 1 })} of exchange` }),
      kpi({ label: 'Open interest', value: usd(row.open_interest), note: row.oi_cap_pct !== undefined && row.oi_cap_pct !== null ? `${pct(row.oi_cap_pct, { digits: 1 })} of cap` : '' }),
      kpi({ label: 'Funding 8h', value: row.funding ? fundingCell(row.funding, { apr: false }) : '—', note: !row.funding ? '' : num(row.funding.rate_8h_pct) === 0 ? 'flat · no payments this interval' : `${pct(row.funding.apr_pct, { digits: 1, sign: true })} APR · ${row.funding.rate_8h_pct > 0 ? 'longs pay' : 'shorts pay'}` }),
      kpi({ label: 'Traders', value: int(row.traders), note: `${int(row.trades)} trades` }),
      kpi({ label: 'Taker buy share', value: pct(row.taker_buy_share_pct, { digits: 1 }), note: `${usd(row.taker_buy)} bought · ${usd(row.taker_sell)} sold` }),
      kpi({ label: 'Liquidated', value: usd(row.liquidated), note: `${int(row.liquidations)} events` })
    ].join('');
    const pts = s.points.filter(x => x.close !== null);
    $('c-meta').textContent = `${s.meta.bucket} candles from fills · UTC`;
    const node = $('candles'); node.innerHTML = '';
    if (!pts.length) node.innerHTML = empty('No trades in this window');
    else {
      let prev = null;
      const ohlc = s.points.map(x => { const c = num(x.close), o = num(x.open) ?? prev ?? c, h = num(x.high) ?? Math.max(o, c), l = num(x.low) ?? Math.min(o, c); prev = c; return c === null ? '-' : [o, c, l, h]; });
      candles(node, { times: s.times, ohlc, volume: s.points.map(x => num(x.volume)), bucketSeconds: s.meta.bucket_seconds, priceFmt: v => price(v).replace(/\.0+$/, ''), volColor: colorOf(id) + '99' });
    }
  }
  async function loadRisk() {
    const r = await get(`markets/${id}`, { maxAge: 3000 });
    if (!alive) return;
    risk = r.market;
    const L = risk.long, S = risk.short;
    $('positioning').innerHTML = `
      <div class="panel-body" style="padding-top:4px">${ratio(L.count, S.count)}</div>
      <div class="stat-grid">
        <div class="stat"><span>Long positions</span><span class="pos">${int(L.count)}</span></div><div class="stat"><span>Short positions</span><span class="neg">${int(S.count)}</span></div>
        <div class="stat"><span>Long notional</span><span>${usd(L.notional)}</span></div><div class="stat"><span>Short notional</span><span>${usd(S.notional)}</span></div>
        <div class="stat"><span>Long avg lev.</span><span>${L.average_leverage ? L.average_leverage.toFixed(1) + 'x' : '—'}</span></div><div class="stat"><span>Short avg lev.</span><span>${S.average_leverage ? S.average_leverage.toFixed(1) + 'x' : '—'}</span></div>
        <div class="stat"><span>Long uPnL</span><span>${pnl(num(L.delta_pnl) + num(L.premium_pnl))}</span></div><div class="stat"><span>Short uPnL</span><span>${pnl(num(S.delta_pnl) + num(S.premium_pnl))}</span></div>
        <div class="stat"><span>Near liquidation</span><span>${int(risk.positions.liquidatable)}</span></div><div class="stat"><span>Insurance fund</span><span>${usd(risk.insurance.balance)}</span></div>
        <div class="stat"><span>Largest position</span><span>${usd(risk.concentration?.largest?.notional)}</span></div><div class="stat"><span>Top 5 share</span><span>${pct(risk.concentration?.top5_pct, { digits: 1 })}</span></div>
      </div>`;
    const ladder = risk.ladder ?? [];
    const lnode = $('ladder'); lnode.innerHTML = '';
    if (ladder.length) mirrored(lnode, { labels: ladder.map(x => `${x.shock_pct}%`), long: ladder.map(x => num(x.long.notional)), short: ladder.map(x => num(x.short.notional)) });
    else lnode.innerHTML = empty('No open positions');
  }
  async function loadFunding() {
    const f = await get(`markets/${id}/funding?limit=500`, { maxAge: 30000 });
    if (!alive) return;
    // Last seven days of funding events (one per interval), signed.
    const cutoff = Date.now() / 1000 - 7 * 86400;
    const rows = (f.history ?? []).filter(r => r.ts >= cutoff).slice().reverse();
    const node = $('funding'); node.innerHTML = '';
    $('f-meta').textContent = f.current ? `Now ${num(f.current.rate_per_interval_pct) === 0 ? '0%' : pct(f.current.rate_per_interval_pct, { digits: 4, sign: true })} per ${duration(f.current.interval_seconds)} · next in ${duration(f.current.seconds_to_next)}` : '';
    if (rows.length) signedBars(node, { times: rows.map(r => r.ts), values: rows.map(r => r.rate_pct), bucketSeconds: 3600, dayTicks: true, name: 'Funding rate', fmt: v => pct(v, { digits: 4, sign: true }), yFmt: v => `${Number(v).toFixed(3)}%` });
    else node.innerHTML = empty('No funding events indexed yet');
  }
  async function loadFeeds() {
    const [t, lb] = await Promise.all([get(`trades?market=${id}&limit=60`, { maxAge: 1000 }), get(`leaderboard?window=${w}&market=${id}&limit=10`)]);
    if (!alive) return;
    renderTrades(t.rows);
    $('lb-meta').textContent = `By net PnL · ${w}`;
    $('lb').innerHTML = table({ id: 'lb', compact: true, columns: [
      { key: 'r', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account) },
      { key: 'p', label: 'Net PnL', n: true, render: r => pnl(r.pnl) },
      { key: 'v', label: 'Volume', n: true, render: r => usd(r.volume) }
    ], rows: lb.rows, rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.address || r.account)}"` });
  }
  let tape = [];
  function renderTrades(rows) {
    tape = rows;
    $('trades').innerHTML = table({ id: 't', compact: true, columns: [
      { key: 't', label: 'Time', render: r => `<span class="muted num">${timeOnly(r.ts)}</span>` },
      { key: 's', label: 'Action', render: tradeAction },
      { key: 'p', label: 'Price', n: true, render: r => price(r.price) },
      { key: 'v', label: 'Notional', n: true, render: r => usd(r.notional) },
      { key: 'a', label: 'Trader', render: r => addr(r.address, r.account, { star: false }) }
    ], rows: tape.slice(0, 60), rowAttrs: r => `class="${r.fresh ? 'flash' : ''}"` });
  }
  const off = stream.on('trades', rows => { const mine = rows.filter(r => r.market === id); if (!mine.length) return; tape = [...mine.reverse().map(r => ({ ...r, fresh: true })), ...tape].slice(0, 60); renderTrades(tape); tape.forEach(r => { r.fresh = false; }); });
  const timer = setInterval(() => { loadRisk().catch(() => {}); if (w === '24h') load().catch(() => {}); }, 20000);
  load().catch(error => { $('kpis').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  loadRisk().catch(() => { $('positioning').innerHTML = empty('Live positions unavailable'); $('ladder').innerHTML = empty('Unavailable'); });
  loadFunding().catch(() => { $('funding').innerHTML = empty('Unavailable'); });
  loadFeeds().catch(() => {});
  return {
    onSeg(name, v) { if (name === 'window') setQuery({ window: v === '24h' ? null : v }); },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; $('win').innerHTML = seg('window', WINDOWS, w); load().catch(() => {}); loadFeeds().catch(() => {}); },
    destroy() { alive = false; off(); clearInterval(timer); }
  };
}
export { dateTime, sideTag };
