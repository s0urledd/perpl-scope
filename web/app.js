// PerplScope dashboard entry: routing, data loading and refresh. Views live in web/views/, primitives in web/ui.js.
import { h, view, $main, $snapshot, app, getJson, WINDOWS, getWatchlist, setWatchlist, toggleWatch } from './ui.js';
import { overviewView, tradersView, liquidationsView } from './views/protocol.js';
import { accountView, compareView } from './views/wallet.js';
import { syncingView, marketView, validationView, aboutView } from './views/risk.js';

const WINDOW_KEY = 'perplscope-window';
view.window = (() => { try { const w = localStorage.getItem(WINDOW_KEY); return WINDOWS.includes(w) ? w : '24h'; } catch { return '24h'; } })();
view.by = 'pnl';
function setWindow(w) { view.window = w; try { localStorage.setItem(WINDOW_KEY, w); } catch {} refresh(); }
function setBy(b) { view.by = b; refresh(); }

function parseRoute() {
  const hash = location.hash || '#/';
  const market = hash.match(/^#\/market\/(\d+)/);
  if (market) return { route: 'market', params: { id: market[1] } };
  const account = hash.match(/^#\/account\/([0-9a-zA-Zx]{1,42})/);
  if (account) return { route: 'account', params: { key: account[1] } };
  if (hash.startsWith('#/traders')) return { route: 'traders', params: {} };
  if (hash.startsWith('#/compare')) { const add = hash.match(/[?&]add=([0-9a-zA-Zx]{1,42})/); return { route: 'compare', params: { add: add ? add[1] : null } }; }
  if (hash.startsWith('#/liquidations')) return { route: 'liquidations', params: {} };
  if (hash.startsWith('#/validation')) return { route: 'validation', params: {} };
  if (hash.startsWith('#/about')) return { route: 'about', params: {} };
  return { route: 'overview', params: {} };
}
function render(node) { const y = window.scrollY; $main.replaceChildren(node); $main.classList.remove('refreshing'); window.scrollTo(0, y); }
const notFound = (title, text) => h('div', {}, h('h1', {}, title), h('p', { class: 'sub' }, text));

async function refresh() {
  if (view.inflight) return; view.inflight = true;
  if ($main.childElementCount) $main.classList.add('refreshing');
  try {
    const { route, params } = view;
    const w = view.window;
    if (route === 'about') { render(aboutView()); return; }
    if (route === 'overview') {
      const [stats, series, overview] = await Promise.all([getJson(`/stats?window=${w}`), getJson(`/stats/series?window=${w}`), getJson('/overview')]);
      render(stats.ok ? overviewView({ stats: stats.data, series: series.ok ? series.data : null, overview: overview.ok ? overview.data : null, window: w, onWindow: setWindow }) : syncingView(stats.data));
    } else if (route === 'traders') {
      const board = await getJson(`/leaderboard?window=${w}&by=${view.by}&limit=100`);
      render(board.ok ? tradersView({ board: board.data, window: w, by: view.by, onWindow: setWindow, onBy: setBy }) : syncingView(board.data));
    } else if (route === 'market') {
      const [detail, list, series] = await Promise.all([getJson(`/markets/${params.id}?limit=25`), getJson('/markets'), getJson(`/series?market=${params.id}&hours=24`)]);
      if (!detail.ok) return render(detail.status === 404 ? notFound('Unknown market', 'No market with this id.') : syncingView(detail.data));
      let positions = detail.data.market.top_positions;
      if (view.sort !== 'notional') { const p = await getJson(`/markets/${params.id}/positions?sort=${view.sort}&limit=25`); if (p.ok) positions = p.data.positions; }
      render(marketView({ ...detail.data.market, top_positions: positions, snapshot_block: detail.data.snapshot.block, snapshot_block_time_ms: detail.data.snapshot.block_time_ms }, list.ok ? list.data.markets : [detail.data.market], series.ok ? series.data : null));
    } else if (route === 'account') {
      const r = await getJson(`/accounts/${encodeURIComponent(params.key)}`);
      render(r.ok ? accountView(r.data) : r.status === 404 ? notFound('No account found', 'This address has not created a Perpl account, or the ID does not exist.') : r.status === 400 ? notFound('Invalid account key', 'Enter a numeric account ID or a 0x address.') : syncingView(r.data));
    } else if (route === 'compare') {
      if (params.add && !getWatchlist().some(k => k.toLowerCase() === params.add.toLowerCase())) { toggleWatch(params.add); }
      if (params.add) { history.replaceState(null, '', '#/compare'); view.params = {}; }
      const keys = getWatchlist();
      const results = await Promise.all(keys.map(async key => { const r = await getJson(`/accounts/${encodeURIComponent(key)}`); return { key, data: r.ok ? r.data : null, error: r.ok ? null : r.status === 404 ? 'not found' : r.status === 400 ? 'invalid key' : 'unavailable' }; }));
      render(compareView(results, { onRemove: key => { setWatchlist(getWatchlist().filter(k => k !== key)); refresh(); }, onAdd: key => { toggleWatch(key); refresh(); } }));
    } else if (route === 'liquidations') {
      const [r, stats, series] = await Promise.all([getJson('/liquidations?limit=200'), getJson(`/stats?window=${w}`), getJson(`/stats/series?window=${w}`)]);
      render(r.ok ? liquidationsView(r.data, stats.ok ? stats.data : null, series.ok ? series.data : null, w, setWindow) : syncingView(r.data));
    } else if (route === 'validation') {
      const [v, ref, idx] = await Promise.all([getJson('/validation'), getJson('/reference'), getJson('/index')]);
      render(v.ok ? validationView(v.data, ref.ok ? ref.data : { enabled: false }, idx.ok ? idx.data : null) : syncingView(v.data));
    }
  } catch (error) { render(h('div', {}, h('h1', {}, 'Unable to reach the API'), h('p', { class: 'sub' }, error.message))); }
  finally { view.inflight = false; $main.classList.remove('refreshing'); }
}
app.refresh = refresh;

function paintWatchCount() { const n = getWatchlist().length; const el = document.getElementById('watch-count'); if (el) el.textContent = n ? String(n) : ''; }
function navigate() {
  const next = parseRoute();
  if (next.route !== view.route || JSON.stringify(next.params) !== JSON.stringify(view.params)) { $main.replaceChildren(); view.sort = 'notional'; view.stressResult = null; }
  Object.assign(view, next);
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.route === view.route));
  clearInterval(view.timer);
  refresh();
  view.timer = setInterval(refresh, view.route === 'market' ? 5000 : view.route === 'compare' ? 20000 : 10000);
}
window.addEventListener('hashchange', navigate);
document.addEventListener('watchlist', paintWatchCount);
document.getElementById('search').addEventListener('submit', evt => { evt.preventDefault(); const key = document.getElementById('search-input').value.trim(); if (key) location.hash = `#/account/${key}`; });
document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('perplscope-theme', root.dataset.theme); } catch {}
  refresh();
});
try { const saved = localStorage.getItem('perplscope-theme'); if (saved) document.documentElement.dataset.theme = saved; } catch {}
paintWatchCount();
navigate();
