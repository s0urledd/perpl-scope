import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts, parseUsd, usd, fmtPrice } from '../src/alerts.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const NOW = 1_800_000_000;
const text = r => (typeof r === 'string' ? r : r.text);
const buttons = r => (r.keyboard ?? []).flat().map(b => b.callback_data ?? b.url);

// A fake Telegram: records sent and edited messages and serves queued updates.
function harness({ positions = [] } = {}) {
  const sent = [], edited = [], answered = [], updates = [];
  let saved = null;
  const fetch = async (url, init) => {
    const method = url.split('/').pop(), body = JSON.parse(init.body);
    const ok = result => ({ json: async () => ({ ok: true, result }) });
    if (method === 'sendMessage') { sent.push(body); return ok({}); }
    if (method === 'editMessageText') { edited.push(body); return ok({}); }
    if (method === 'answerCallbackQuery') { answered.push(body); return ok(true); }
    if (method === 'getUpdates') return ok(updates.splice(0));
    return ok({ username: 'plumb_test_bot' });
  };
  const alerts = createAlerts({
    token: 'T', fetch, sendGapMs: 0, now: () => NOW * 1000,
    store: { load: async () => saved, save: async v => { saved = structuredClone(v); } },
    resolveAccount: async key => (key === ADDR || key === '7' ? { id: 7, address: ADDR } : null),
    tradeViews: async rows => rows.map(r => ({ ...r, symbol: r.market === 1 ? 'BTC' : 'SOL', address: r.account === 7 ? ADDR : null })),
    accountState: async () => ({ portfolio: { account_value: '361.2', unrealized_pnl: '-1.17' }, positions }),
    symbolOf: id => ({ 1: 'BTC', 2: 'SOL', 30: 'SOL_v2' }[id] ?? `#${id}`), marketIds: () => [1, 2, 30]
  });
  let n = 100;
  const msg = (t, chat = 42) => updates.push({ update_id: n++, message: { text: t, chat: { id: chat, type: 'private' } } });
  const tap = (data, chat = 42) => updates.push({ update_id: n++, callback_query: { id: `q${n}`, data, message: { message_id: 5, chat: { id: chat, type: 'private' } } } });
  const flush = () => new Promise(r => setTimeout(r, 100));
  return { alerts, sent, edited, answered, msg, tap, flush, saved: () => saved, setPositions: p => { positions.splice(0, positions.length, ...p); } };
}
const trade = over => ({ kind: 'open', role: 'taker', account: 3, market: 1, side: 'long', buy: true, size: '0.5', price: '84000', notional: '42000', pnl: '0', tx: '0xabc', ...over });
const pos = d => ({ market: 1, symbol: 'BTC', side: 'long', notional: '478', leverage: 15, pnl: '-1.17', mark: '84419.3', liquidation_price: '82252.46', liquidation_distance_pct: d });

test('amount parsing and formatting', () => {
  assert.equal(parseUsd('50k'), 50000);
  assert.equal(parseUsd('$1.5m'), 1500000);
  assert.equal(parseUsd('25,000'), 25000);
  assert.equal(parseUsd('abc'), null);
  assert.deepEqual([1000, 1500, 25000, 27319.55, 1.25e6].map(v => usd(v)), ['$1K', '$1.5K', '$25K', '$27.3K', '$1.25M']);
  assert.equal(usd(-12.5, { sign: true }), '-$12.50');
  assert.equal(fmtPrice('84566.2123'), '84,566.2');
  assert.equal(fmtPrice('0.0244671'), '0.024467');
});

test('the menu shows each alert state and the buttons to change it', async () => {
  const h = harness();
  const m = await h.alerts.handle('1', '/start');
  assert.match(text(m), /Plumb · Perpl alerts/);
  assert.match(text(m), /▫️ <b>Liquidations<\/b> {2}off/);
  assert.deepEqual(buttons(m).slice(0, 6), ['watch', 'pos', 'list', 'levels', 'liqs', 'trades']);
  await h.alerts.handle('1', '/liqs 25k BTC');
  assert.match(text(await h.alerts.handle('1', '/menu')), /✅ <b>Liquidations<\/b> {2}\$25K and up on BTC/);
});

test('commands and a bare address subscribe; state persists', async () => {
  const h = harness();
  h.msg(ADDR); h.msg('/trades 500'); h.msg('/funding'); h.msg('/watch 0xdead'); h.msg('/list');
  await h.alerts.pollOnce(); await h.flush();
  const texts = h.sent.map(m => m.text);
  assert.match(texts[0], /Watching/);
  assert.match(texts[1], /minimum/);
  assert.match(texts[2], /✅ <b>Funding flips<\/b> {2}on/);
  assert.match(texts[3], /No Perpl account/);
  assert.match(texts[4], /Watched wallets[\s\S]*0x1111…1111/);
  assert.deepEqual(Object.keys(h.saved().subs['42'].wallets), ['7']);
  assert.equal(h.saved().offset, 105);
});

