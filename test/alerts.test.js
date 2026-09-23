import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts, parseUsd, usd, fmtPrice } from '../src/alerts.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const NOW = 1_800_000_000;

// A fake Telegram: records sent messages and serves queued updates.
function harness({ positions = [] } = {}) {
  const sent = [], updates = [];
  let saved = null;
  const fetch = async (url, init) => {
    const method = url.split('/').pop(), body = JSON.parse(init.body);
    if (method === 'sendMessage') { sent.push(body); return { json: async () => ({ ok: true, result: {} }) }; }
    if (method === 'getUpdates') return { json: async () => ({ ok: true, result: updates.splice(0) }) };
    return { json: async () => ({ ok: true, result: { username: 'plumb_test_bot' } }) };
  };
  const alerts = createAlerts({
    token: 'T', fetch, sendGapMs: 0, now: () => NOW * 1000,
    store: { load: async () => saved, save: async v => { saved = structuredClone(v); } },
    resolveAccount: async key => (key === ADDR || key === '7' ? { id: 7, address: ADDR } : null),
    tradeViews: async rows => rows.map(r => ({ ...r, symbol: r.market === 1 ? 'BTC' : 'SOL', address: r.account === 7 ? ADDR : null })),
    accountState: async () => ({ positions }),
    symbolOf: id => ({ 1: 'BTC', 2: 'SOL', 30: 'SOL_v2' }[id] ?? `#${id}`), marketIds: () => [1, 2, 30]
  });
  const msg = (text, chat = 42) => updates.push({ update_id: updates.length + 100, message: { text, chat: { id: chat, type: 'private' } } });
  const flush = () => new Promise(r => setTimeout(r, 100));
  return { alerts, sent, msg, flush, saved: () => saved, setPositions: p => { positions.splice(0, positions.length, ...p); } };
}
const trade = over => ({ kind: 'open', role: 'taker', account: 3, market: 1, side: 'long', buy: true, size: '0.5', price: '84000', notional: '42000', pnl: '0', tx: '0xabc', ...over });

test('amount parsing and formatting', () => {
  assert.equal(parseUsd('50k'), 50000);
  assert.equal(parseUsd('$1.5m'), 1500000);
  assert.equal(parseUsd('25,000'), 25000);
  assert.equal(parseUsd('abc'), null);
  assert.equal(usd(27319.55), '$27.3K');
  assert.equal(usd(-12.5, { sign: true }), '-$12.50');
  assert.equal(fmtPrice('84566.2123'), '84,566.2');
  assert.equal(fmtPrice('0.0244671'), '0.024467');
});

test('commands subscribe, list and persist; unknown input is answered', async () => {
  const h = harness();
  h.msg(`/watch ${ADDR}`); h.msg('/liqs 25k BTC'); h.msg('/trades 500'); h.msg('/funding'); h.msg('/list'); h.msg('/watch 0xdead');
  await h.alerts.pollOnce(); await h.flush();
  const texts = h.sent.map(m => m.text);
  assert.match(texts[0], /Watching/);
  assert.match(texts[1], /\$25\.0K or more on BTC/);
  assert.match(texts[2], /minimum/);
  assert.match(texts[4], /wallet .*\n• liquidations ≥ \$25\.0K on BTC\n• funding flips/);
  assert.match(texts[5], /No Perpl account/);
  assert.deepEqual(Object.keys(h.saved().subs['42'].wallets), ['7']);
  assert.equal(h.saved().offset, 106);
});

test('deep link /start watch_<address> subscribes; a market name picks the newest listing', async () => {
  const h = harness();
  assert.match(await h.alerts.handle('9', `/start watch_${ADDR}`), /Watching/);
  assert.match(await h.alerts.handle('9', '/liqs 10k sol'), /on SOL_v2/);
  assert.match(await h.alerts.handle('9', '/liqs 10k DOGE'), /Unknown market/);
});

test('events reach the right chats, grouped per commit', async () => {
  const h = harness();
  await h.alerts.handle('1', '/watch 7');
  await h.alerts.handle('2', '/liqs 20k');
  await h.alerts.handle('3', '/trades 40k BTC');
  await h.alerts.onCommit({ ts: NOW, ev: [
    trade({ account: 7, kind: 'close', role: 'maker', notional: '900', pnl: '12.5' }),
    trade({ kind: 'liquidation', notional: '27000' }),
    trade({ kind: 'liquidation', notional: '5000' }),
    trade({ notional: '42000' }),
    trade({ market: 2, notional: '99000' })
  ], funding: [] });
  await h.flush();
  const to = chat => h.sent.filter(m => m.chat_id === chat).map(m => m.text);
  assert.equal(to('1').length, 1);
  assert.match(to('1')[0], /closed BTC long 0\.5 @ 84,000 \(\$900\) · PnL \+\$12\.50/);
  assert.equal(to('2').length, 1);
  assert.match(to('2')[0], /Liquidation.*\$27\.0K/);
  assert.equal(to('3').length, 1);
  assert.match(to('3')[0], /Large buy/);
});

test('old events after downtime are not sent', async () => {
  const h = harness();
  await h.alerts.handle('1', '/trades 1k');
  await h.alerts.onCommit({ ts: NOW - 3600, ev: [trade({})], funding: [] });
  await h.flush();
  assert.equal(h.sent.length, 0);
});

test('funding flips are reported once per change of direction', async () => {
  const h = harness();
  await h.alerts.handle('1', '/funding on');
  const f = rate => ({ ts: NOW, ev: [], funding: [{ market: 2, actual_rate: rate }] });
  for (const r of [45, 0, 30, -20, -10, 5]) await h.alerts.onCommit(f(r));
  await h.flush();
  const texts = h.sent.map(m => m.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /SOL: shorts now pay longs \(-0\.0200%/);
  assert.match(texts[1], /longs now pay shorts/);
});

test('near-liquidation warnings fire once per level and re-arm after recovery', async () => {
  const pos = d => ({ market: 1, symbol: 'BTC', side: 'long', notional: '478', mark: '84419.3', liquidation_price: '82252.46', liquidation_distance_pct: d });
  const h = harness();
  await h.alerts.handle('1', '/watch 7');
  for (const d of [12, 9, 8, 4.5, 4, 16, 9]) { h.setPositions([pos(d)]); await h.alerts.checkRisk(); }
  await h.flush();
  const texts = h.sent.map(m => m.text);
  assert.equal(texts.length, 3);
  assert.match(texts[0], /Near liquidation.*BTC long \$478: mark 84,419\.3, liquidation at 82,252\.5 \(9\.0% away\)/);
  assert.match(texts[1], /4\.5% away/);
  assert.match(texts[2], /9\.0% away/);
});

test('a blocked chat is dropped', async () => {
  let saved = null;
  const alerts = createAlerts({
    token: 'T', sendGapMs: 0, now: () => NOW * 1000,
    fetch: async () => ({ json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) }),
    store: { load: async () => null, save: async v => { saved = v; } },
    resolveAccount: async () => ({ id: 7, address: ADDR }), tradeViews: async rows => rows.map(r => ({ ...r, symbol: 'BTC', address: ADDR })), accountState: async () => ({ positions: [] })
  });
  await alerts.handle('5', '/watch 7');
  await alerts.onCommit({ ts: NOW, ev: [trade({ account: 7 })], funding: [] });
  await new Promise(r => setTimeout(r, 10));
  await alerts.save();
  assert.deepEqual(saved.subs, {});
});
