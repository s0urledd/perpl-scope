// PerplScope dashboard. Dependency-free; reads the JSON API served next to it.
const API = 'api/v1';
const $main = document.getElementById('main');
const $snapshot = document.getElementById('snapshot');
const $tooltip = document.getElementById('tooltip');
const NS = 'http://www.w3.org/2000/svg';
const view = { route: null, params: {}, timer: null, inflight: false, sort: 'notional', stressMove: -10, stressResult: null, stressTimer: null };

// --- DOM helpers ----------------------------------------------------------
function h(tag, attrs = {}, ...children) {
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
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(key, value);
  for (const child of children.flat(Infinity)) if (child) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}

// --- formatting -------------------------------------------------------------
const num = value => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const fmt = {
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
function showTooltip(anchor, title, rows) {
  $tooltip.replaceChildren(h('div', { class: 'tt-title' }, title), ...rows.map(r => h('div', { class: 'tt-row' }, h('span', { class: 'k' }, r.color ? h('span', { class: 'swatch line', style: `background:${r.color}` }) : null, r.name), h('span', { class: 'v' }, r.value))));
  $tooltip.hidden = false;
  const rect = $tooltip.getBoundingClientRect();
  let x = anchor.x + 14, y = anchor.y + 14;
  if (x + rect.width > window.innerWidth - 8) x = anchor.x - rect.width - 14;
  if (y + rect.height > window.innerHeight - 8) y = anchor.y - rect.height - 14;
  $tooltip.style.left = `${Math.max(8, x)}px`; $tooltip.style.top = `${Math.max(8, y)}px`;
}
function hideTooltip() { $tooltip.hidden = true; }

// --- charts ---------------------------------------------------------------
function ticks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count, magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(x => x * magnitude).find(x => x >= raw);
  const top = Math.ceil(max / step - 1e-9) * step;
  const out = []; for (let v = 0; v <= top + step * 0.001; v += step) out.push(v); return out;
}
function niceMax(values) { const m = Math.max(0, ...values.filter(v => Number.isFinite(v))); return ticks(m, 4).at(-1) || 1; }
function chartWidth(columns = 1) {
  const main = Math.min(1280, window.innerWidth) - 32;
  const twoColumns = columns === 2 && main >= 320 * 2 + 14;
  return Math.max(320, Math.round((twoColumns ? (main - 14) / 2 : main) - 34));
}
const tone = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colors = () => ({ long: tone('--long') || '#008300', short: tone('--short') || '#e34948', blue: tone('--series-1') || '#2a78d6', accent: tone('--accent') || '#6f5cff' });

function columnChart({ categories, series, formatValue, tooltipRows, height = 240, xTickEvery = 1, marker = null, yLabel = null, width = 720 }) {
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
function lineChart({ series, formatValue, labelOf, rowsOf, height = 220, baseline = true, width = 720, signed = false }) {
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

function sparkline(values) {
  const list = values.map(num).filter(v => v !== null);
  if (list.length < 2) return null;
  const w = 120, hgt = 30, min = Math.min(...list), max = Math.max(...list), span = max - min || 1;
  const x = i => (i / (list.length - 1)) * w, y = v => hgt - 3 - ((v - min) / span) * (hgt - 6);
  const cut = Math.max(0, list.length - Math.ceil(list.length / 6));
  const d = list.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  return s('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, s('path', { d: d.slice(0, cut + 1).join(' ') }), s('path', { class: 'recent', d: d.slice(cut).join(' ').replace(/^L/, 'M') }), s('circle', { cx: x(list.length - 1), cy: y(list.at(-1)), r: 3 }));
}

function legend(series) { return h('div', { class: 'legend' }, series.map(sr => h('span', {}, h('span', { class: 'swatch', style: `background:${sr.color}` }), sr.name))); }
function tableView(summary, headers, rows) {
  return h('details', { class: 'table-view' }, h('summary', {}, summary), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { class: i === 0 ? 'left' : null }, x)))), h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { class: i === 0 ? 'left' : null }, c))))))));
}
function card(title, note, ...body) { return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title), note ? h('p', {}, note) : null), ...body); }
function cardWithActions(title, note, actions, ...body) { return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, title), h('div', { class: 'card-actions' }, actions)), note ? h('p', { class: 'sub', style: 'font-size:12px;color:var(--muted);margin-bottom:8px' }, note) : null, ...body); }
function tile(label, value, note, toneClass, spark) { return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), note ? h('div', { class: `tile-note ${toneClass || ''}` }, note) : null, spark || null); }
function statusPill(ok, textOk, textBad) { return h('span', { class: 'pill' }, h('span', { class: `dot ${ok ? 'dot-fresh' : 'dot-stale'}` }), ok ? textOk : textBad); }
function table(headers, rows, leftCount = 1) { return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { class: i < leftCount ? 'left' : null }, x)))), h('tbody', {}, rows))); }

