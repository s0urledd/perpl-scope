// Protocol overview: headline metrics for the chosen window, volume by market
// next to the live tape, the markets table, a grid of trend charts and the
// latest liquidations and flows.
import { get, stream } from '../api.js';
import { usd, compact, int, price, pct, num, esc, timeOnly, ago, duration } from '../format.js';
import { kpi, seg, table, mkt, sideTag, addr, ratio, pctCell, fundingCell, tradeAction, chartTools, skeleton, skChart, empty, assignColors, colorOf, hasColor, OTHER_HEX, SLOT_HEX } from '../ui.js';
import { sparkline, stackedBars, lineChart, signedBars, toggleSeries, COLORS } from '../charts.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const MIN_SIZES = [['0', 'All'], ['100', '≥$100'], ['1000', '≥$1K'], ['10000', '≥$10K']];
const VOL_MODES = [['bars', 'Per period'], ['cum', 'Cumulative']];
const segSm = (name, options, active) => seg(name, options, active).replace('class="seg"', 'class="seg sm"');

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '24h';
  let volMode = 'bars';
  let sort = { key: 'volume', dir: 'desc' };
  let minSize = localStorage.getItem('ps.minsize') ?? '100';
  let data = null, series = null, alive = true;
  const tape = [], off = [];
  const panel = (id, title, desc) => `<section class="panel"><div class="panel-head"><div><h2>${title}</h2><div class="desc">${desc}</div></div><div class="head-right">${chartTools(id, id)}<div class="head-value" id="${id}-v"></div></div></div><div class="panel-body"><div class="chart sm" id="${id}">${skChart()}</div></div></section>`;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Perpl protocol</h1><div class="sub">Volume, open interest, fees and flows from Monad chain data, updated every block.</div></div>
      <div id="win">${seg('window', WINDOWS, w)}</div>
    </div>
    <div class="stack">
      <div class="kpis" id="kpis">${Array.from({ length: 6 }, () => '<div class="kpi"><div class="skeleton sk-line" style="width:40%"></div><div class="skeleton" style="height:26px;width:70%;margin-top:10px"></div><div class="skeleton" style="height:28px;margin-top:10px"></div></div>').join('')}</div>
      <div class="grid g-main">
        <section class="panel">
          <div class="panel-head"><div><h2>Trading volume</h2><div class="desc">Maker-fill notional by market</div></div><div class="head-right">${chartTools('main-chart', 'volume')}<div id="vol-mode">${segSm('vol', VOL_MODES, volMode)}</div></div></div>
          <div class="panel-head" style="min-height:0;padding-top:0"><div class="legend toggles" id="legend"></div><span class="meta" id="chart-meta"></span></div>
          <div class="panel-body"><div class="chart" id="main-chart">${skChart()}</div></div>
        </section>
        <section class="panel fill">
          <div class="panel-head"><h2>Live trades</h2><div id="minsize">${segSm('min', MIN_SIZES, minSize)}</div></div>
          <div class="panel-body flush scroll" id="tape">${skeleton(8)}</div>
          <div class="panel-foot"><span id="tape-meta">Finalized blocks · aggressor side</span><span id="tape-count"></span></div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><div><h2>Markets</h2><div class="desc" id="markets-meta"></div></div><a class="meta" href="#/markets">All markets →</a></div>
        <div class="panel-body flush" id="markets">${skeleton(8)}</div>
      </section>
      <div class="section-label">Trends</div>
      <div class="grid g-2">
        ${panel('oi', 'Open interest', 'One side, priced at the last trade')}
        ${panel('tvl', 'TVL', 'Collateral in the exchange contract')}
        ${panel('flows', 'Net deposits', 'Deposits minus withdrawals per period')}
        ${panel('traders', 'Active traders', 'Distinct accounts trading per period')}
        ${panel('fees', 'Fees', 'Protocol and insurance-fund shares')}
        ${panel('liq', 'Liquidations', 'Liquidated notional by market')}
      </div>
      <div class="section-label">Activity</div>
      <div class="grid g-3">
        <section class="panel"><div class="panel-head"><h2>Latest liquidations</h2><a class="meta" href="#/liquidations">View all →</a></div><div class="panel-body flush" id="liqs">${skeleton(5)}</div></section>
        <section class="panel"><div class="panel-head"><h2>Deposits and withdrawals</h2><span class="meta">Latest</span></div><div class="panel-body flush" id="flowlist">${skeleton(5)}</div></section>
        <section class="panel"><div class="panel-head"><h2>Across windows</h2><span class="meta">Exchange totals</span></div><div class="panel-body flush" id="windows">${skeleton(5)}</div></section>
      </div>
    </div>`;
  const $ = id => el.querySelector(`#${id}`);

  async function load() {
    const [p, s] = await Promise.all([get(`protocol?window=${w}`), get(`protocol/series?window=${w}`)]);
    if (!alive) return;
    data = p; series = s;
    assignColors([...p.markets].sort((a, b) => num(b.volume) - num(a.volume)).map(m => m.id));
    renderKpis(); renderVolume(); renderTrends(); renderMarkets(); renderWindows();
  }
  async function loadFeeds() {
    const [t, l, f] = await Promise.all([get('trades?limit=200', { maxAge: 800 }), get('liquidations?limit=8'), get(`flows?window=${w}`)]);
    if (!alive) return;
    tape.length = 0; tape.push(...t.rows);
    renderTape(); renderLiqs(l); renderFlows(f);
  }

  function spark(key, values, color = COLORS.accent) { const node = $(key); if (node && values.some(v => v !== null && v !== undefined)) sparkline(node, values, { color }); }
  function renderKpis() {
    const h = data.headline, c = data.current, pts = series.points;
    const cov = data.meta.coverage;
    const partial = cov && !cov.complete ? ' <span class="tag warn" title="History for this window is still being indexed">partial</span>' : '';
    $('kpis').innerHTML = [
      kpi({ label: `Volume · ${w === 'all' ? 'all-time' : w}`, value: usd(h.volume.value), delta: h.volume.change_pct, note: `${int(h.trades.value)} trades${partial}`, spark: 'sp-vol' }),
      kpi({ label: 'Open interest', value: usd(c?.open_interest), note: c ? `${int(c.positions)} open positions` : '', spark: 'sp-oi', tip: 'Long notional at the mark price; equal to short notional by construction, so each contract counts once.' }),
      kpi({ label: 'TVL', value: usd(c?.tvl), note: `${usd(h.net_flow.value, { sign: true })} net flow`, spark: 'sp-tvl', tip: 'Collateral held by the exchange contract, read from chain state.' }),
      kpi({ label: 'Fees', value: usd(h.fees.value), delta: h.fees.change_pct, note: `${usd(h.protocol_fees.value)} to protocol`, spark: 'sp-fees', tip: `Maker and taker fees on fills, split between the protocol (${usd(h.protocol_fees.value)}) and the insurance fund (${usd(h.insurance_fees.value)}). Builder fees ${usd(h.builder_fees)}.` }),
      kpi({ label: 'Active traders', value: int(h.traders.value), delta: h.traders.change_pct, note: `${int(h.new_accounts.value)} new accounts`, spark: 'sp-tr' }),
      kpi({ label: 'Liquidations', value: usd(h.liquidated.value), delta: h.liquidated.change_pct, invert: true, note: `${int(h.liquidations.value)} positions`, spark: 'sp-liq' })
    ].join('');
    spark('sp-vol', pts.map(p => num(p.volume)));
    spark('sp-oi', pts.map(p => num(p.open_interest)));
    spark('sp-tvl', pts.map(p => num(p.tvl)));
    spark('sp-fees', pts.map(p => num(p.fees)));
    spark('sp-tr', pts.map(p => p.traders));
    spark('sp-liq', pts.map(p => num(p.liquidated)), COLORS.short);
  }

  // Stacked by market: the six largest markets keep their colour, the rest fold into Other.
  function byMarket(metric) {
    const all = (series.by_market ?? []).filter(m => m[metric].some(v => num(v) > 0));
    const top = all.filter(m => hasColor(m.id)), rest = all.filter(m => !hasColor(m.id));
    const list = top.map(m => ({ name: m.symbol, color: colorOf(m.id), data: m[metric].map(num) }));
    if (rest.length) list.push({ name: 'Other', color: OTHER_HEX, data: series.times.map((_, i) => rest.reduce((a, m) => a + num(m[metric][i]), 0)) });
    return list;
  }
  function renderVolume() {
    const node = $('main-chart'), b = series.meta.bucket_seconds;
    node.innerHTML = '';
    $('chart-meta').textContent = `${series.meta.bucket} periods · UTC`;
    const list = byMarket('volume');
    const shown = volMode === 'bars' ? list : list.map(s => { let run = 0; return { ...s, data: s.data.map(v => (run += v || 0)) }; });
    stackedBars(node, { times: series.times, series: shown, bucketSeconds: b });
    $('legend').innerHTML = list.map(s => `<button class="lg" data-action="toggle" data-name="${esc(s.name)}"><i style="background:${s.color}"></i>${esc(s.name)}</button>`).join('');
  }
  // Open interest and TVL are running sums from launch, so they wait for the backfill.
  let backfill = null;
  function historyNote() {
    const p = backfill && !backfill.complete && backfill.pct < 100 ? ` Indexing is ${Math.floor(backfill.pct)}% done${backfill.eta_s ? `, about ${duration(backfill.eta_s)} left` : ''}.` : '';
    return `A running sum over every event since launch, drawn once history indexing completes.${p}`;
  }
  function headValue(id, value, note = '') { const n = $(`${id}-v`); if (n) n.innerHTML = `<div class="hv">${value}</div>${note ? `<div class="hn">${note}</div>` : ''}`; }
  function renderTrends() {
    const pts = series.points, times = series.times, b = series.meta.bucket_seconds, h = data.headline, c = data.current;
    const cumulative = series.meta.cumulative_complete;
    const waitHistory = historyNote();
    const oi = $('oi'); oi.innerHTML = '';
    headValue('oi', usd(c?.open_interest), 'now');
    if (cumulative) lineChart(oi, { times, series: [{ name: 'Open interest', color: COLORS.accent, data: pts.map(p => num(p.open_interest)) }], bucketSeconds: b }); else oi.innerHTML = empty(waitHistory);
    const tvl = $('tvl'); tvl.innerHTML = '';
    headValue('tvl', usd(c?.tvl), 'now');
    if (cumulative) lineChart(tvl, { times, series: [{ name: 'TVL', color: SLOT_HEX[2], data: pts.map(p => num(p.tvl)) }], bucketSeconds: b, scale: true }); else tvl.innerHTML = empty(waitHistory);
    const flows = $('flows'); flows.innerHTML = '';
    headValue('flows', `<span class="${num(h.net_flow.value) >= 0 ? 'pos' : 'neg'}">${usd(h.net_flow.value, { sign: true })}</span>`, `${usd(h.deposits.value)} in · ${usd(h.withdrawals.value)} out`);
    signedBars(flows, { times, values: pts.map(p => num(p.net_flow)), bucketSeconds: b, name: 'Net deposits' });
    const tr = $('traders'); tr.innerHTML = '';
    headValue('traders', int(h.traders.value), `${w === 'all' ? 'all-time' : w} distinct`);
    stackedBars(tr, { times, series: [{ name: 'Active traders', color: COLORS.accent, data: pts.map(p => p.traders) }], bucketSeconds: b, fmt: v => int(v), yFmt: v => compact(v, { digits: 0 }) });
    const fees = $('fees'); fees.innerHTML = '';
    headValue('fees', usd(h.fees.value), `${usd(h.protocol_fees.value)} protocol · ${usd(h.insurance_fees.value)} insurance`);
    stackedBars(fees, { times, series: [{ name: 'Protocol', color: SLOT_HEX[0], data: pts.map(p => num(p.protocol_fees)) }, { name: 'Insurance fund', color: SLOT_HEX[2], data: pts.map(p => num(p.fees) - num(p.protocol_fees)) }], bucketSeconds: b });
    const liq = $('liq'); liq.innerHTML = '';
    headValue('liq', usd(h.liquidated.value), `${int(h.liquidations.value)} positions`);
    const liqList = byMarket('liquidated');
    if (liqList.length) stackedBars(liq, { times, series: liqList, bucketSeconds: b }); else liq.innerHTML = empty('No liquidations in this window');
  }

  const marketCols = () => [
    { key: 'symbol', label: 'Market', sort: r => r.symbol, render: r => mkt(r.id, r.symbol) },
    { key: 'mark', label: 'Price', n: true, sort: r => num(r.mark ?? r.close), render: r => price(r.mark ?? r.close) },
    { key: 'change_pct', label: w === 'all' ? 'Change' : `${w} change`, n: true, sort: r => num(r.change_pct) ?? -1e9, render: r => pctCell(r.change_pct) },
    { key: 'volume', label: 'Volume', n: true, cls: 'cell-bar', sort: r => num(r.volume), render: r => `${usd(r.volume)}<span class="track"><i style="width:${Math.max(2, Math.min(100, r.share_pct ?? 0))}%"></i></span>` },
    { key: 'share_pct', label: 'Share', n: true, sort: r => r.share_pct ?? 0, render: r => `<span class="muted">${pct(r.share_pct, { digits: 1 })}</span>` },
    { key: 'open_interest', label: 'Open interest', n: true, sort: r => num(r.open_interest) ?? 0, render: r => usd(r.open_interest) },
    { key: 'funding', label: 'Funding 8h', n: true, sort: r => r.funding?.rate_8h_pct ?? 0, render: r => fundingCell(r.funding) },
    { key: 'ls', label: 'Long / short', sort: r => r.long_position_share_pct ?? 0, render: r => ratio(r.long_positions, r.short_positions) },
    { key: 'taker_buy_share_pct', label: 'Taker buys', n: true, sort: r => r.taker_buy_share_pct ?? 0, render: r => (r.taker_buy_share_pct === null || r.taker_buy_share_pct === undefined ? '—' : pct(r.taker_buy_share_pct, { digits: 1 })) },
    { key: 'traders', label: 'Traders', n: true, sort: r => r.traders ?? 0, render: r => int(r.traders) },
    { key: 'liquidations', label: 'Liquidated', n: true, sort: r => num(r.liquidated) ?? 0, render: r => (r.liquidations ? `${usd(r.liquidated)}<div class="sub">${int(r.liquidations)} pos.</div>` : '<span class="faint">—</span>') }
  ];
  function renderMarkets() {
    const rows = data.markets.filter(m => num(m.volume) > 0 || num(m.open_interest) > 0);
    $('markets').innerHTML = table({ id: 'markets', columns: marketCols(), rows, sortKey: sort.key, sortDir: sort.dir, rowAttrs: r => `class="link" data-href="#/markets/${r.id}"` });
    $('markets-meta').textContent = `${rows.length} active markets · ${w === 'all' ? 'all-time' : w} activity, live prices and positions`;
  }

  function renderTape() {
    const min = Number(minSize);
    const rows = tape.filter(r => (num(r.notional) ?? 0) >= min);
    $('tape-count').textContent = rows.length ? `${int(Math.min(rows.length, 60))} shown` : '';
    if (!rows.length) { $('tape').innerHTML = empty(tape.length ? 'No trades of this size yet' : 'Waiting for trades'); return; }
    $('tape').innerHTML = table({ id: 'tape', compact: true, columns: [
      { key: 't', label: 'Time', render: r => `<span class="muted num">${timeOnly(r.ts)}</span>` },
      { key: 'm', label: 'Market', render: r => mkt(r.market, r.symbol) },
      { key: 's', label: 'Action', render: tradeAction },
      { key: 'p', label: 'Price', n: true, render: r => price(r.price) },
      { key: 'v', label: 'Value', n: true, render: r => usd(r.notional) }
    ], rows: rows.slice(0, 60), rowAttrs: r => `class="link ${r.fresh ? 'flash' : ''} ${r.proposed ? 'proposed' : ''}" data-href="#/wallet/${esc(r.address || r.account)}" ${r.proposed ? 'title="Proposed block, not final yet"' : ''}` });
    for (const r of tape) r.fresh = false;
  }
  function renderLiqs(l) {
    $('liqs').innerHTML = l.rows.length ? table({ id: 'liqs', compact: true, columns: [
      { key: 'm', label: 'Market', render: r => mkt(r.market, r.symbol) },
      { key: 's', label: 'Position', render: r => sideTag(r.side) },
      { key: 'v', label: 'Value', n: true, render: r => usd(r.notional) },
      { key: 't', label: 'When', n: true, render: r => `<span class="muted">${ago(r.ts)}</span>` }
    ], rows: l.rows.slice(0, 7), rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.address || r.account)}"` }) : empty('No liquidations yet');
  }
  function renderFlows(f) {
    const rows = (f.recent ?? []).slice(0, 7);
    $('flowlist').innerHTML = rows.length ? table({ id: 'flowlist', compact: true, columns: [
      { key: 'k', label: 'Type', render: r => `<span class="${r.kind === 'deposit' ? 'pos' : 'neg'}">${r.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}</span>` },
      { key: 'a', label: 'Wallet', render: r => addr(r.address, r.account, { star: false }) },
      { key: 'v', label: 'Amount', n: true, render: r => usd(r.amount) },
      { key: 't', label: 'When', n: true, render: r => `<span class="muted">${ago(r.ts)}</span>` }
    ], rows }) : empty('No recent deposits or withdrawals');
  }
  function renderWindows() {
    const ws = data.windows;
    const rows = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All-time']].map(([k, label]) => ({ k, label, ...(ws[k] ?? {}) }));
    $('windows').innerHTML = table({ id: 'win', compact: true, columns: [
      { key: 'label', label: 'Window', render: r => `${r.label}${r.k === w ? ' <span class="tag accent">shown</span>' : ''}` },
      { key: 'volume', label: 'Volume', n: true, render: r => usd(r.volume) },
      { key: 'fees', label: 'Fees', n: true, render: r => usd(r.fees) },
      { key: 'traders', label: 'Traders', n: true, render: r => int(r.traders) }
    ], rows, rowAttrs: r => `class="link" data-href="#/?window=${r.k}"` });
  }

  // Live: finalized trades stream in; proposed ones appear first, dimmed.
  off.push(stream.on('trades', rows => {
    for (const r of rows.slice().reverse()) { const i = tape.findIndex(x => x.proposed && x.tx === r.tx); if (i >= 0) tape.splice(i, 1); tape.unshift({ ...r, fresh: true }); }
    tape.length = Math.min(tape.length, 400); renderTape();
  }));
  off.push(stream.on('proposed', p => { for (const r of p.trades) if (!tape.some(x => x.tx === r.tx)) tape.unshift({ ...r, proposed: true, fresh: true }); tape.length = Math.min(tape.length, 400); $('tape-meta').textContent = 'Proposed + finalized blocks'; renderTape(); }));
  off.push(stream.on('backfill', p => {
    const finished = backfill && !backfill.complete && p.complete;
    backfill = p;
    if (!alive || !series) return;
    if (finished) get(`protocol/series?window=${w}`, { maxAge: 0 }).then(s => { if (!alive) return; series = s; renderTrends(); }).catch(() => {});
    else if (!series.meta.cumulative_complete) for (const id of ['oi', 'tvl']) { const n = $(id)?.querySelector('.empty-state'); if (n) n.textContent = historyNote(); }
  }));
  get('health', { maxAge: 30000 }).then(h => { backfill = h.index?.backfill ?? null; }).catch(() => {});
  off.push(stream.on('liquidations', () => get('liquidations?limit=8', { maxAge: 0 }).then(l => alive && renderLiqs(l)).catch(() => {})));
  off.push(stream.on('protocol', p => { if (w !== '24h' || !data || !alive) return; data = { ...data, headline: p.headline, current: p.current, markets: data.markets.map(m => { const u = p.markets.find(x => x.id === m.id); return u ? { ...m, mark: u.mark ?? m.mark, volume: u.volume, change_pct: u.change_pct, open_interest: u.open_interest ?? m.open_interest, funding: u.funding ?? m.funding } : m; }) }; renderKpis(); renderMarkets(); }));
  const timer = setInterval(() => { get(`protocol/series?window=${w}`, { maxAge: 0 }).then(s => { if (!alive) return; series = s; renderVolume(); renderTrends(); if (w !== '24h') load().catch(() => {}); }).catch(() => {}); }, 60000);

  load().catch(error => { $('kpis').innerHTML = `<div class="empty-state">Could not load protocol data (${esc(error.message)})</div>`; });
  loadFeeds().catch(() => {});

  return {
    onSeg(name, v) {
      if (name === 'window') setQuery({ window: v === '24h' ? null : v });
      if (name === 'min') { minSize = v; try { localStorage.setItem('ps.minsize', v); } catch { /* storage unavailable */ } $('minsize').innerHTML = segSm('min', MIN_SIZES, minSize); renderTape(); }
      if (name === 'vol') { volMode = v; $('vol-mode').innerHTML = segSm('vol', VOL_MODES, volMode); renderVolume(); }
    },
    onAction(a, t) { if (a === 'toggle') { t.classList.toggle('off'); toggleSeries($('main-chart'), t.dataset.name); } },
    onSort(id, key) { if (id !== 'markets') return; sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' }; renderMarkets(); },
    update(q) { const nw = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '24h'; if (nw === w) return; w = nw; $('win').innerHTML = seg('window', WINDOWS, w); load().catch(() => {}); get(`flows?window=${w}`).then(f => alive && renderFlows(f)).catch(() => {}); },
    destroy() { alive = false; clearInterval(timer); off.forEach(f => f()); }
  };
}
