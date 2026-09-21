// PerplScope dashboard. Dependency-free; reads the JSON API served next to it.
export const API = 'api/v1';
export const $main = document.getElementById('main');
export const $snapshot = document.getElementById('snapshot');
export const $tooltip = document.getElementById('tooltip');
export const NS = 'http://www.w3.org/2000/svg';
export const view = { route: null, params: {}, timer: null, inflight: false, sort: 'notional', stressMove: -10, stressResult: null, stressTimer: null };

// --- DOM helpers ----------------------------------------------------------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(key, value);
  for (const child of children.flat(Infinity)) if (child) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}

// --- formatting -------------------------------------------------------------
export const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
export const fmt = {
  usd(value, digits = 2) {
    const n = num(value); if (n === null) return '—';
    const a = Math.abs(n), sign = n < 0 ? '−' : '';
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`;
    return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  },
  usdFull(value) { const n = num(value); return n === null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; },
  pct(value, digits = 2) { const n = num(value); return n === null ? '—' : `${n.toFixed(digits)}%`; },
  signedPct(value, digits = 3) { const n = num(value); return n === null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}%`; },
  int(value) { const n = num(value); return n === null ? '—' : n.toLocaleString('en-US'); },
  lev(value) { const n = num(value); return n === null ? '—' : `${n.toFixed(n >= 10 ? 0 : 1)}×`; },
  price(value, decimals = 2) { const n = num(value); if (n === null) return '—'; const d = Math.min(Math.max(decimals, n < 1 ? 6 : 2), 8); return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); },
  size(value) { const n = num(value); return n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6 }); },
  ago(ms) { const n = num(ms); if (n === null) return '—'; if (n < 1000) return `${Math.round(n)} ms`; if (n < 60000) return `${(n / 1000).toFixed(1)} s`; if (n < 3600000) return `${Math.round(n / 60000)} min`; return `${(n / 3600000).toFixed(1)} h`; },
  short(hash) { return hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : '—'; },
  duration(seconds) { const n = num(seconds); if (n === null) return '—'; if (n < 90) return `${Math.round(n)} s`; if (n < 5400) return `${Math.round(n / 60)} min`; return `${(n / 3600).toFixed(1)} h`; },
  cover(value) { const n = num(value); if (n === null) return '—'; return n >= 1000 ? `${(n / 100).toFixed(1)}×` : `${n.toFixed(0)}%`; }
};

// --- tooltip ---------------------------------------------------------------
export function showTooltip(anchor, title, rows) {
  $tooltip.replaceChildren(h('div', { class: 'tt-title' }, title), ...rows.map(r => h('div', { class: 'tt-row' }, h('span', { class: 'k' }, r.color ? h('span', { class: 'swatch line', style: `background:${r.color}` }) : null, r.name), h('span', { class: 'v' }, r.value))));
  $tooltip.hidden = false;
  const rect = $tooltip.getBoundingClientRect();
  let x = anchor.x + 14, y = anchor.y + 14;
  if (x + rect.width > window.innerWidth - 8) x = anchor.x - rect.width - 14;
  if (y + rect.height > window.innerHeight - 8) y = anchor.y - rect.height - 14;
  $tooltip.style.left = `${Math.max(8, x)}px`; $tooltip.style.top = `${Math.max(8, y)}px`;
}
export function hideTooltip() { $tooltip.hidden = true; }

// --- charts ---------------------------------------------------------------
export function ticks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count, magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(x => x * magnitude).find(x => x >= raw);
  const top = Math.ceil(max / step - 1e-9) * step;
  const out = []; for (let v = 0; v <= top + step * 0.001; v += step) out.push(v); return out;
}
export function niceMax(values) { const m = Math.max(0, ...values.filter(v => Number.isFinite(v))); return ticks(m, 4).at(-1) || 1; }
export function chartWidth(columns = 1) {
  const main = Math.min(1280, window.innerWidth) - 32;
  const twoColumns = columns === 2 && main >= 320 * 2 + 14;
  return Math.max(320, Math.round((twoColumns ? (main - 14) / 2 : main) - 34));
}
export const tone = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const colors = () => ({ long: tone('--long') || '#008300', short: tone('--short') || '#e34948', blue: tone('--series-1') || '#2a78d6', accent: tone('--accent') || '#6f5cff' });

