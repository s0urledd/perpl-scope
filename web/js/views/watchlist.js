// Watchlist (stored in this browser): saved wallets with live account value,
// positions and PnL, one click to compare.
import { get } from '../api.js';
import { usd, int, esc, short, ago } from '../format.js';
import { table, pnl, empty, skeleton, watch, ICON } from '../ui.js';

export function mount(el, { navigate }) {
  let alive = true;
  el.innerHTML = `<div class="page-head"><div><h1>Watchlist</h1><div class="sub">Wallets you star are kept in this browser only.</div></div><button class="btn primary" data-action="compare">Compare all</button></div>
    <section class="panel" id="list">${skeleton(6)}</section>`;
  async function load() {
    const list = watch.list();
    el.querySelector('[data-action="compare"]').disabled = !list.length;
    if (!list.length) { el.querySelector('#list').innerHTML = empty('No wallets yet. Star a wallet from the leaderboard, a feed or a wallet page.'); return; }
    const rows = await Promise.all(list.map(w => get(`wallets/${encodeURIComponent(w.key)}`, { maxAge: 10000 }).then(d => ({ key: w.key, added: w.added, d })).catch(() => ({ key: w.key, added: w.added, d: null }))));
    if (!alive) return;
    el.querySelector('#list').innerHTML = table({ id: 'watch', columns: [
      { key: 'a', label: 'Wallet', render: r => `<span class="addr"><a class="mono" href="#/wallet/${esc(r.d?.account.address ?? r.key)}">${esc(short(r.d?.account.address ?? r.key))}</a><button class="icon-btn on" data-watch="${esc(r.key)}" title="Remove">${ICON.star}</button></span>` },
      { key: 'v', label: 'Account value', n: true, render: r => usd(r.d?.portfolio?.account_value) },
      { key: 'o', label: 'Open positions', n: true, render: r => int(r.d?.positions?.length ?? 0) },
      { key: 'u', label: 'Unrealized PnL', n: true, render: r => pnl(r.d?.portfolio?.unrealized_pnl) },
      { key: 'p', label: 'Net PnL', n: true, render: r => pnl(r.d?.summary.net_pnl) },
      { key: 't', label: 'Trades', n: true, render: r => int(r.d?.summary.trades) },
      { key: 'vol', label: 'Volume', n: true, render: r => usd(r.d?.summary.volume) },
      { key: 'l', label: 'Last trade', n: true, render: r => `<span class="muted">${r.d?.summary.last_trade ? ago(r.d.summary.last_trade) : '—'}</span>` }
    ], rows, rowAttrs: r => `class="link" data-href="#/wallet/${esc(r.d?.account.address ?? r.key)}"` });
  }
  const onChange = () => load().catch(() => {});
  window.addEventListener('watchlist', onChange);
  load().catch(() => {});
  return {
    onAction(a) { if (a === 'compare') navigate('/compare', { w: watch.list().slice(0, 5).map(w => w.key).join(',') }); },
    destroy() { alive = false; window.removeEventListener('watchlist', onChange); }
  };
}
