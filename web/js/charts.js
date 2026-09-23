// ECharts (self-hosted) with the PerplScope theme. Every chart has one value
// axis, thin marks, a recessive grid and a hover tooltip; colours come from
// the validated categorical palette or the long/short pair.
import { usd, compact, dateTime, date, num } from './format.js';

const T = {
  text: 'rgba(224,225,255,0.70)', faint: 'rgba(255,255,255,0.42)', grid: 'rgba(255,255,255,0.05)', axis: 'rgba(255,255,255,0.10)',
  accent: '#a2a4ff', long: '#81c784', short: '#f65a6e', tooltip: '#24222a', border: 'rgba(255,255,255,0.12)', font: 'Geist, ui-sans-serif, system-ui, sans-serif'
};
export const COLORS = T;
const registry = new Set();
const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => { for (const e of entries) e.target.__chart?.resize(); }) : null;

function init(el) {
  if (!el || !window.echarts) return null;
  let chart = el.__chart;
  if (!chart) {
    chart = window.echarts.init(el, null, { renderer: 'canvas' });
    el.__chart = chart; registry.add(chart); observer?.observe(el);
  }
  return chart;
}
// Shows or hides one series (legend chips outside the canvas drive this).
export function toggleSeries(el, name) { el?.__chart?.dispatchAction({ type: 'legendToggleSelect', name }); }
export function disposeAll() { for (const c of registry) { try { observer?.unobserve(c.getDom()); c.dispose(); } catch { /* already gone */ } } registry.clear(); }

const base = () => ({
  animation: true, animationDuration: 300, animationDurationUpdate: 250,
  textStyle: { fontFamily: T.font, color: T.text, fontSize: 11 },
  grid: { left: 8, right: 12, top: 14, bottom: 6, containLabel: true },
  tooltip: {
    trigger: 'axis', backgroundColor: T.tooltip, borderColor: T.border, borderWidth: 1, padding: [8, 10], textStyle: { color: '#fff', fontSize: 12, fontFamily: T.font },
    axisPointer: { type: 'line', lineStyle: { color: 'rgba(162,164,255,0.35)', width: 1 }, shadowStyle: { color: 'rgba(162,164,255,0.06)' } },
    extraCssText: 'box-shadow:0 10px 30px rgba(0,0,0,.5);border-radius:6px;'
  }
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Sub-day buckets show clock time and switch to the date at midnight UTC.
export function timeLabel(v, bucketSeconds) {
  const d = new Date(Number(v) * 1000);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (bucketSeconds >= 86400 || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) return day;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const timeAxis = (times, bucketSeconds) => ({
  type: 'category', data: times, boundaryGap: true,
  axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false },
  axisLabel: { color: T.faint, hideOverlap: true, formatter: v => timeLabel(v, bucketSeconds), margin: 10 }
});
// Axis money: $1.5M, $900K, $0.
export const usdAxis = v => { const n = Number(v); if (!n) return '$0'; const a = Math.abs(n); const [k, u] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, '']; const x = a / k; return `${n < 0 ? '-' : ''}$${x >= 100 || Number.isInteger(x) ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${u}`; };
const valueAxis = fmt => ({ type: 'value', splitNumber: 4, axisLabel: { color: T.faint, formatter: fmt, margin: 10 }, splitLine: { lineStyle: { color: T.grid } }, axisLine: { show: false }, axisTick: { show: false } });
const row = (color, name, value) => `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:7px"></span>${name}</span><b style="font-weight:500;font-variant-numeric:tabular-nums">${value}</b></div>`;
function tooltip(fmt, bucketSeconds, { total = false } = {}) {
  return params => {
    const list = Array.isArray(params) ? params : [params];
    if (!list.length) return '';
    const t = list[0].axisValue;
    const head = `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(t) : dateTime(t) + ' UTC'}</div>`;
    const rows = list.filter(p => p.value !== null && p.value !== undefined && p.value !== 0 && p.value !== '-').sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 10);
    const sum = list.reduce((a, p) => a + (num(p.value) ?? 0), 0);
    return head + rows.map(p => row(p.color, p.seriesName, fmt(p.value))).join('') + (total && list.length > 1 ? `<div style="border-top:1px solid ${T.border};margin-top:4px;padding-top:4px">${row('transparent', 'Total', fmt(sum))}</div>` : '');
  };
}

export function sparkline(el, values, { color = T.accent, area = true } = {}) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    animation: false, grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i) }, yAxis: { type: 'value', show: false, scale: true },
    series: [{ type: 'line', data: values, symbol: 'none', smooth: 0.25, lineStyle: { color, width: 1.5 }, areaStyle: area ? { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: color + '4d' }, { offset: 1, color: color + '05' }]) } : undefined }]
  }, true);
}

// Stacked bars over time (one series per market, colour follows the market).
export function stackedBars(el, { times, series, bucketSeconds, fmt = v => usd(v), yFmt = usdAxis }) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    ...base(), xAxis: timeAxis(times, bucketSeconds), yAxis: valueAxis(yFmt),
    legend: { show: false, data: series.map(s => s.name) },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds, { total: true }) },
    series: series.map((s, i) => ({ name: s.name, type: 'bar', stack: 'a', data: s.data, itemStyle: { color: s.color, borderRadius: i === series.length - 1 ? [2, 2, 0, 0] : 0, borderColor: '#0e0d10', borderWidth: series.length > 1 ? 0.5 : 0 }, barMaxWidth: 22, emphasis: { focus: 'series' } }))
  }, true);
}

