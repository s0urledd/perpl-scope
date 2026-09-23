// Small UI components rendered as HTML strings (every dynamic value goes
// through esc) plus the watchlist store and market colour assignment.
import { esc, short, num, usd, pct, deltaHtml } from './format.js';

export const ICON = {
  star: '<svg viewBox="0 0 16 16"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/></svg>',
  starOff: '<svg viewBox="0 0 16 16"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 10.5V3.8C3 3.1 3.6 2.5 4.3 2.5H10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  ext: '<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13H3V4.5h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
};
export const EXPLORER = 'https://monadvision.com';

// --- market colours: follow the market, never its rank in a given view ----------
const SLOTS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
export const SLOT_HEX = ['#7b7dea', '#d36c00', '#00a999', '#b28500', '#cd5ea2', '#0098de'];
export const OTHER_HEX = '#5c5b66';
let colorMap = {};
try { colorMap = JSON.parse(localStorage.getItem('ps.colors') || '{}'); } catch { colorMap = {}; }
// Assigns free slots to markets ranked by all-time volume (called once data arrives).
export function assignColors(idsByVolume) {
  const used = new Set(Object.values(colorMap));
  for (const id of idsByVolume) { if (Object.keys(colorMap).length >= SLOTS.length) break; if (colorMap[id] === undefined) { const slot = SLOTS.findIndex((_, i) => !used.has(i)); if (slot === -1) break; colorMap[id] = slot; used.add(slot); } }
  try { localStorage.setItem('ps.colors', JSON.stringify(colorMap)); } catch { /* storage unavailable */ }
}
export const colorOf = id => (colorMap[id] === undefined ? OTHER_HEX : SLOT_HEX[colorMap[id]]);
export const hasColor = id => colorMap[id] !== undefined;

// --- components ---------------------------------------------------------------------
export const mkt = (id, symbol, name = null) => `<span class="mkt"><i class="sw" style="background:${colorOf(id)}"></i>${esc(symbol ?? `#${id}`)}${name ? ` <span class="nm">${esc(name)}</span>` : ''}</span>`;
export const sideTag = side => { const s = String(side ?? '').toLowerCase(); return s === 'long' || s === 'short' ? `<span class="side ${s}">${s === 'long' ? 'LONG' : 'SHORT'}</span>` : '<span class="faint">—</span>'; };
export function addr(address, account, { star = true } = {}) {
  const key = address || String(account ?? '');
  if (!key) return '<span class="faint">—</span>';
  const label = address ? short(address) : `#${esc(account)}`;
  return `<span class="addr"><a href="#/wallet/${esc(key)}" title="${esc(address || `Account ${account}`)}">${label}</a>${address ? `<button class="icon-btn" data-copy="${esc(address)}" title="Copy address">${ICON.copy}</button>` : ''}${star ? `<button class="icon-btn ${watch.has(key) ? 'on' : ''}" data-watch="${esc(key)}" title="Watch wallet">${watch.has(key) ? ICON.star : ICON.starOff}</button>` : ''}</span>`;
}
export function kpi({ label, value, delta = undefined, invert = false, note = '', spark = null, tip = null, cls = '' }) {
  return `<div class="kpi ${cls}"><div class="kpi-label">${esc(label)}${tip ? ` <span class="info-tip" title="${esc(tip)}">i</span>` : ''}</div><div class="kpi-value">${value}</div><div class="kpi-row">${delta === undefined ? '' : deltaHtml(delta, invert)}<span class="kpi-note">${note}</span></div>${spark ? `<div class="spark" id="${esc(spark)}"></div>` : ''}</div>`;
}
export const seg = (name, options, active) => `<div class="seg" role="group">${options.map(([v, label]) => `<button data-seg="${esc(name)}" data-v="${esc(v)}" class="${String(v) === String(active) ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
export const tabs = (name, options, active) => `<div class="tabs" role="tablist">${options.map(([v, label]) => `<button role="tab" data-tab="${esc(name)}" data-v="${esc(v)}" class="${v === active ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
export function ratio(long, short) {
  const l = num(long) ?? 0, s = num(short) ?? 0, t = l + s;
  if (!t) return '<span class="faint">—</span>';
  const lp = Math.round(l / t * 100);
  return `<div class="ratio-wrap"><div class="ratio"><i class="l" style="width:${lp}%"></i><i class="s" style="width:${100 - lp}%"></i></div><div class="lbl"><span>${lp}% L</span><span>${100 - lp}% S</span></div></div>`;
}
export const pnl = v => { const n = num(v); return n === null ? '—' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${usd(v, { sign: true })}</span>`; };
export const pctCell = (v, sign = true) => { const n = num(v); return n === null ? '<span class="faint">—</span>' : `<span class="${sign ? (n > 0 ? 'pos' : n < 0 ? 'neg' : '') : ''}">${pct(v, { sign })}</span>`; };
export const skeleton = (rows = 6) => `<div class="panel-body">${Array.from({ length: rows }, (_, i) => `<div class="skeleton sk-line" style="width:${92 - (i % 3) * 14}%"></div>`).join('')}</div>`;
export const skChart = () => '<div class="panel-body"><div class="skeleton sk-block"></div></div>';
export const empty = text => `<div class="empty-state">${esc(text)}</div>`;

// Sortable table: columns [{ key, label, n: numeric, sort: value fn, render }]
export function table({ id, columns, rows, sortKey = null, sortDir = 'desc', rowAttrs = () => '', compact = false, emptyText = 'No data' }) {
  if (!rows.length) return empty(emptyText);
  let list = rows;
  const col = columns.find(c => c.key === sortKey);
  if (col?.sort) { list = [...rows].sort((a, b) => { const x = col.sort(a), y = col.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * (sortDir === 'asc' ? 1 : -1); }); }
  const head = columns.map(c => `<th class="${c.n ? 'n' : ''} ${c.sort ? 'sort' : ''} ${c.key === sortKey ? 'sorted' : ''}" ${c.sort ? `data-sort="${esc(id)}:${esc(c.key)}"` : ''}>${esc(c.label)}${c.key === sortKey ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('');
  const body = list.map((r, i) => `<tr ${rowAttrs(r, i)}>${columns.map(c => `<td class="${c.n ? 'n' : ''} ${c.cls ?? ''}">${c.render(r, i)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="t ${compact ? 'compact' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// --- watchlist (this browser only) ------------------------------------------------------
export const watch = {
  list() { try { return JSON.parse(localStorage.getItem('ps.watch') || '[]'); } catch { return []; } },
  has(key) { return this.list().some(w => w.key.toLowerCase() === String(key).toLowerCase()); },
  toggle(key, label = '') {
    const list = this.list(), i = list.findIndex(w => w.key.toLowerCase() === String(key).toLowerCase());
    if (i >= 0) list.splice(i, 1); else list.push({ key: String(key), label, added: Date.now() });
    try { localStorage.setItem('ps.watch', JSON.stringify(list.slice(-50))); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('watchlist'));
    return i < 0;
  }
};

export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}

export function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