export function columnChart({ categories, series, formatValue, tooltipRows, height = 240, xTickEvery = 1, marker = null, yLabel = null, width = 720 }) {
  const padL = 56, padR = 12, padT = 16, padB = 34;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const max = niceMax(series.flatMap(x => x.values));
  const yTicks = ticks(max, 4);
  const y = v => padT + plotH - (v / max) * plotH;
  const band = plotW / Math.max(1, categories.length);
  const needed = Math.ceil(46 / band);
  if (needed > xTickEvery) xTickEvery = xTickEvery > 1 ? Math.ceil(needed / xTickEvery) * xTickEvery : needed;
  const gap = 2, barW = Math.max(2, Math.min(24, (band - gap * (series.length + 1)) / series.length));
  const groupW = barW * series.length + gap * (series.length - 1);
  const svgEl = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Column chart' });
  for (const t of yTicks) { svgEl.append(s('line', { class: t === 0 ? 'baseline' : 'gridline', x1: padL, x2: width - padR, y1: y(t), y2: y(t) })); svgEl.append(s('text', { x: padL - 8, y: y(t) + 4, 'text-anchor': 'end' }, formatValue(t, true))); }
  if (yLabel) svgEl.append(s('text', { x: padL, y: 10, 'text-anchor': 'start' }, yLabel));
  categories.forEach((category, i) => {
    const x0 = padL + i * band + (band - groupW) / 2;
    if (i % xTickEvery === 0) svgEl.append(s('text', { x: padL + i * band + band / 2, y: height - padB + 18, 'text-anchor': 'middle' }, category));
    const bars = [];
    series.forEach((sr, k) => {
      const v = sr.values[i] || 0, top = y(v), bottom = y(0), hgt = Math.max(0, bottom - top);
      const bx = x0 + k * (barW + gap), r = Math.min(4, hgt);
      const d = hgt > 0 ? `M${bx},${bottom} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + barW - r} Q${bx + barW},${top} ${bx + barW},${top + r} V${bottom} Z` : '';
      const bar = s('path', { class: 'bar', d, fill: sr.color }); bars.push(bar); svgEl.append(bar);
    });
    const hit = s('rect', { class: 'hit', x: padL + i * band, y: padT, width: band, height: plotH, tabindex: 0, role: 'button', 'aria-label': `${category}: ${series.map(sr => `${sr.name} ${formatValue(sr.values[i] || 0)}`).join(', ')}` });
    const rows = () => tooltipRows ? tooltipRows(i) : series.map(sr => ({ color: sr.color, name: sr.name, value: formatValue(sr.values[i] || 0) }));
    const on = evt => { bars.forEach(b => b.classList.add('hover')); const rect = hit.getBoundingClientRect(); showTooltip(evt?.clientX ? { x: evt.clientX, y: evt.clientY } : { x: rect.left + rect.width / 2, y: rect.top }, category, rows()); };
    const off = () => { bars.forEach(b => b.classList.remove('hover')); hideTooltip(); };
    hit.addEventListener('pointermove', on); hit.addEventListener('pointerleave', off); hit.addEventListener('focus', on); hit.addEventListener('blur', off);
    svgEl.append(hit);
  });
  if (marker !== null) { const mx = padL + marker * band; svgEl.append(s('line', { class: 'marker-line', x1: mx, x2: mx, y1: padT, y2: padT + plotH })); svgEl.append(s('text', { x: mx + 4, y: padT + 10 }, 'mark')); }
  return svgEl;
}