export function lineChart(el, { times, series, bucketSeconds, fmt = v => usd(v), yFmt = usdAxis, area = true, scale = false }) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    ...base(), grid: { ...base().grid, right: 22 }, xAxis: { ...timeAxis(times, bucketSeconds), boundaryGap: false }, yAxis: { ...valueAxis(yFmt), scale },
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds) },
    series: series.map(s => ({ name: s.name, type: 'line', data: s.data, symbol: 'none', smooth: 0.2, connectNulls: true, lineStyle: { color: s.color, width: 2 }, itemStyle: { color: s.color }, areaStyle: area && series.length === 1 ? { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: s.color + '4d' }, { offset: 1, color: s.color + '05' }]) } : undefined }))
  }, true);
}

// Positive values green, negative red (net flows, daily PnL).
export function signedBars(el, { times, values, bucketSeconds, name = 'Value', fmt = v => usd(v, { sign: true }), yFmt = usdAxis }) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    ...base(), xAxis: timeAxis(times, bucketSeconds), yAxis: valueAxis(yFmt),
    tooltip: { ...base().tooltip, formatter: tooltip(fmt, bucketSeconds) },
    series: [{ name, type: 'bar', data: values.map(v => ({ value: v, itemStyle: { color: (num(v) ?? 0) >= 0 ? T.long : T.short, borderRadius: (num(v) ?? 0) >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2] } })), barMaxWidth: 18 }]
  }, true);
}

// Candles with volume below (two stacked grids, each with its own single axis).
export function candles(el, { times, ohlc, volume, bucketSeconds, priceFmt, volColor = 'rgba(162,164,255,0.35)' }) {
  const chart = init(el);
  if (!chart) return;
  const x = i => ({ ...timeAxis(times, bucketSeconds), gridIndex: i, axisLabel: i === 0 ? { show: false } : timeAxis(times, bucketSeconds).axisLabel });
  chart.setOption({
    ...base(),
    grid: [{ left: 8, right: 12, top: 12, height: '64%', containLabel: true }, { left: 8, right: 12, top: '78%', bottom: 6, containLabel: true }],
    xAxis: [x(0), x(1)],
    yAxis: [{ ...valueAxis(priceFmt), scale: true, gridIndex: 0 }, { ...valueAxis(usdAxis), gridIndex: 1, splitNumber: 2 }],
    tooltip: { ...base().tooltip, formatter: params => { const c = params.find(p => p.seriesType === 'candlestick'); const v = params.find(p => p.seriesType === 'bar'); const t = params[0]?.axisValue; if (!c) return ''; const [o, cl, lo, hi] = c.value.slice(1); return `<div style="color:${T.faint};margin-bottom:4px">${bucketSeconds >= 86400 ? date(t) : dateTime(t) + ' UTC'}</div>${row('transparent', 'Open', priceFmt(o))}${row('transparent', 'High', priceFmt(hi))}${row('transparent', 'Low', priceFmt(lo))}${row('transparent', 'Close', priceFmt(cl))}${v ? row('transparent', 'Volume', usd(v.value)) : ''}`; } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    series: [
      { type: 'candlestick', data: ohlc, xAxisIndex: 0, yAxisIndex: 0, itemStyle: { color: T.long, color0: T.short, borderColor: T.long, borderColor0: T.short }, barMaxWidth: 10 },
      { type: 'bar', name: 'Volume', data: volume, xAxisIndex: 1, yAxisIndex: 1, itemStyle: { color: volColor }, barMaxWidth: 10 }
    ]
  }, true);
}

// Horizontal bars (categories on y), e.g. per-market breakdowns.
export function hbars(el, { labels, values, colors, fmt = v => usd(v) }) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    ...base(), grid: { left: 8, right: 60, top: 6, bottom: 6, containLabel: true },
    xAxis: { type: 'value', show: false }, yAxis: { type: 'category', data: labels, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: T.text } },
    tooltip: { ...base().tooltip, trigger: 'item', formatter: p => row(p.color, p.name, fmt(p.value)) },
    series: [{ type: 'bar', data: values.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: [0, 2, 2, 0] } })), barMaxWidth: 14, label: { show: true, position: 'right', color: T.text, formatter: p => fmt(p.value), fontSize: 11 } }]
  }, true);
}

// Mirrored bars: long exposure left of zero, short right (liquidation ladder).
export function mirrored(el, { labels, long, short, fmt = v => usd(v) }) {
  const chart = init(el);
  if (!chart) return;
  chart.setOption({
    ...base(), grid: { left: 8, right: 12, top: 26, bottom: 6, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 8, itemHeight: 8, textStyle: { color: T.text }, data: ['Longs liquidated (price down)', 'Shorts liquidated (price up)'] },
    xAxis: { type: 'value', axisLabel: { color: T.faint, formatter: v => usdAxis(Math.abs(v)) }, splitLine: { lineStyle: { color: T.grid } } },
    yAxis: { type: 'category', data: labels, inverse: true, axisTick: { show: false }, axisLine: { lineStyle: { color: T.axis } }, axisLabel: { color: T.text } },
    tooltip: { ...base().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: ps => `<div style="color:${T.faint};margin-bottom:4px">Price moves ${ps[0].axisValue}</div>` + ps.map(p => row(p.color, p.seriesName, fmt(Math.abs(p.value)))).join('') },
    series: [
      { name: 'Longs liquidated (price down)', type: 'bar', stack: 'x', data: long.map(v => -v), itemStyle: { color: T.long, borderRadius: [2, 0, 0, 2] }, barMaxWidth: 14 },
      { name: 'Shorts liquidated (price up)', type: 'bar', stack: 'x', data: short, itemStyle: { color: T.short, borderRadius: [0, 2, 2, 0] }, barMaxWidth: 14 }
    ]
  }, true);
}
