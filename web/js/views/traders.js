// Trader leaderboard over a window: net PnL, volume, losses, liquidations,
// with open positions from the live contract state.
import { get } from '../api.js';
import { usd, int, pct, num, esc } from '../format.js';
import { seg, table, addr, pnl, ratio, kpi, skeleton, mkt, ICON } from '../ui.js';

const WINDOWS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']];
const SORTS = [['pnl', 'Top PnL'], ['loss', 'Top losses'], ['volume', 'Volume'], ['liquidated', 'Liquidated'], ['fees', 'Fees paid'], ['net_flow', 'Net inflow'], ['deposits', 'Deposits'], ['withdrawals', 'Withdrawals']];
const FLOW_SORTS = new Set(['net_flow', 'deposits', 'withdrawals']);
const CO_TABS = [['size', 'By size'], ['pnl', 'By track record']];

export function mount(el, { query, setQuery }) {
  let w = WINDOWS.some(([v]) => v === query.get('window')) ? query.get('window') : '7d';
  let by = SORTS.some(([v]) => v === query.get('by')) ? query.get('by') : 'pnl';
  let page = 0, alive = true, data = null, cohorts = null, coTab = 'size', coSel = null;
  const LIMIT = 50;
  el.innerHTML = `
    <div class="page-head"><div><h1>Traders</h1><div class="sub">Accounts that traded in the window, ranked from indexed events (flow rankings: accounts that deposited or withdrew). Net PnL = realized PnL (price PnL + funding) − fees.</div></div></div>
    <div class="kpis k4" id="tkpis" style="margin-bottom:16px">${Array.from({ length: 4 }, () => '<div class="kpi"><div class="skeleton sk-line" style="width:40%"></div><div class="skeleton" style="height:26px;width:60%;margin-top:10px"></div></div>').join('')}</div>
    <section class="panel" style="margin-bottom:16px"><div class="panel-head"><div><h2>Positioning by cohort</h2><div class="desc" id="co-desc">Open positions now, grouped by account · click a cohort for its largest wallets</div></div><div id="co-tabs">${seg('co', CO_TABS, coTab)}</div></div>
      <div class="panel-body flush" id="cohorts">${skeleton(4)}</div><div id="co-detail"></div></section>
    <section class="panel"><div class="panel-head"><h2 id="title">Leaderboard</h2><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input id="lb-search" class="calc-in lb-search" type="search" placeholder="Filter this page · Enter opens a wallet" autocomplete="off" spellcheck="false" aria-label="Filter traders by address"><span class="meta" id="meta"></span><a class="btn ghost" id="csv">${ICON.download} CSV</a></div></div>
      <div class="panel-head" style="min-height:0;padding-top:0;flex-wrap:wrap;gap:10px"><div id="by" style="max-width:100%;min-width:0">${seg('by', SORTS, by)}</div><div id="win">${seg('window', WINDOWS, w)}</div></div>
      <div class="panel-body flush" id="list">${skeleton(12)}</div>
      <div class="panel-foot"><span id="count"></span><span><button class="btn ghost" data-action="prev">← Prev</button> <button class="btn ghost" data-action="next">Next →</button></span></div></section>`;
  const $ = s => el.querySelector(`#${s}`);
  // At most two rule-based style tags per trader; each title gives the evidence.
  const DAYS = { '24h': 1, '7d': 7, '30d': 30 };
  function styleTags(r) {
    const out = [], trades = r.trades ?? 0, vol = num(r.volume) ?? 0;
    if (trades && vol / trades >= 25000) out.push(['Whale', `average trade ${usd(vol / trades)}`]);
    if (trades >= 100 && (r.maker_share_pct ?? 0) >= 80) out.push(['Maker', `${Math.round(r.maker_share_pct)}% of volume as maker`]);
    if (DAYS[w] && trades / DAYS[w] >= 5000) out.push(['High frequency', `${int(trades / DAYS[w])} trades a day, one every ${Math.round(86400 * DAYS[w] / trades)} s`]);
    return out.slice(0, 2).map(([t, why]) => `<span class="tag" title="${esc(why)}">${t}</span>`).join(' ');
  }
  const COLS = [
    { key: 'rank', label: '#', render: r => `<span class="rank">${r.rank}</span>` },
    { key: 'addr', label: 'Trader', render: r => { const t = styleTags(r); return `${addr(r.address, r.account)}${t ? `<div class="sub tags">${t}</div>` : ''}`; } },
    { key: 'pnl', label: 'Net PnL', n: true, render: r => pnl(r.pnl) },
    { key: 'roi', label: 'PnL / volume', n: true, render: r => r.roi_on_volume_bps === null ? '—' : `<span class="${r.roi_on_volume_bps > 0 ? 'pos' : r.roi_on_volume_bps < 0 ? 'neg' : ''}">${(r.roi_on_volume_bps / 100).toFixed(2)}%</span>` },
    { key: 'volume', label: 'Volume', n: true, render: r => usd(r.volume) },
    { key: 'trades', label: 'Trades', n: true, render: r => int(r.trades) },
    { key: 'maker', label: 'Maker share', n: true, render: r => pct(r.maker_share_pct, { digits: 0 }) },
    { key: 'fees', label: 'Fees', n: true, render: r => usd(r.fees) },
    { key: 'liq', label: 'Liquidated', n: true, render: r => (num(r.liquidated) > 0 ? `<span class="neg">${usd(r.liquidated)}</span>` : '<span class="faint">—</span>') },
    { key: 'dep', flow: true, label: 'Deposits', n: true, render: r => (num(r.deposits) > 0 ? usd(r.deposits) : '<span class="faint">—</span>') },
    { key: 'wd', flow: true, label: 'Withdrawals', n: true, render: r => (num(r.withdrawals) > 0 ? usd(r.withdrawals) : '<span class="faint">—</span>') },
    { key: 'net', flow: true, label: 'Net flow', n: true, render: r => { const v = (num(r.deposits) ?? 0) - (num(r.withdrawals) ?? 0); return v ? `<span class="${v > 0 ? 'pos' : 'neg'}">${usd(v, { sign: true })}</span>` : '<span class="faint">—</span>'; } },
    { key: 'open', label: 'Open now', n: true, render: r => (r.open_positions ? `${usd(r.open_notional)}<div class="sub">${r.open_positions} pos · uPnL ${usd(r.unrealized_pnl, { sign: true })}</div>` : '<span class="faint">—</span>') },
    { key: 'markets', label: 'Markets', render: r => `<span class="muted">${esc(r.markets.slice(0, 4).join(' · '))}${r.markets.length > 4 ? ` +${r.markets.length - 4}` : ''}</span>` }
  ];
  async function load() {
    $('list').innerHTML = skeleton(12);
    data = await get(`leaderboard?window=${w}&by=${by}&limit=${LIMIT}&offset=${page * LIMIT}`);
    if (!alive) return;
    $('title').textContent = SORTS.find(([v]) => v === by)[1];
    $('meta').textContent = `${w === 'all' ? 'All-time' : w}${data.meta.coverage && !data.meta.coverage.complete ? ' · history still indexing' : ''}`;
    // Flow rankings swap the fee and liquidation columns for the flows themselves.
    const flow = FLOW_SORTS.has(by), columns = COLS.filter(c => (flow ? !['fees', 'liq', 'maker'].includes(c.key) : !c.flow));
    lbColumns = columns; renderList();
    $('count').textContent = `${int(data.total)} accounts · showing ${page * LIMIT + 1}–${page * LIMIT + data.rows.length}`;
    $('csv').href = `/api/v1/leaderboard?window=${w}&by=${by}&limit=200&format=csv`;
  }
  // The leaderboard page, filtered by the address typed in its search box.
  let lbColumns = null, filter = '';
  function renderList() {
    if (!data || !lbColumns) return;
    const f = filter.toLowerCase();
    const rows = f ? data.rows.filter(r => String(r.address ?? '').toLowerCase().includes(f) || String(r.account) === f.replace(/^#/, '')) : data.rows;
    $('list').innerHTML = table({ id: 'lb', columns: lbColumns, rows, rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.address || r.account)}"`, emptyText: f ? 'Not on this page. Press Enter to open the wallet, if it is a full address or account ID.' : 'No traders in this window' });
  }
  $('lb-search').addEventListener('input', e => { filter = e.target.value.trim(); renderList(); });
  $('lb-search').addEventListener('keydown', e => { const q = e.target.value.trim(); if (e.key === 'Enter' && (/^0x[0-9a-fA-F]{40}$/.test(q) || /^\d{1,9}$/.test(q))) location.hash = `#/wallet/${q}`; });

  // Traders at a glance for the leaderboard's window.
  async function loadSummary() {
    const t = await get(`traders/summary?window=${w}`, { maxAge: 20000 });
    if (!alive) return;
    const wl = w === 'all' ? 'all-time' : w, partial = t.meta?.coverage && !t.meta.coverage.complete ? ' <span class="tag warn" title="History for this window is still being indexed">partial</span>' : '';
    $('tkpis').innerHTML = [
      kpi({ label: `Traders · ${wl}`, value: int(t.traders), note: `${usd(t.volume)} volume${partial}` }),
      kpi({ label: `Profitable · ${wl}`, value: int(t.profitable), note: `${pct(t.profitable_pct, { digits: 1 })} of traders, after fees` }),
      kpi({ label: `Traders' net PnL · ${wl}`, value: pnl(t.net_pnl), note: 'all traders, after fees', tip: 'Realized PnL (price PnL and funding) minus fees, summed over every account that traded in the window.' }),
      kpi({ label: 'Median PnL / volume', value: t.median_pnl_per_volume_bps === null ? '—' : `<span class="${t.median_pnl_per_volume_bps > 0 ? 'pos' : t.median_pnl_per_volume_bps < 0 ? 'neg' : ''}">${t.median_pnl_per_volume_bps > 0 ? '+' : ''}${t.median_pnl_per_volume_bps.toFixed(1)} bps</span>`, note: 'the typical trader, per $ traded', tip: 'Net PnL divided by volume for each trader, then the median across traders: what the typical trader keeps or loses per dollar traded.' })
    ].join('');
  }

  // Cohorts: who holds the open interest, by size or by track record.
  function renderCohorts() {
    if (!cohorts) return;
    const groups = coTab === 'size' ? cohorts.by_size : cohorts.by_pnl;
    const bias = g => { const s = g.long_share_pct; if (s === null) return '<span class="faint">—</span>'; const [t, c] = s >= 65 ? ['Strong long', 'pos'] : s >= 55 ? ['Long', 'pos'] : s <= 35 ? ['Strong short', 'neg'] : s <= 45 ? ['Short', 'neg'] : ['Neutral', 'muted']; return `<span class="${c}">${t}</span>`; };
    $('cohorts').innerHTML = table({ id: 'co', columns: [
      { key: 'c', label: 'Cohort', render: g => `<b>${esc(g.label)}</b><div class="sub">${esc(g.rule)}</div>` },
      { key: 'a', label: 'Accounts', n: true, render: g => `${int(g.accounts)}<div class="sub"><span class="pos">${int(g.net_long_accounts)} L</span> · <span class="neg">${int(g.net_short_accounts)} S</span></div>` },
      { key: 'r', label: 'Long / short notional', render: g => ratio(g.long_notional, g.short_notional) },
      { key: 'n', label: 'Net', n: true, render: g => (g.accounts ? `<span class="${g.net_notional >= 0 ? 'pos' : 'neg'}">${usd(g.net_notional, { sign: true })}</span><div class="sub">of ${usd(g.long_notional + g.short_notional)}</div>` : '—') },
      { key: 'b', label: 'Bias', render: bias },
      { key: 'u', label: 'Unrealized PnL', n: true, render: g => (g.accounts ? `${pnl(g.unrealized_pnl)}<div class="sub">${int(g.in_profit)} of ${int(g.accounts)} in profit</div>` : '—') },
      { key: 'm', label: 'Main markets', render: g => `<span class="muted">${g.markets.slice(0, 3).map(m => `${esc(m.symbol)} ${m.long >= m.short ? '↑' : '↓'}`).join(' · ') || '—'}</span>` }
    ], rows: groups, rowAttrs: g => `class="link${coSel === g.key ? ' sel' : ''}" data-action="co-pick" data-key="${esc(g.key)}"` });
    $('co-desc').textContent = coTab === 'size' ? 'Open positions now, grouped by each account\'s total open notional · click a cohort for its wallets' : `Grouped by net PnL over indexed history${cohorts.meta?.coverage && !cohorts.meta.coverage.complete ? ' (history still indexing)' : ''}${cohorts.unranked ? ` · ${int(cohorts.unranked)} accounts without indexed trades left out` : ''}`;
    const g = groups.find(x => x.key === coSel);
    $('co-detail').innerHTML = g ? `<div class="panel-head" style="min-height:0;padding-top:12px"><h2 style="font-size:12.5px;color:var(--text-2);font-weight:500">${esc(g.label)}: largest wallets</h2><button class="btn ghost" data-action="co-close">Close</button></div>${table({ id: 'co-top', compact: true, emptyText: 'No accounts', columns: [
      { key: 'a', label: 'Wallet', render: a => addr(a.address, a.account) },
      { key: 'n', label: 'Open notional', n: true, render: a => usd(a.notional) },
      { key: 'd', label: 'Net direction', n: true, render: a => `<span class="${a.net >= 0 ? 'pos' : 'neg'}">${usd(a.net, { sign: true })}</span>` },
      { key: 'u', label: 'uPnL', n: true, render: a => pnl(a.upnl) },
      { key: 'p', label: 'Net PnL (history)', n: true, render: a => (a.pnl === null ? '<span class="faint">—</span>' : pnl(a.pnl)) }
    ], rows: g.top, rowAttrs: a => `class="link" data-href="#/wallet/${esc(a.address || a.account)}"` })}` : '';
  }
  const loadCohorts = () => get('cohorts', { maxAge: 5000 }).then(c => { if (!alive) return; cohorts = c; renderCohorts(); }).catch(() => { if (!cohorts) $('cohorts').innerHTML = '<div class="empty-state">Live positions unavailable</div>'; });
  loadCohorts();
  const coTimer = setInterval(loadCohorts, 10000);

  load().catch(error => { $('list').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; });
  loadSummary().catch(() => { $('tkpis').innerHTML = ''; });
  return {
    onSeg(name, v) { if (name === 'co') { coTab = v; coSel = null; $('co-tabs').innerHTML = seg('co', CO_TABS, coTab); renderCohorts(); return; } if (name === 'window') setQuery({ window: v === '7d' ? null : v }); if (name === 'by') setQuery({ by: v === 'pnl' ? null : v }); },
    onAction(a, t) { if (a === 'co-pick') { coSel = coSel === t.dataset.key ? null : t.dataset.key; renderCohorts(); return; } if (a === 'co-close') { coSel = null; renderCohorts(); return; } if (a === 'next' && data && (page + 1) * LIMIT < data.total) { page++; load().catch(() => {}); } if (a === 'prev' && page > 0) { page--; load().catch(() => {}); } },
    update(q) { w = WINDOWS.some(([v]) => v === q.get('window')) ? q.get('window') : '7d'; by = SORTS.some(([v]) => v === q.get('by')) ? q.get('by') : 'pnl'; page = 0; $('win').innerHTML = seg('window', WINDOWS, w); $('by').innerHTML = seg('by', SORTS, by); load().catch(() => {}); loadSummary().catch(() => {}); },
    destroy() { alive = false; clearInterval(coTimer); }
  };
}
export { mkt };