// Line chart with one or two series sharing an x index; crosshair reads every series.
export function lineChart({ series, formatValue, labelOf, rowsOf, height = 220, baseline = true, width = 720, signed = false }) {
  const padL = 60, padR = 16, padT = 14, padB = 30;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const count = Math.max(...series.map(sr => sr.points.length));
  const values = series.flatMap(sr => sr.points.map(p => p.y));
  const maxAbs = Math.max(...values.map(Math.abs), 1e-9);
  const top = niceMax([maxAbs]), min = signed && Math.min(0, ...values) < 0 ? -top : 0, max = top;
  const y = v => padT + plotH - ((v - min) / (max - min)) * plotH;
  const x = i => padL + (count > 1 ? (i / (count - 1)) * plotW : plotW / 2);
  const svgEl = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Line chart' });
  const yTicks = min < 0 ? [min, min / 2, 0, max / 2, max] : ticks(max, 4);
  for (const t of yTicks) { svgEl.append(s('line', { class: t === 0 && baseline ? 'baseline' : 'gridline', x1: padL, x2: width - padR, y1: y(t), y2: y(t) })); svgEl.append(s('text', { x: padL - 8, y: y(t) + 4, 'text-anchor': 'end' }, formatValue(t, true))); }
  if (!count) return svgEl;
  series.forEach((sr, k) => {
    const path = sr.points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.y)}`).join(' ');
    if (k === 0) svgEl.append(s('path', { class: 'area', d: `${path} L${x(sr.points.length - 1)},${y(0)} L${x(0)},${y(0)} Z` }));
    svgEl.append(s('path', { class: `line${k ? ' secondary' : ''}`, d: path, style: sr.color ? `stroke:${sr.color}` : null }));
    const last = sr.points.at(-1);
    svgEl.append(s('circle', { class: `dot${k ? ' secondary' : ''}`, cx: x(sr.points.length - 1), cy: y(last.y), r: 4, style: sr.color ? `fill:${sr.color}` : null }));
    svgEl.append(s('text', { class: 'label', x: x(sr.points.length - 1) - 8, y: y(last.y) + (k ? 18 : -10), 'text-anchor': 'end' }, formatValue(last.y)));
  });
  const first = series[0].points;
  const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotW / 110))));
  let lastLabelX = -Infinity;
  first.forEach((p, i) => { const isLast = i === count - 1; if (i % every === 0 || isLast) { if (isLast && x(i) - lastLabelX < 70) return; svgEl.append(s('text', { x: x(i), y: height - padB + 18, 'text-anchor': isLast ? 'end' : i === 0 ? 'start' : 'middle' }, labelOf(p, i))); lastLabelX = x(i); } });
  const crosshair = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: padT, y2: padT + plotH, visibility: 'hidden' });
  const dots = series.map((sr, k) => s('circle', { class: `dot${k ? ' secondary' : ''}`, r: 5, visibility: 'hidden', style: sr.color ? `fill:${sr.color}` : null }));
  svgEl.append(crosshair, ...dots);
  const hit = s('rect', { class: 'hit', x: padL, y: padT, width: plotW, height: plotH, tabindex: 0, role: 'button', 'aria-label': 'Time series' });
  const at = i => { crosshair.setAttribute('x1', x(i)); crosshair.setAttribute('x2', x(i)); crosshair.setAttribute('visibility', 'visible'); series.forEach((sr, k) => { const p = sr.points[i]; if (!p) return; dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(p.y)); dots[k].setAttribute('visibility', 'visible'); }); return i; };
  const show = (i, anchor) => { at(i); showTooltip(anchor, labelOf(first[i], i), rowsOf(i)); };
  hit.addEventListener('pointermove', evt => { const rect = hit.getBoundingClientRect(); const rel = (evt.clientX - rect.left) / rect.width; show(Math.max(0, Math.min(count - 1, Math.round(rel * (count - 1)))), { x: evt.clientX, y: evt.clientY }); });
  hit.addEventListener('focus', () => { const rect = hit.getBoundingClientRect(); show(count - 1, { x: rect.right - 40, y: rect.top }); });
  const off = () => { crosshair.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); hideTooltip(); };
  hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off);
  svgEl.append(hit);
  return svgEl;
}

export function sparkline(values) {
  const list = values.map(num).filter(v => v !== null);
  if (list.length < 2) return null;
  const w = 120, hgt = 30, min = Math.min(...list), max = Math.max(...list), span = max - min || 1;
  const x = i => (i / (list.length - 1)) * w, y = v => hgt - 3 - ((v - min) / span) * (hgt - 6);
  const cut = Math.max(0, list.length - Math.ceil(list.length / 6));
  const d = list.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  return s('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, s('path', { d: d.slice(0, cut + 1).join(' ') }), s('path', { class: 'recent', d: d.slice(cut).join(' ').replace(/^L/, 'M') }), s('circle', { cx: x(list.length - 1), cy: y(list.at(-1)), r: 3 }));
}

export function legend(series) { return h('div', { class: 'legend' }, series.map(sr => h('span', {}, h('span', { class: 'swatch', style: `background:${sr.color}` }), sr.name))); }
export function tableView(summary, headers, rows) {
  return h('details', { class: 'table-view' }, h('summary', {}, summary), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { class: i === 0 ? 'left' : null }, x)))), h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { class: i === 0 ? 'left' : null }, c))))))));
}
export function card(title, note, ...body) { return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title), note ? h('p', {}, note) : null), ...body); }
export function cardWithActions(title, note, actions, ...body) { return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title), h('div', { class: 'card-actions' }, actions)), note ? h('p', { class: 'sub', style: 'font-size:12px;color:var(--muted);margin-bottom:8px' }, note) : null, ...body); }
export function tile(label, value, note, toneClass, spark) { return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), note ? h('div', { class: `tile-note ${toneClass || ''}` }, note) : null, spark || null); }
export function statusPill(ok, textOk, textBad) { return h('span', { class: 'pill' }, h('span', { class: `dot ${ok ? 'dot-fresh' : 'dot-stale'}` }), ok ? textOk : textBad); }
export function table(headers, rows, leftCount = 1) { return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { class: i < leftCount ? 'left' : null }, x)))), h('tbody', {}, rows))); }

// --- data -----------------------------------------------------------------
export async function getJson(path) {
  const response = await fetch(`${API}${path}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (data.snapshot) updateSnapshot(data.snapshot);
  return { ok: response.ok, status: response.status, data };
}
export function updateSnapshot(snap) {
  const dot = $snapshot.querySelector('.dot'), text = $snapshot.querySelector('.snapshot-text');
  dot.className = `dot dot-${snap.status === 'fresh' ? 'fresh' : snap.status === 'stale' ? 'stale' : 'syncing'}`;
  text.textContent = snap.block ? `Block ${fmt.int(snap.block)} · ${snap.status}${snap.status_reason ? ` (${snap.status_reason})` : ''} · ${fmt.ago(snap.age_ms)} ago` : `Collector ${snap.status}`;
  $snapshot.title = snap.block_hash ? `Block hash ${snap.block_hash}${snap.finalized_block ? ` · finalized ${snap.finalized_block}` : ''}` : '';
}
export const seriesOf = (points, key) => points.map(p => p[key]);
export const agoLabel = (point, block, blockTimeMs) => { const delta = num(block) - num(point.block); if (!blockTimeMs || delta === null) return `#${fmt.int(point.block)}`; const hours = delta * blockTimeMs / 3600000; return hours < 1 ? `${Math.round(hours * 60)} min ago` : `${hours.toFixed(1)} h ago`; };