test('buttons edit the menu in place: pickers, the watch prompt, unwatch, levels', async () => {
  const h = harness();
  h.tap('liqs'); h.tap('liqs:50000'); h.tap('watch'); h.msg('7'); h.tap('unwatch:7'); h.tap('levels:early'); h.tap('trades:off');
  await h.alerts.pollOnce(); await h.flush();
  assert.match(h.edited[0].text, /Get every liquidation/);
  assert.deepEqual(h.edited[0].reply_markup.inline_keyboard[0].map(b => b.callback_data), ['liqs:1000', 'liqs:10000', 'liqs:50000', 'liqs:100000']);
  assert.match(h.edited[1].text, /\$50K and up/);
  assert.match(h.edited[2].text, /Send a 0x address/);
  assert.match(h.sent[0].text, /Watching/); // the text after the prompt
  assert.doesNotMatch(h.edited[3].text, /0x1111/);
  assert.match(h.edited[4].text, /Liquidations<\/b> {2}\$50K/);
  assert.equal(h.saved().subs['42'].levels, 'early');
  assert.ok(h.answered.some(a => a.text === 'Early · 20% 10% 5%'));
});

test('deep link /start watch_<address> subscribes; a market name picks the newest listing', async () => {
  const h = harness();
  assert.match(text(await h.alerts.handle('9', `/start watch_${ADDR}`)), /Watching/);
  assert.match(text(await h.alerts.handle('9', '/liqs 10k sol')), /on SOL_v2/);
  assert.match(text(await h.alerts.handle('9', '/liqs 10k DOGE')), /Unknown market/);
});

test('positions screen: live state, closest to liquidation first', async () => {
  const h = harness({ positions: [{ ...pos(40), symbol: 'SOL', market: 2 }, pos(2.5)] });
  assert.match(text(await h.alerts.handle('1', '/positions')), /Watch a wallet first/);
  await h.alerts.handle('1', '/watch 7');
  const s = text(await h.alerts.handle('1', '/positions'));
  assert.match(s, /value <b>\$361<\/b> · uPnL <b>-\$1.17<\/b>/);
  assert.match(s, /🔴 <b>BTC LONG<\/b> \$478 · 15.0x · PnL -\$1.17\n {5}liq 82,252.5 · <b>2.5% away<\/b>\n🟢 <b>SOL LONG/);
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
  assert.match(to('1')[0], /⚪ <b>Closed BTC LONG<\/b> · .*0x1111…1111.*\n<b>\$900<\/b> · 0\.5 BTC @ 84,000 · PnL <b>\+\$12\.50<\/b>\n.*tx ↗/);
  assert.equal(to('2').length, 1);
  assert.match(to('2')[0], /💥 <b>Liquidation · BTC LONG<\/b>\n<b>\$27K<\/b>/);
  assert.equal(to('3').length, 1);
  assert.match(to('3')[0], /🐋 <b>Large buy · BTC<\/b>\n<b>\$42K<\/b>/);
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
  assert.match(texts[0], /Funding flipped · SOL<\/b>\nShorts now pay longs · -0\.0200%/);
  assert.match(texts[1], /Longs now pay shorts/);
});

test('near-liquidation warnings follow the chat\'s levels, once per level, and re-arm', async () => {
  const h = harness();
  await h.alerts.handle('1', '/watch 7');
  for (const d of [12, 9, 8, 4.5, 4, 16, 9]) { h.setPositions([pos(d)]); await h.alerts.checkRisk(); }
  await h.flush();
  const texts = h.sent.map(m => m.text);
  assert.equal(texts.length, 3);
  assert.match(texts[0], /⚠️ <b>Near liquidation · BTC LONG<\/b>\n.*\$478<\/b> position\nMark 84,419\.3 → liquidation 82,252\.5\n<b>9\.0% away<\/b>/);
  assert.match(texts[1], /🚨.*[\s\S]*4\.5% away/);
  assert.match(texts[2], /9\.0% away/);

  const early = harness();
  await early.alerts.handle('1', '/watch 7');
  await early.alerts.press('1', 'levels:early');
  for (const d of [30, 19, 9]) { early.setPositions([pos(d)]); await early.alerts.checkRisk(); }
  await early.flush();
  assert.deepEqual(early.sent.map(m => /(\d+\.\d)% away/.exec(m.text)[1]), ['19.0', '9.0']);
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