// --- data -----------------------------------------------------------------
async function getJson(path) {
  const response = await fetch(`${API}${path}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (data.snapshot) updateSnapshot(data.snapshot);
  return { ok: response.ok, status: response.status, data };
}
function updateSnapshot(snap) {
  const dot = $snapshot.querySelector('.dot'), text = $snapshot.querySelector('.snapshot-text');
  dot.className = `dot dot-${snap.status === 'fresh' ? 'fresh' : snap.status === 'stale' ? 'stale' : 'syncing'}`;
  text.textContent = snap.block ? `Block ${fmt.int(snap.block)} · ${snap.status}${snap.status_reason ? ` (${snap.status_reason})` : ''} · ${fmt.ago(snap.age_ms)} ago` : `Collector ${snap.status}`;
  $snapshot.title = snap.block_hash ? `Block hash ${snap.block_hash}${snap.finalized_block ? ` · finalized ${snap.finalized_block}` : ''}` : '';
}
const seriesOf = (points, key) => points.map(p => p[key]);
const agoLabel = (point, block, blockTimeMs) => { const delta = num(block) - num(point.block); if (!blockTimeMs || delta === null) return `#${fmt.int(point.block)}`; const hours = delta * blockTimeMs / 3600000; return hours < 1 ? `${Math.round(hours * 60)} min ago` : `${hours.toFixed(1)} h ago`; };

// --- views ----------------------------------------------------------------
function syncingView(data) {
  return h('div', {}, h('h1', {}, 'Collector is syncing'), h('p', { class: 'sub' }, 'The first pinned-block snapshot is being read from the exchange contract. This page refreshes automatically.'), data?.snapshot?.status_reason ? h('p', { class: 'notice' }, `Reason: ${data.snapshot.status_reason}`) : null);
}

function overviewView(d, series) {
  const t = d.totals, c = colors();
  const active = d.markets.filter(m => num(m.open_interest.total_notional) > 0).sort((a, b) => num(b.open_interest.total_notional) - num(a.open_interest.total_notional));
  const risk = active.map(m => ({ symbol: m.symbol, long: num(m.risk.long_notional_at_10pct), short: num(m.risk.short_notional_at_10pct) }));
  const chart = columnChart({ width: chartWidth(1), categories: risk.map(r => r.symbol), series: [{ name: 'Longs (price −10%)', color: c.long, values: risk.map(r => r.long) }, { name: 'Shorts (price +10%)', color: c.short, values: risk.map(r => r.short) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v) });
  const coverage = num(t.insurance_coverage_at_10pct);
  const points = series?.points ?? [];
  const blockTimeMs = num(d.exchange.block_time_ms);
  const seriesChart = points.length > 1 ? lineChart({ width: chartWidth(1), series: [{ name: 'Open interest', points: points.map(p => ({ y: num(p.notional), p })) }, { name: 'Within 10% of liquidation', color: c.accent, points: points.map(p => ({ y: num(p.at_10pct), p })) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v), labelOf: p => agoLabel(p.p, d.snapshot.block, blockTimeMs), rowsOf: i => [{ color: c.blue, name: 'Open interest', value: fmt.usdFull(points[i].notional) }, { color: c.accent, name: 'Within 10%', value: fmt.usdFull(points[i].at_10pct) }, { name: 'Insurance', value: fmt.usdFull(points[i].insurance) }, { name: 'Positions', value: String(points[i].positions) }, { name: 'Block', value: fmt.int(points[i].block) }] }) : null;
  const liq = t.liquidity;
  return h('div', {},
    h('h1', {}, 'Perpl exchange risk'),
    h('p', { class: 'sub' }, `Chain 143 · contract ${d.exchange.version} · ${fmt.int(d.exchange.accounts)} accounts · ${t.markets} markets`),
    h('div', { class: 'hero' }, h('span', { class: 'hero-value' }, fmt.usd(t.total_notional)), h('span', { class: 'hero-label' }, `open interest at mark across ${fmt.int(t.positions)} open positions`)),
    h('div', { class: 'tiles' },
      tile('Within 5% of liquidation', fmt.usd(t.notional_at_5pct), `${fmt.pct(num(t.notional_at_5pct) / num(t.total_notional) * 100, 1)} of open interest`, null, sparkline(seriesOf(points, 'at_5pct'))),
      tile('Within 10% of liquidation', fmt.usd(t.notional_at_10pct), `${fmt.pct(num(t.notional_at_10pct) / num(t.total_notional) * 100, 1)} of open interest`, null, sparkline(seriesOf(points, 'at_10pct'))),
      tile('Shortfall at a 10% move', fmt.usd(t.shortfall_at_10pct), coverage === null ? 'no bad debt at this shock' : `insurance covers ${fmt.cover(coverage)}`, coverage === null || coverage >= 100 ? 'good' : 'critical'),
      tile('On-chain liquidity cover at 10%', liq && liq.cover_at_10pct_pct !== null ? fmt.cover(liq.cover_at_10pct_pct) : '—', liq ? `${fmt.usd(liq.depth_at_10pct)} resting depth vs ${fmt.usd(liq.demand_at_10pct)} liquidation demand` : 'book not read yet', liq && liq.cover_at_10pct_pct !== null && liq.cover_at_10pct_pct < 100 ? 'critical' : null),
      tile('Insurance funds', fmt.usd(t.insurance_total), `${fmt.pct(num(t.insurance_total) / num(t.total_notional) * 100, 2)} of open interest`, null, sparkline(seriesOf(points, 'insurance'))),
      tile('Liquidatable now', fmt.int(t.liquidatable), t.bankrupt > 0 ? `${t.bankrupt} bankrupt` : 'positions at or below maintenance', t.liquidatable > 0 ? 'critical' : 'good'),
      tile('Liquidations · 24h', fmt.int(t.liquidations_24h), `${fmt.usd(t.liquidated_notional_24h)} notional`),
      tile('Reconciliation', t.all_reconciled ? 'Exact' : 'Mismatch', 'positions vs contract OI counters', t.all_reconciled ? 'good' : 'critical')),
    seriesChart ? h('div', { class: 'grid wide' }, card('Last 24 hours', `Sampled every ${fmt.int(series.every_blocks)} blocks from the collector's own snapshots.`, legend([{ name: 'Open interest', color: c.blue }, { name: 'Within 10% of liquidation', color: c.accent }]), seriesChart, tableView('Show data table', ['Block', 'Open interest', 'Within 10%', 'Shortfall 10%', 'Insurance', 'Positions'], points.slice(-48).reverse().map(p => [fmt.int(p.block), fmt.usdFull(p.notional), fmt.usdFull(p.at_10pct), fmt.usdFull(p.shortfall_10pct), fmt.usdFull(p.insurance), String(p.positions)])))) : null,
    h('div', { class: 'grid wide' }, card('Notional within 10% of liquidation, by market', 'Positions whose liquidation price sits within a 10% adverse move of the current mark.', legend([{ name: 'Longs (price −10%)', color: c.long }, { name: 'Shorts (price +10%)', color: c.short }]), chart, tableView('Show data table', ['Market', 'Longs', 'Shorts'], risk.map(r => [r.symbol, fmt.usdFull(r.long), fmt.usdFull(r.short)])))),
    card('Markets', 'Click a row for the liquidation ladder, map, liquidity, funding and positions.', table(['Market', 'Mark', 'Open interest', 'Positions', 'Avg leverage L / S', 'Within 5%', 'Within 10%', 'Liquidity cover 5%', 'Funding 8h', 'Insurance / MMR', 'Status'],
      d.markets.map(m => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/market/${m.id}`; } },
        h('td', { class: 'left' }, h('strong', {}, m.symbol), ' ', h('span', { class: 'mono', style: 'color:var(--muted)' }, `#${m.id}`)),
        h('td', {}, fmt.price(m.prices.mark, m.price_decimals)),
        h('td', {}, fmt.usd(m.open_interest.total_notional)),
        h('td', {}, `${m.positions.count} `, h('span', { style: 'color:var(--muted)' }, `(${m.positions.long}/${m.positions.short})`)),
        h('td', {}, `${fmt.lev(m.long.average_leverage)} / ${fmt.lev(m.short.average_leverage)}`),
        h('td', {}, fmt.usd(m.risk.notional_at_5pct)),
        h('td', {}, fmt.usd(m.risk.notional_at_10pct)),
        h('td', { class: m.liquidity?.cover_at_5pct?.min_pct !== null && m.liquidity?.cover_at_5pct?.min_pct < 100 ? 'status-bad' : null }, m.liquidity?.cover_at_5pct ? fmt.cover(m.liquidity.cover_at_5pct.min_pct) : '—'),
        h('td', {}, fmt.signedPct(m.funding.rate_8h_pct, 4)),
        h('td', {}, m.insurance.coverage_of_maintenance_pct === null ? '—' : fmt.pct(m.insurance.coverage_of_maintenance_pct, 0)),
        h('td', {}, m.positions.liquidatable > 0 ? h('span', { class: 'pill' }, h('span', { class: 'dot dot-stale' }), `${m.positions.liquidatable} liquidatable`) : m.open_interest.reconciled ? statusPill(true, 'reconciled') : statusPill(false, '', 'mismatch')))))));
}

function liquidityCards(m) {
  const c = colors(), L = m.liquidity;
  if (!L) return [card('On-chain liquidity vs liquidation demand', null, h('div', { class: 'empty' }, 'Order-book depth has not been read yet'))];
  const rows = L.absorption;
  const chartFor = side => columnChart({ width: chartWidth(2), categories: rows.map(r => `${r.shock_pct}%`), series: [{ name: side === 'long' ? 'Long liquidations (sell demand)' : 'Short liquidations (buy demand)', color: side === 'long' ? c.long : c.short, values: rows.map(r => num(r[side].demand)) }, { name: side === 'long' ? 'Resting bid depth' : 'Resting ask depth', color: c.blue, values: rows.map(r => num(r[side].depth)) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v), tooltipRows: i => [{ color: side === 'long' ? c.long : c.short, name: 'Liquidation demand', value: fmt.usdFull(rows[i][side].demand) }, { color: c.blue, name: `Depth (${rows[i][side].levels} levels)`, value: fmt.usdFull(rows[i][side].depth) }, { name: 'Cover', value: fmt.cover(rows[i][side].cover_pct) }] });
  const note = `Book read at block ${fmt.int(L.book_block)} (${fmt.int(L.age_blocks)} blocks ago) · spread ${L.spread_bps === null ? '—' : `${L.spread_bps} bps`} · ${L.levels.bids} bid / ${L.levels.asks} ask levels${L.truncated.bids || L.truncated.asks ? ' · walk truncated at the level limit' : ''}.`;
  const tbl = side => tableView('Show data table', ['Move', 'Demand', 'Depth', 'Levels', 'Cover'], rows.map(r => [`${r.shock_pct}%`, fmt.usdFull(r[side].demand), fmt.usdFull(r[side].depth), String(r[side].levels), fmt.cover(r[side].cover_pct)]));
  return [
    card('Long liquidations vs bid depth', note, legend([{ name: 'Long liquidations (sell demand)', color: c.long }, { name: 'Resting bid depth', color: c.blue }]), chartFor('long'), tbl('long')),
    card('Short liquidations vs ask depth', 'Firm resting orders only; expired volume awaiting clearing is excluded.', legend([{ name: 'Short liquidations (buy demand)', color: c.short }, { name: 'Resting ask depth', color: c.blue }]), chartFor('short'), tbl('short'))];
}

function stressCard(m) {
  const container = h('div', { class: 'stress' });
  const value = h('span', { class: 'stress-value' }, fmt.signedPct(view.stressMove, 1));
  const results = h('div', {});
  const input = h('input', { type: 'range', min: '-30', max: '30', step: '0.5', value: String(view.stressMove), 'aria-label': 'Price move percent', oninput: evt => { view.stressMove = Number(evt.target.value); value.textContent = fmt.signedPct(view.stressMove, 1); clearTimeout(view.stressTimer); view.stressTimer = setTimeout(() => loadStress(m.id, results), 200); } });
  container.append(h('div', { class: 'stress-row' }, h('span', {}, 'Price move'), input, value, h('span', { style: 'color:var(--muted);font-size:12px' }, 'negative liquidates longs, positive liquidates shorts')), results);
  renderStress(results, m, view.stressResult && view.stressResult.market_id === m.id ? view.stressResult : null);
  if (!view.stressResult || view.stressResult.market_id !== m.id) loadStress(m.id, results);
  return card('Stress test', 'What liquidates if the mark moves by the chosen amount before any liquidation executes: notional, bad debt, insurance cover and the on-chain depth that would absorb the flow.', container);
}
async function loadStress(marketId, target) {
  if (view.stressMove === 0) { renderStress(target, { id: marketId }, null); return; }
  const r = await getJson(`/markets/${marketId}/stress?move_pct=${view.stressMove}`);
  if (r.ok) { view.stressResult = r.data; if (view.route === 'market' && Number(view.params.id) === marketId) renderStress(target, { id: marketId, price_decimals: r.data.price_decimals }, r.data); }
}
function renderStress(target, m, r) {
  if (!r) { target.replaceChildren(h('div', { class: 'empty' }, view.stressMove === 0 ? 'Choose a non-zero move' : 'Computing…')); return; }
  const pd = m.price_decimals ?? 2;
  target.replaceChildren(
    h('div', { class: 'stress-tiles' },
      tile(`Price after ${fmt.signedPct(r.move_pct, 1)}`, fmt.price(r.price, pd), `from ${fmt.price(r.mark, pd)}`),
      tile(`${r.side === 'long' ? 'Longs' : 'Shorts'} liquidated`, fmt.usd(r.liquidated.notional), `${r.liquidated.count} positions · ${fmt.pct(r.liquidated.share_of_oi_pct, 1)} of open interest`),
      tile('Bad debt if gapped', fmt.usd(r.shortfall), r.insurance_coverage_pct === null ? 'no position past bankruptcy' : `insurance covers ${fmt.cover(r.insurance_coverage_pct)}`, r.insurance_coverage_pct === null || r.insurance_coverage_pct >= 100 ? 'good' : 'critical'),
      tile('On-chain depth in range', r.liquidity ? fmt.usd(r.liquidity.depth) : '—', r.liquidity ? `${r.liquidity.levels} levels · covers ${fmt.cover(r.liquidity.absorption_pct)} of the flow` : 'book not read', r.liquidity && r.liquidity.absorption_pct !== null && r.liquidity.absorption_pct < 100 ? 'critical' : null)),
    r.positions_hit.length ? h('div', { style: 'margin-top:10px' }, h('h3', {}, 'Largest positions hit'), table(['Account', 'Side', 'Size', 'Notional', 'Entry', 'Liq. price', 'Leverage'], r.positions_hit.slice(0, 10).map(p => h('tr', {}, h('td', { class: 'left mono' }, h('a', { href: `#/account/${p.account_id}` }, `#${p.account_id}`)), h('td', { class: 'left' }, h('span', { class: `side-${p.side}` }, p.side)), h('td', {}, fmt.size(p.size)), h('td', {}, fmt.usd(p.notional)), h('td', {}, fmt.price(p.entry_price, pd)), h('td', {}, fmt.price(p.liquidation_price, pd)), h('td', {}, fmt.lev(p.leverage)))), 2)) : null);
}

function adlCard(m) {
  const q = m.adl_queue;
  const rows = list => list.length ? table(['#', 'Account', 'Return on deposit', 'PnL', 'Notional', 'Leverage'], list.map(p => h('tr', {}, h('td', { class: 'left' }, String(p.rank)), h('td', { class: 'left mono' }, h('a', { href: `#/account/${p.account_id}` }, `#${p.account_id}`)), h('td', {}, fmt.pct(p.roe_pct, 1)), h('td', { class: 'status-ok' }, fmt.usd(p.pnl)), h('td', {}, fmt.usd(p.notional)), h('td', {}, fmt.lev(p.leverage)))), 2) : h('div', { class: 'empty' }, 'No profitable positions on this side');
  return card('Auto-deleveraging queue', q.method, h('div', { class: 'grid', style: 'margin-bottom:0' }, h('div', {}, h('h3', {}, 'Longs deleveraged first if shorts go bankrupt'), rows(q.long)), h('div', {}, h('h3', {}, 'Shorts deleveraged first if longs go bankrupt'), rows(q.short))));
}

function marketView(m, markets, series) {
  const c = colors();
  const nav = h('div', { class: 'market-nav' }, markets.map(x => h('a', { href: `#/market/${x.id}`, class: [x.id === m.id ? 'active' : '', num(x.open_interest.total_notional) > 0 ? '' : 'inactive'].join(' ').trim() || null, title: num(x.open_interest.total_notional) > 0 ? null : 'No open positions' }, x.symbol)));
  const blockTimeMs = num(m.snapshot_block_time_ms);
  const hoursAgo = eventBlock => { const delta = num(m.snapshot_block) - num(eventBlock); return blockTimeMs && delta !== null ? delta * blockTimeMs / 3600000 : null; };
  const ladder = m.ladder;
  const ladderChart = columnChart({ width: chartWidth(2), categories: ladder.map(r => `${r.shock_pct}%`), series: [{ name: 'Longs liquidated (price falls)', color: c.long, values: ladder.map(r => num(r.long.notional)) }, { name: 'Shorts liquidated (price rises)', color: c.short, values: ladder.map(r => num(r.short.notional)) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v), tooltipRows: i => { const r = ladder[i]; return [{ color: c.long, name: `Longs · ${r.long.count} at ${fmt.price(r.long.price, m.price_decimals)}`, value: fmt.usdFull(r.long.notional) }, { color: c.short, name: `Shorts · ${r.short.count} at ${fmt.price(r.short.price, m.price_decimals)}`, value: fmt.usdFull(r.short.notional) }, { name: 'Shortfall if gapped', value: fmt.usdFull(r.total_shortfall) }, { name: 'Insurance coverage', value: r.insurance_coverage_pct === null ? 'n/a' : fmt.cover(r.insurance_coverage_pct) }]; } });
  const allBins = fillBins(m.liquidation_map);
  const bins = m.liquidation_map.bins;
  const zeroIndex = allBins.findIndex(b => b.from_pct >= 0);
  const mapChart = columnChart({ width: chartWidth(2), categories: allBins.map(b => `${b.from_pct}%`), series: [{ name: 'Long liquidation levels', color: c.long, values: allBins.map(b => num(b.long_notional)) }, { name: 'Short liquidation levels', color: c.short, values: allBins.map(b => num(b.short_notional)) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v), xTickEvery: 10, marker: zeroIndex, tooltipRows: i => { const b = allBins[i]; const mark = num(m.prices.mark); return [{ name: 'Price range', value: `${fmt.price(mark * (1 + b.from_pct / 100), m.price_decimals)} – ${fmt.price(mark * (1 + b.to_pct / 100), m.price_decimals)}` }, { color: c.long, name: 'Longs', value: fmt.usdFull(b.long_notional) }, { color: c.short, name: 'Shorts', value: fmt.usdFull(b.short_notional) }, { name: 'Positions', value: String(b.count) }]; } });
  const health = m.health;
  const healthChart = columnChart({ width: chartWidth(2), yLabel: 'notional by health (%)', categories: health.map(b => b.to_pct === null ? `>${b.from_pct}` : b.from_pct === 0 ? `<${b.to_pct}` : `${b.from_pct}–${b.to_pct}`), series: [{ name: 'Notional', color: c.blue, values: health.map(b => num(b.notional)) }], formatValue: (v, axis) => axis ? fmt.usd(v, 0) : fmt.usdFull(v), tooltipRows: i => [{ name: 'Notional', value: fmt.usdFull(health[i].notional) }, { name: 'Positions', value: String(health[i].count) }] });
  const funding = m.funding_history;
  const intervalSec = num(m.funding.interval_seconds);
  const fundingChart = lineChart({ width: chartWidth(2), signed: true, series: [{ name: 'Rate', points: funding.map(f => ({ y: num(f.rate_pct), f })) }], formatValue: (v, axis) => axis ? `${v.toFixed(3)}%` : fmt.signedPct(v, 4), labelOf: p => { const ago = hoursAgo(p.f.funding_event_block); return ago === null ? `#${fmt.int(p.f.funding_event_block)}` : ago < 1 ? `${Math.round(ago * 60)} min ago` : `${ago.toFixed(1)} h ago`; }, rowsOf: i => { const f = funding[i]; return [{ name: 'Event block', value: fmt.int(f.funding_event_block) }, { name: 'Rate per interval', value: fmt.signedPct(f.rate_pct, 4) }, { name: '8h equivalent', value: intervalSec ? fmt.signedPct(num(f.rate_pct) * (28800 / intervalSec), 4) : '—' }, { name: 'Funding price', value: fmt.price(f.funding_price, m.price_decimals) }, { name: 'Payment per unit', value: f.payment_per_unit }, { name: 'Funding sum', value: f.funding_sum }]; } });
  const positions = m.top_positions;
  const ref = m.reference;
  const refText = ref && ref.found ? `Perpl API: mark Δ ${ref.markDeltaBps === null ? '—' : `${ref.markDeltaBps} bps`} · OI Δ ${ref.oiDeltaBps === null ? '—' : `${ref.oiDeltaBps} bps`} · margins ${ref.marginFractionsMatch ? 'match' : 'differ'} · funding ${ref.fundingRateMatch === null ? '—' : ref.fundingRateMatch ? 'match' : 'differ'}` : ref === null ? 'Perpl API cross-check disabled' : 'Market not listed by the Perpl API';
  const next = m.funding.next_announced;
  const points = series?.points ?? [];
  const L = m.liquidity;
  return h('div', {},
    nav,
    h('h1', {}, `${m.symbol} · ${m.name}`),
    h('p', { class: 'sub' }, `Mark ${fmt.price(m.prices.mark, m.price_decimals)} · oracle ${fmt.price(m.prices.oracle, m.price_decimals)} (basis ${fmt.signedPct(m.prices.basis_pct, 2)}) · max leverage ${fmt.lev(m.margin.max_leverage)} · maintenance ${fmt.pct(m.margin.maintenance_margin_pct, 2)} · ${m.active ? 'active' : `status ${m.status}`}${m.prices.mark_stale ? ' · mark price stale' : ''}${L ? ` · best bid ${fmt.price(L.best_bid, m.price_decimals)} / ask ${fmt.price(L.best_ask, m.price_decimals)}` : ''}`),
    h('div', { class: 'tiles' },
      tile('Open interest', fmt.usd(m.open_interest.total_notional), `${fmt.size(m.open_interest.long_size)} ${m.symbol} each side · ${m.open_interest.utilisation_pct === null ? '' : `${fmt.pct(m.open_interest.utilisation_pct, 1)} of cap`}`, null, sparkline(seriesOf(points, 'notional'))),
      tile('Positions', `${m.positions.count}`, `${m.positions.long} long · ${m.positions.short} short`),
      tile('Within 10% of liquidation', fmt.usd(m.risk.notional_at_10pct), `${fmt.usd(m.risk.long_notional_at_10pct)} longs · ${fmt.usd(m.risk.short_notional_at_10pct)} shorts`, null, sparkline(seriesOf(points, 'at_10pct'))),
      tile('Shortfall at 10%', fmt.usd(m.risk.shortfall_at_10pct), m.risk.insurance_coverage_at_10pct === null ? 'none beyond bankruptcy' : `insurance covers ${fmt.cover(m.risk.insurance_coverage_at_10pct)}`, m.risk.insurance_coverage_at_10pct === null || m.risk.insurance_coverage_at_10pct >= 100 ? 'good' : 'critical'),
      tile('Liquidity cover at 5%', L && L.cover_at_5pct ? fmt.cover(L.cover_at_5pct.min_pct) : '—', L && L.cover_at_5pct ? `longs ${fmt.cover(L.cover_at_5pct.long_pct)} · shorts ${fmt.cover(L.cover_at_5pct.short_pct)} of liquidation flow absorbed by resting orders` : 'book not read yet', L && L.cover_at_5pct && L.cover_at_5pct.min_pct !== null && L.cover_at_5pct.min_pct < 100 ? 'critical' : null),
      tile('Insurance fund', fmt.usd(m.insurance.balance), `${fmt.pct(m.insurance.coverage_of_maintenance_pct, 0)} of maintenance margin`, null, sparkline(seriesOf(points, 'insurance'))),
      tile('Funding (8h eq.)', fmt.signedPct(m.funding.rate_8h_pct, 4), `${m.funding.direction} · next in ${fmt.duration(m.funding.seconds_to_next)}${next ? ` at ${fmt.signedPct(next.rate_pct, 4)} (set on-chain)` : ''} · ${fmt.signedPct(m.funding.rate_annualized_pct, 1)} annualised`),
      tile('Liquidatable now', `${m.positions.liquidatable}`, m.positions.bankrupt ? `${m.positions.bankrupt} bankrupt` : 'at or below maintenance', m.positions.liquidatable ? 'critical' : 'good'),
      tile('Top position', fmt.pct(m.concentration.top1_pct, 1), `of open interest · top 5 ${fmt.pct(m.concentration.top5_pct, 1)} · HHI ${fmt.int(m.concentration.hhi)}`)),
    h('div', { class: 'grid wide' }, stressCard(m)),
    h('div', { class: 'grid' },
      card('Liquidation ladder', 'Cumulative notional liquidated as the mark moves against each side; shortfall is the equity below zero if the move gaps past bankruptcy.', legend([{ name: 'Longs (price falls)', color: c.long }, { name: 'Shorts (price rises)', color: c.short }]), ladderChart, tableView('Show data table', ['Move', 'Long price', 'Longs', 'Short price', 'Shorts', 'Shortfall', 'Coverage'], ladder.map(r => [`${r.shock_pct}%`, fmt.price(r.long.price, m.price_decimals), `${fmt.usdFull(r.long.notional)} (${r.long.count})`, fmt.price(r.short.price, m.price_decimals), `${fmt.usdFull(r.short.notional)} (${r.short.count})`, fmt.usdFull(r.total_shortfall), r.insurance_coverage_pct === null ? '—' : fmt.cover(r.insurance_coverage_pct)]))),
      card('Liquidation map', `Liquidation prices binned every ${m.liquidation_map.bin_pct}% around the mark. Beyond ±${m.liquidation_map.range_pct}%: ${m.liquidation_map.tails.below.count} longs (${fmt.usd(m.liquidation_map.tails.below.notional)}), ${m.liquidation_map.tails.above.count} shorts (${fmt.usd(m.liquidation_map.tails.above.notional)}).`, legend([{ name: 'Long liquidation levels', color: c.long }, { name: 'Short liquidation levels', color: c.short }]), mapChart, tableView('Show data table', ['From', 'To', 'Longs', 'Shorts', 'Positions'], bins.map(b => [`${b.from_pct}%`, `${b.to_pct}%`, fmt.usdFull(b.long_notional), fmt.usdFull(b.short_notional), String(b.count)])))),
    h('div', { class: 'grid' }, ...liquidityCards(m)),
    h('div', { class: 'grid' },
      card('Funding rate history', `Rate applied per funding interval (${fmt.duration(intervalSec)}), from FundingEventCompleted events. Positive means longs pay shorts.`, funding.length ? fundingChart : h('div', { class: 'empty' }, 'No funding events collected yet'), tableView('Show data table', ['Event block', 'Rate', 'Funding price', 'Payment per unit', 'Funding sum'], funding.slice().reverse().map(f => [fmt.int(f.funding_event_block), fmt.signedPct(f.rate_pct, 4), fmt.price(f.funding_price, m.price_decimals), f.payment_per_unit, f.funding_sum]))),
      card('Position health', 'Equity as a share of maintenance margin. Below 100% is liquidatable.', healthChart, tableView('Show data table', ['Health', 'Positions', 'Notional'], health.map(b => [b.to_pct === null ? `> ${b.from_pct}%` : `${b.from_pct}–${b.to_pct}%`, String(b.count), fmt.usdFull(b.notional)])))),
    h('div', { class: 'grid wide' }, adlCard(m)),
    h('div', { class: 'grid wide' },
      cardWithActions('Positions', refText, [h('a', { href: `${API}/markets/${m.id}/positions?format=csv&sort=${view.sort}&limit=1000`, download: '' }, 'Download CSV')], h('div', { class: 'controls' }, h('label', { for: 'sort' }, 'Sort by'), h('select', { id: 'sort', onchange: evt => { view.sort = evt.target.value; refresh(); } }, ['notional', 'risk', 'pnl', 'size'].map(x => h('option', { value: x, selected: view.sort === x ? 'selected' : null }, { notional: 'Notional', risk: 'Closest to liquidation', pnl: 'Unrealised PnL', size: 'Size' }[x]))), h('span', {}, `showing ${positions.length} of ${m.positions.count}`)),
        table(['Account', 'Side', 'Size', 'Notional', 'Entry', 'Liq. price', 'Distance', 'Leverage', 'Health', 'PnL'], positions.map(p => h('tr', {}, h('td', { class: 'left mono' }, h('a', { href: `#/account/${p.account_id}` }, `#${p.account_id}`)), h('td', { class: 'left' }, h('span', { class: `side-${p.side}` }, p.side)), h('td', {}, fmt.size(p.size)), h('td', {}, fmt.usd(p.notional)), h('td', {}, fmt.price(p.entry_price, m.price_decimals)), h('td', {}, num(p.liquidation_price) > 0 ? fmt.price(p.liquidation_price, m.price_decimals) : '—'), h('td', { class: p.status !== 'healthy' ? 'status-bad' : num(p.liquidation_distance_pct) < 5 ? 'status-warn' : null }, p.status !== 'healthy' ? p.status : fmt.pct(p.liquidation_distance_pct, 1)), h('td', {}, fmt.lev(p.leverage)), h('td', {}, fmt.pct(p.health_pct, 0)), h('td', { class: num(p.pnl) < 0 ? 'status-bad' : 'status-ok' }, fmt.usd(p.pnl)))), 2)),
      card('Recent liquidations', m.recent_liquidations.length ? 'From PositionLiquidated events collected since the collector started.' : null, m.recent_liquidations.length ? liquidationTable(m.recent_liquidations, false) : h('div', { class: 'empty' }, 'No liquidations in the collected range'))));
}
function fillBins(map) {
  const step = num(map.bin_pct), range = num(map.range_pct), byFrom = new Map(map.bins.map(b => [Number(b.from_pct).toFixed(2), b]));
  const out = [];
  for (let from = -range; from < range - 1e-9; from += step) { const key = from.toFixed(2); out.push(byFrom.get(key) ?? { from_pct: Number(key), to_pct: Number((from + step).toFixed(2)), count: 0, long_notional: '0', short_notional: '0' }); }
  return out;
}
function liquidationTable(rows, withMarket = true) {
  return table([...(withMarket ? ['Market'] : []), 'Block', 'Account', 'Side', 'Size', 'Notional', 'Exit price', 'Mark', 'Type', 'Tx'],
    rows.map(l => h('tr', {}, withMarket ? h('td', { class: 'left' }, h('strong', {}, l.symbol ?? `#${l.market_id}`)) : null, h('td', { class: 'left mono' }, fmt.int(l.block)), h('td', { class: 'left mono' }, h('a', { href: `#/account/${l.account_id}` }, `#${l.account_id}`)), h('td', { class: 'left' }, h('span', { class: `side-${l.side}` }, l.side)), h('td', {}, fmt.size(l.liquidated_size)), h('td', {}, fmt.usd(l.liquidated_notional)), h('td', {}, fmt.price(l.exit_price)), h('td', {}, fmt.price(l.mark_price)), h('td', {}, l.full ? 'full' : 'partial'), h('td', {}, h('a', { href: `https://monadscan.com/tx/${l.tx}`, target: '_blank', rel: 'noopener', class: 'mono' }, fmt.short(l.tx))))), withMarket ? 4 : 3);
}
function liquidationsView(d) {
  return h('div', {}, h('h1', {}, 'Liquidations'), h('p', { class: 'sub' }, `${d.total} PositionLiquidated events in the collected window, newest first. Deleveraging events: ${d.deleverages.length}.`),
    d.liquidations.length ? cardWithActions('Recent liquidations', null, [h('a', { href: `${API}/liquidations?format=csv&limit=1000`, download: '' }, 'Download CSV')], liquidationTable(d.liquidations)) : card('Recent liquidations', null, h('div', { class: 'empty' }, 'No liquidations collected yet. The collector backfills a bounded block range at start and records every liquidation from then on.')));
}
function accountView(a) {
  const closest = a.closest_liquidation;
  return h('div', {}, h('h1', {}, `Account #${a.account.id}`), h('p', { class: 'sub' }, h('a', { href: `https://monadscan.com/address/${a.account.address}`, target: '_blank', rel: 'noopener', class: 'mono' }, a.account.address), ` · read at block ${fmt.int(a.read_block)}`),
    h('div', { class: 'tiles' }, tile('Free balance', fmt.usd(a.account.balance), `${fmt.usd(a.account.locked_balance)} locked in orders`), tile('Open positions', String(a.totals.positions), `${fmt.usd(a.totals.notional)} notional`), tile('Position equity', fmt.usd(a.totals.equity), `${fmt.usd(a.totals.deposit)} deposited`), tile('Unrealised PnL', fmt.usd(a.totals.pnl), null, num(a.totals.pnl) < 0 ? 'critical' : 'good'), tile('Closest liquidation', closest ? fmt.pct(closest.distance_pct, 1) : '—', closest ? `${closest.symbol} ${closest.side} at ${fmt.price(closest.liquidation_price)}` : 'no open positions', closest && closest.distance_pct < 5 ? 'critical' : null)),
    card('Positions', 'Liquidation prices use the current maintenance fraction and the contract\'s premium PnL.', a.positions.length ? table(['Market', 'Side', 'Size', 'Notional', 'Entry', 'Mark', 'Liq. price', 'Distance', 'Leverage', 'Health', 'PnL'], a.positions.map(p => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/market/${p.market_id}`; } }, h('td', { class: 'left' }, h('strong', {}, p.symbol)), h('td', { class: 'left' }, h('span', { class: `side-${p.side}` }, p.side)), h('td', {}, fmt.size(p.size)), h('td', {}, fmt.usd(p.notional)), h('td', {}, fmt.price(p.entry_price)), h('td', {}, fmt.price(p.mark)), h('td', {}, num(p.liquidation_price) > 0 ? fmt.price(p.liquidation_price) : '—'), h('td', { class: p.status !== 'healthy' ? 'status-bad' : num(p.liquidation_distance_pct) < 5 ? 'status-warn' : null }, p.status !== 'healthy' ? p.status : fmt.pct(p.liquidation_distance_pct, 1)), h('td', {}, fmt.lev(p.leverage)), h('td', {}, fmt.pct(p.health_pct, 0)), h('td', { class: num(p.pnl) < 0 ? 'status-bad' : 'status-ok' }, fmt.usd(p.pnl)))), 2) : h('div', { class: 'empty' }, 'No open positions')));
}
function validationView(v, r) {
  const ver = v.verification;
  const items = Object.entries(v.metrics);
  return h('div', {}, h('h1', {}, 'Validation'), h('p', { class: 'sub' }, 'What the collector checks continuously, and how each metric was validated against the contract.'),
    h('div', { class: 'grid' },
      card('Snapshot', null, h('dl', { class: 'kv' }, h('dt', {}, 'Block'), h('dd', {}, fmt.int(v.snapshot.block)), h('dt', {}, 'Hash'), h('dd', { class: 'mono' }, fmt.short(v.snapshot.block_hash)), h('dt', {}, 'Finalized'), h('dd', {}, fmt.int(v.snapshot.finalized_block)), h('dt', {}, 'Status'), h('dd', {}, v.snapshot.status), h('dt', {}, 'Bootstrap'), h('dd', {}, v.bootstrap ? `block ${fmt.int(v.bootstrap.block)} (${v.bootstrap.reason})` : '—'), h('dt', {}, 'Polls'), h('dd', {}, fmt.int(v.collector.polls)), h('dt', {}, 'RPC requests'), h('dd', {}, fmt.int(v.rpc.requests)), h('dt', {}, 'Errors'), h('dd', {}, fmt.int(v.collector.errors)))),
      card('Open-interest reconciliation', 'Every poll: stored positions summed per side must equal the contract counters at the same block.', v.reconciliation ? h('div', {}, statusPill(v.reconciliation.ok, `exact at block ${fmt.int(v.reconciliation.block)}`, `mismatch at block ${fmt.int(v.reconciliation.block)}`), h('p', { class: 'tile-note' }, `${v.reconciliation.markets} markets checked · ${fmt.ago(Date.now() - v.reconciliation.at)} ago`)) : h('div', { class: 'empty' }, 'Not yet run')),
      card('Independent discovery', 'Periodic rescan of every account through position bitmaps, compared with the stored positions.', ver ? h('div', {}, ver.ok === null ? h('span', { class: 'pill' }, `error: ${ver.error}`) : statusPill(ver.ok, `agrees at block ${fmt.int(ver.block)}`, `mismatch at block ${fmt.int(ver.block)}`), h('p', { class: 'tile-note' }, ver.ok === null ? '' : `${fmt.int(ver.accounts)} accounts · ${ver.candidates} candidates · ${ver.scanned} positions · ${ver.requests} requests · ${fmt.ago(ver.ms)}`)) : h('div', { class: 'empty' }, 'Scheduled after bootstrap')),
      card('PnL agreement', 'Delta PnL recomputed from entry, size and mark, compared with the contract for every position read since start.', table(['Market', 'Checked', 'Agree'], v.pnl_agreement.map(x => h('tr', {}, h('td', { class: 'left' }, x.symbol), h('td', {}, x.checked), h('td', { class: x.agree === x.checked ? 'status-ok' : 'status-bad' }, x.agree)))))),
    h('div', { class: 'grid wide' },
      card('Cross-check against the Perpl API', 'Reference only. The public context endpoint is compared with the contract state; it never feeds a metric.', r.enabled ? table(['Market', 'Mark Δ (bps)', 'OI Δ (bps)', 'Margins', 'Funding rate', 'Funding sum', 'Reference block'], r.markets.map(x => { const c = x.comparison; return h('tr', {}, h('td', { class: 'left' }, x.symbol), ...(c && c.found ? [h('td', {}, c.markDeltaBps ?? '—'), h('td', {}, c.oiDeltaBps ?? '—'), h('td', { class: c.marginFractionsMatch ? 'status-ok' : 'status-bad' }, c.marginFractionsMatch ? 'match' : 'differ'), h('td', { class: c.fundingRateMatch === false ? 'status-bad' : 'status-ok' }, c.fundingRateMatch === null ? '—' : c.fundingRateMatch ? 'match' : 'differ'), h('td', { class: c.fundingSumMatch === false ? 'status-bad' : 'status-ok' }, c.fundingSumMatch === null ? '—' : c.fundingSumMatch ? 'match' : 'differ'), h('td', {}, fmt.int(c.referenceBlock))] : [h('td', { colspan: 6, style: 'text-align:left;color:var(--muted)' }, 'not listed by the API')])); })) : h('div', { class: 'empty' }, 'Cross-check disabled')),
      card('Metric status', null, table(['Metric', 'Status', 'Method'], items.map(([name, x]) => h('tr', {}, h('td', { class: 'left' }, name.replace(/_/g, ' ')), h('td', { class: 'left' }, h('span', { class: 'pill' }, x.status)), h('td', { class: 'left', style: 'white-space:normal;min-width:320px' }, x.method))), 3))));
}
function aboutView() {
  return h('div', { class: 'prose' }, h('h1', {}, 'About PerplScope'),
    h('p', {}, 'PerplScope is an independent risk monitor for the Perpl perpetual exchange on Monad. It reads the exchange contract directly, pins every read to one block, and recomputes open interest, unrealised PnL, liquidation prices, liquidation exposure, on-chain liquidity, funding and insurance coverage from that state. Nothing is taken on trust from the venue.'),
    h('h2', {}, 'How the numbers are produced'),
    h('ul', {}, h('li', {}, 'Positions come from the contract\'s paged getter at a pinned block, then every block\'s exchange events name the positions to re-read. Positions are never derived from events.'), h('li', {}, 'Each poll sums the stored positions per side and compares them with the contract\'s own open-interest counters at the same block. Any difference forces a fresh snapshot.'), h('li', {}, 'Periodically every account is rescanned through its position bitmaps, an enumeration path independent of the paged getter.'), h('li', {}, 'Resting order-book depth is walked level by level from the contract at the same block, so liquidation demand can be compared with the liquidity that would absorb it.'), h('li', {}, 'Delta PnL is recomputed and compared with the contract for every position read.')),
    h('h2', {}, 'Formulas'),
    h('p', {}, 'From the Perpl documentation and the open-source SDK. Maintenance margin requirement ', h('code', {}, 'MMR = entry × size ÷ maintenance fraction'), '. Liquidation price ', h('code', {}, 'P = entry + side × (MMR − deposit − premium PnL) ÷ size'), '. Bankruptcy price ', h('code', {}, 'P = entry − side × (deposit + premium PnL) ÷ size'), '. Equity ', h('code', {}, 'FMV = deposit + delta PnL + premium PnL'), '; a position is liquidatable when ', h('code', {}, '0 < FMV ≤ MMR'), '.'),
    h('p', {}, 'The liquidation ladder counts positions whose liquidation price lies within each adverse move of the mark. Shortfall is the equity below zero that would remain if the move gapped past bankruptcy before a liquidation executed; insurance coverage divides the market\'s insurance balance by that shortfall. Liquidity cover divides the firm resting depth within the same move by the liquidation notional that would have to trade through it.'),
    h('h2', {}, 'Limits'),
    h('ul', {}, h('li', {}, 'Isolated-margin positions only, as deployed. Depth walks are bounded per side and note when truncated.'), h('li', {}, 'The liquidation price uses the current maintenance fraction and the contract\'s current premium PnL; funding accrued between funding events is not projected.'), h('li', {}, 'Liquidation history covers the collector\'s backfill window and everything since; the 24 h series starts when the collector starts.')),
    h('p', {}, h('a', { href: 'https://github.com/s0urledd/perpl-scope' }, 'Source, methodology and validation evidence on GitHub'), '.'));
}

// --- routing & refresh --------------------------------------------------------
function parseRoute() {
  const hash = location.hash || '#/';
  const market = hash.match(/^#\/market\/(\d+)/);
  if (market) return { route: 'market', params: { id: market[1] } };
  const account = hash.match(/^#\/account\/([0-9a-zA-Zx]{1,42})/);
  if (account) return { route: 'account', params: { key: account[1] } };
  if (hash.startsWith('#/liquidations')) return { route: 'liquidations', params: {} };
  if (hash.startsWith('#/validation')) return { route: 'validation', params: {} };
  if (hash.startsWith('#/about')) return { route: 'about', params: {} };
  return { route: 'overview', params: {} };
}
function render(node) { const y = window.scrollY; $main.replaceChildren(node); $main.classList.remove('refreshing'); window.scrollTo(0, y); }
async function refresh() {
  if (view.inflight) return; view.inflight = true;
  if ($main.childElementCount) $main.classList.add('refreshing');
  try {
    const { route, params } = view;
    if (route === 'about') { render(aboutView()); return; }
    if (route === 'overview') { const [r, series] = await Promise.all([getJson('/overview'), getJson('/series?hours=24')]); render(r.ok ? overviewView(r.data, series.ok ? series.data : null) : syncingView(r.data)); }
    else if (route === 'market') {
      const [detail, list, series] = await Promise.all([getJson(`/markets/${params.id}?limit=25`), getJson('/markets'), getJson(`/series?market=${params.id}&hours=24`)]);
      if (!detail.ok) return render(detail.status === 404 ? h('div', {}, h('h1', {}, 'Unknown market')) : syncingView(detail.data));
      let positions = detail.data.market.top_positions;
      if (view.sort !== 'notional') { const p = await getJson(`/markets/${params.id}/positions?sort=${view.sort}&limit=25`); if (p.ok) positions = p.data.positions; }
      render(marketView({ ...detail.data.market, top_positions: positions, snapshot_block: detail.data.snapshot.block, snapshot_block_time_ms: detail.data.snapshot.block_time_ms }, list.ok ? list.data.markets : [detail.data.market], series.ok ? series.data : null));
    }
    else if (route === 'account') { const r = await getJson(`/accounts/${encodeURIComponent(params.key)}`); render(r.ok ? accountView(r.data) : r.status === 404 ? h('div', {}, h('h1', {}, 'No account found'), h('p', { class: 'sub' }, 'This address has not created a Perpl account, or the ID does not exist.')) : r.status === 400 ? h('div', {}, h('h1', {}, 'Invalid account key'), h('p', { class: 'sub' }, 'Enter a numeric account ID or a 0x address.')) : syncingView(r.data)); }
    else if (route === 'liquidations') { const r = await getJson('/liquidations?limit=200'); render(r.ok ? liquidationsView(r.data) : syncingView(r.data)); }
    else if (route === 'validation') { const [v, r] = await Promise.all([getJson('/validation'), getJson('/reference')]); render(v.ok ? validationView(v.data, r.ok ? r.data : { enabled: false }) : syncingView(v.data)); }
  } catch (error) { render(h('div', {}, h('h1', {}, 'Unable to reach the API'), h('p', { class: 'sub' }, error.message))); }
  finally { view.inflight = false; $main.classList.remove('refreshing'); }
}
function navigate() {
  const next = parseRoute();
  if (next.route !== view.route || JSON.stringify(next.params) !== JSON.stringify(view.params)) { $main.replaceChildren(); view.sort = 'notional'; view.stressResult = null; }
  Object.assign(view, next);
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.route === view.route));
  clearInterval(view.timer);
  refresh();
  view.timer = setInterval(refresh, view.route === 'overview' || view.route === 'market' ? 5000 : 10000);
}
window.addEventListener('hashchange', navigate);
document.getElementById('search').addEventListener('submit', evt => { evt.preventDefault(); const key = document.getElementById('search-input').value.trim(); if (key) location.hash = `#/account/${key}`; });
document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('perplscope-theme', root.dataset.theme); } catch {}
  refresh();
});
try { const saved = localStorage.getItem('perplscope-theme'); if (saved) document.documentElement.dataset.theme = saved; } catch {}
navigate();