// --- views ----------------------------------------------------------------

// --- shared app state, controls and helpers added for the analytics views ------
export const app = { refresh: () => {} };
export const WINDOWS = ['1h', '24h', '7d', '30d', 'all'];
export const windowLabel = w => ({ '1h': '1h', '24h': '24h', '7d': '7d', '30d': '30d', all: 'All' }[w] ?? w);
export function segmented(options, value, onChange, label = 'Timeframe') {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label }, options.map(o => h('button', { type: 'button', class: (o.value ?? o) === value ? 'active' : null, 'aria-pressed': (o.value ?? o) === value ? 'true' : 'false', onclick: () => onChange(o.value ?? o) }, o.label ?? windowLabel(o))));
}
// Two-tone bar: long share on the left in the long colour, the rest in the short colour.
export function skewBar(longPct, title) {
  const p = longPct === null || longPct === undefined ? null : num(longPct);
  if (p === null) return h('span', { class: 'muted' }, '—');
  return h('span', { class: 'skew', title: title ?? `${p.toFixed(1)}% long` }, h('span', { class: 'skew-long', style: `width:${Math.max(0, Math.min(100, p)).toFixed(1)}%` }), h('span', { class: 'skew-short' }));
}
// A cell with a proportional background bar behind the value.
export function shareCell(value, pct, extraClass = null) {
  const p = Math.max(0, Math.min(100, num(pct) ?? 0));
  return h('td', { class: ['share', extraClass].filter(Boolean).join(' '), style: `--share:${p.toFixed(1)}%` }, h('span', {}, value));
}
export function timeLabel(ts, window) {
  const n = num(ts); if (n === null) return '—';
  const d = new Date(n * 1000);
  if (window === '1h' || window === '24h') return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (window === '7d') return d.toLocaleDateString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export const dateTime = ts => { const n = num(ts); return n === null ? '—' : new Date(n * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
export const since = ts => { const n = num(ts); if (n === null) return '—'; const s = Date.now() / 1000 - n; if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`; return `${(s / 86400).toFixed(1)} d ago`; };
const SUMS = ['volume', 'trades', 'fees', 'taker_buy', 'taker_sell', 'new_accounts', 'deposits', 'withdrawals', 'net_flow', 'liquidations', 'liquidated_notional', 'realized_pnl'];
const LASTS = ['open_interest', 'long_open_interest', 'short_open_interest', 'tvl', 'insurance', 'accounts', 'mark', 'funding_rate_pct', 'cumulative_volume'];
// Groups hourly buckets into wider bins (sums for flows, last value for levels, peak for active traders).
export function binPoints(points, binSeconds) {
  if (!binSeconds || binSeconds <= 0) return points;
  const bins = new Map();
  for (const p of points) {
    const key = Math.floor(num(p.ts) / binSeconds) * binSeconds;
    let b = bins.get(key);
    if (!b) { b = { ts: key, block: p.block, complete: true, active_traders: 0 }; for (const k of SUMS) b[k] = 0; for (const k of LASTS) b[k] = null; bins.set(key, b); }
    for (const k of SUMS) b[k] += num(p[k]) ?? 0;
    for (const k of LASTS) if (p[k] !== null && p[k] !== undefined) b[k] = num(p[k]);
    b.active_traders = Math.max(b.active_traders, num(p.active_traders) ?? 0);
    b.complete = b.complete && p.complete !== false; b.to_block = p.to_block;
  }
  return [...bins.values()].sort((a, b) => a.ts - b.ts);
}
export const binFor = (window, bucketSeconds) => window === '30d' || window === 'all' ? 86400 : window === '7d' ? 6 * 3600 : bucketSeconds;
// Watchlist: wallet keys the viewer chose to follow, stored only in this browser.
const WATCH_KEY = 'perplscope-watchlist';
export function getWatchlist() { try { const v = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 12) : []; } catch { return []; } }
export function setWatchlist(list) { try { localStorage.setItem(WATCH_KEY, JSON.stringify(list.slice(0, 12))); } catch {} document.dispatchEvent(new CustomEvent('watchlist')); }
export const isWatched = key => getWatchlist().some(k => k.toLowerCase() === String(key).toLowerCase());
export function toggleWatch(key) { const list = getWatchlist(); const i = list.findIndex(k => k.toLowerCase() === String(key).toLowerCase()); if (i >= 0) list.splice(i, 1); else list.push(String(key)); setWatchlist(list); return i < 0; }
export function watchButton(key, label = null) {
  const btn = h('button', { type: 'button', class: 'ghost star' });
  const paint = () => { const on = isWatched(key); btn.textContent = on ? '★ Watching' : '☆ Watch'; btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); if (label) btn.title = on ? `Remove ${label} from your watchlist` : `Add ${label} to your watchlist`; };
  btn.addEventListener('click', evt => { evt.stopPropagation(); toggleWatch(key); paint(); });
  paint();
  return btn;
}
export const accountLink = (id, text = null) => h('a', { href: `#/account/${id}`, class: 'mono' }, text ?? `#${id}`);
export const txLink = tx => h('a', { href: `https://monadscan.com/tx/${tx}`, target: '_blank', rel: 'noopener', class: 'mono' }, fmt.short(tx));
export const pnlClass = value => { const n = num(value); return n === null || n === 0 ? null : n < 0 ? 'status-bad' : 'status-ok'; };
export const signedUsd = value => { const n = num(value); return n === null ? '—' : `${n > 0 ? '+' : ''}${fmt.usd(n)}`; };
export function coverageNote(cov, window) {
  if (!cov) return null;
  const parts = [];
  if (cov.exact) parts.push('exact sum of chain events'); else if (cov.partial) parts.push('partial: the index does not cover this whole window yet'); else parts.push('hourly aggregates');
  if (cov.covered_from_ts) parts.push(`index covers since ${dateTime(cov.covered_from_ts)}`);
  if (cov.backfill && cov.backfill.running) parts.push('backfill running');
  else if (cov.backfill && cov.backfill.done && cov.backfill.complete === false) parts.push('stopped at the RPC history horizon');
  return h('p', { class: `coverage ${cov.partial ? 'warn' : ''}` }, `${windowLabel(window)} · ${parts.join(' · ')}`);
}

// Table that shows the first `visible` rows with a button to reveal the rest.
export function expandableTable(headers, rows, leftCount = 1, visible = 25) {
  if (rows.length <= visible) return table(headers, rows, leftCount);
  const wrap = h('div', {});
  let shown = visible;
  const paint = () => wrap.replaceChildren(table(headers, rows.slice(0, shown), leftCount), shown < rows.length ? h('button', { type: 'button', class: 'ghost more', onclick: () => { shown = rows.length; paint(); } }, `Show all ${rows.length} rows`) : null);
  paint();
  return wrap;
}
