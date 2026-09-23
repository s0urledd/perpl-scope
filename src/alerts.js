// Telegram alerts. People subscribe by chatting with the bot: wallets to
// watch (every position change, and a warning when a position nears its
// liquidation price), large liquidations, large trades and funding flips.
// Alerts come from the same committed events as the dashboard; nothing here
// trades or holds keys other than the bot token.
//
// The bot long-polls getUpdates, so it needs no public endpoint. Subscriptions
// are one JSON document in the kv table.

const KINDS = ['open', 'increase', 'decrease', 'close', 'invert', 'liquidation', 'deleverage'];
const VERB = { open: 'opened', increase: 'added to', decrease: 'reduced', close: 'closed', invert: 'flipped', liquidation: 'was liquidated on', deleverage: 'was deleveraged on' };
const MAX_WALLETS = 20, MAX_CHATS = 2000, MIN_USD = 1000;
// A position warns once below each level and re-arms after moving back above REARM_PCT.
const NEAR_LIQ_PCT = [10, 5], REARM_PCT = 15, STALE_S = 300;

export const HELP = [
  '<b>Plumb alerts for Perpl</b>',
  '',
  '/watch <i>address or account id</i>: position changes of a wallet, and a warning when one of its positions is within 10% and 5% of liquidation',
  '/unwatch <i>address or account id</i>',
  '/liqs <i>min USD</i> [<i>market</i>]: liquidations at least this large',
  '/trades <i>min USD</i> [<i>market</i>]: taker trades at least this large',
  '/funding on|off: funding flips (longs pay ↔ shorts pay)',
  '/list: your alerts · /stop: remove them all'
].join('\n');

const escHtml = v => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const short = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
export function usd(v, { sign = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n), s = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a.toFixed(2);
  return `${s}$${body}`;
}
// "50k", "1.5m", "$25,000" -> number
export function parseUsd(text) {
  const m = /^\$?([\d,]*\.?\d+)\s*([km])?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1);
  return Number.isFinite(n) ? n : null;
}
// 84,566.2 / 113.05 / 0.024467: five significant digits, grouped above 1,000.
export const fmtPrice = v => { const n = Number(v); if (!Number.isFinite(n) || v === null || v === undefined) return '—'; return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(+n.toPrecision(5)); };
const assetOf = s => String(s ?? '').replace(/(\s+perp|[_-]v\d+)$/i, '').trim().toUpperCase();

export function createAlerts({ token, fetch: doFetch = globalThis.fetch, store, resolveAccount, tradeViews, accountState, fundingSeed = async () => [], symbolOf = id => `#${id}`, marketIds = () => [], site = 'https://plumb.huginn.tech', explorer = 'https://monadvision.com', log = () => {}, now = () => Date.now(), sendGapMs = 1100 }) {
  const api = `https://api.telegram.org/bot${token}`;
  // chat id (string) -> { wallets: { [accountId]: address }, liqs: { min, market } | null, trades: { min, market } | null, funding: bool }
  let subs = {};
  let offset = 0, running = false, dirty = false, riskTimer = null, pollAbort = null;
  const lastFundingSign = new Map(); // market -> -1 | 1
  const warned = new Map(); // `${chat}:${account}:${market}:${side}` -> lowest level warned
  const stats = { chats: 0, sent: 0, failed: 0, commands: 0 };

  // --- persistence -------------------------------------------------------------
  async function load() {
    try { const saved = await store.load(); if (saved) ({ subs = {}, offset = 0 } = saved); } catch (error) { log('warn', `alerts: load failed: ${error.message}`); }
    stats.chats = Object.keys(subs).length;
  }
  async function save() {
    if (!dirty) return;
    dirty = false;
    // Chats that turned everything off are not kept.
    for (const [id, c] of Object.entries(subs)) if (!Object.keys(c.wallets).length && !c.liqs && !c.trades && !c.funding) delete subs[id];
    stats.chats = Object.keys(subs).length;
    try { await store.save({ subs, offset }); } catch (error) { dirty = true; log('warn', `alerts: save failed: ${error.message}`); }
  }
  const touch = () => { dirty = true; stats.chats = Object.keys(subs).length; };
  const chatOf = id => (subs[id] ??= { wallets: {}, liqs: null, trades: null, funding: false });
  const drop = id => { if (subs[id]) { delete subs[id]; touch(); } };

  // --- sending: one message at a time per chat, spaced for Telegram's limits ----
  const queues = new Map();
  async function call(method, body) {
    const res = await doFetch(`${api}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: pollAbort && method === 'getUpdates' ? pollAbort.signal : undefined });
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!json.ok) throw Object.assign(new Error(json.description || 'telegram error'), { code: json.error_code, retryAfter: json.parameters?.retry_after });
    return json.result;
  }
  function send(chat, html) {
    const prev = queues.get(chat) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await call('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }); stats.sent++; break; }
        catch (error) {
          if (error.code === 403 || error.code === 400 && /chat not found/i.test(error.message)) { drop(chat); break; } // blocked or gone
          if (error.code === 429 && attempt < 2) { await new Promise(r => setTimeout(r, (error.retryAfter ?? 1) * 1000)); continue; }
          stats.failed++; log('warn', `alerts: send failed: ${error.message}`); break;
        }
      }
      await new Promise(r => setTimeout(r, sendGapMs));
    });
    queues.set(chat, next);
    next.finally(() => { if (queues.get(chat) === next) queues.delete(chat); });
    return next;
  }

  // --- commands ------------------------------------------------------------------
  const marketByName = name => {
    if (!name) return null;
    const want = assetOf(name);
    const ids = marketIds().filter(id => assetOf(symbolOf(id)) === want);
    return ids.length ? ids.at(-1) : undefined; // the newest listing of that asset
  };
  const walletLink = (address, id) => `<a href="${site}/#/wallet/${escHtml(address || id)}">${escHtml(address ? short(address) : `#${id}`)}</a>`;
  function describe(s) {
    const lines = [];
    for (const [id, address] of Object.entries(s.wallets)) lines.push(`• wallet ${walletLink(address, id)}`);
    if (s.liqs) lines.push(`• liquidations ≥ ${usd(s.liqs.min)}${s.liqs.market !== null ? ` on ${escHtml(symbolOf(s.liqs.market))}` : ''}`);
    if (s.trades) lines.push(`• trades ≥ ${usd(s.trades.min)}${s.trades.market !== null ? ` on ${escHtml(symbolOf(s.trades.market))}` : ''}`);
    if (s.funding) lines.push('• funding flips');
    return lines.length ? `<b>Your alerts</b>\n${lines.join('\n')}` : 'No alerts yet. /help lists them.';
  }
  function threshold(kind, args) {
    const min = parseUsd(args[0]);
    if (min === null) return { error: `Usage: /${kind} <i>min USD</i> [<i>market</i>], e.g. /${kind} 25k BTC` };
    if (min < MIN_USD) return { error: `The minimum is ${usd(MIN_USD)}.` };
    const market = marketByName(args[1]);
    if (market === undefined) return { error: `Unknown market ${escHtml(args[1])}.` };
    return { min, market };
  }
  async function handle(chat, text) {
    stats.commands++;
    const [raw, ...args] = String(text).trim().split(/\s+/);
    let cmd = raw.toLowerCase().replace(/@\w+$/, '');
    // Deep links from the dashboard: t.me/<bot>?start=watch_<address>
    if (cmd === '/start' && /^watch_/.test(args[0] ?? '')) { cmd = '/watch'; args[0] = args[0].slice(6); }
    switch (cmd) {
      case '/start': case '/help': return HELP;
      case '/list': return describe(subs[chat] ?? { wallets: {} });
      case '/stop': drop(chat); return 'All your alerts are removed.';
      case '/watch': case '/unwatch': {
        if (!args[0]) return `Usage: ${cmd} <i>address or account id</i>`;
        let acct;
        try { acct = await resolveAccount(args[0]); } catch { acct = null; }
        if (!acct) return 'No Perpl account found for that address or id.';
        const key = String(acct.id);
        if (cmd === '/unwatch') { if (subs[chat]) { delete subs[chat].wallets[key]; touch(); } return `Stopped watching ${walletLink(acct.address, key)}.`; }
        if (!subs[chat] && Object.keys(subs).length >= MAX_CHATS) return 'The alert service is full right now.';
        const s = chatOf(chat);
        if (!s.wallets[key] && Object.keys(s.wallets).length >= MAX_WALLETS) return `You can watch up to ${MAX_WALLETS} wallets.`;
        s.wallets[key] = acct.address ?? null; touch();
        return `Watching ${walletLink(acct.address, key)}: position changes, and a warning within ${NEAR_LIQ_PCT.join('% and ')}% of liquidation.`;
      }
      case '/liqs': case '/trades': {
        const key = cmd.slice(1);
        if (/^off$/i.test(args[0] ?? '')) { chatOf(chat)[key] = null; touch(); return `${key === 'liqs' ? 'Liquidation' : 'Trade'} alerts off.`; }
        const t = threshold(key, args);
        if (t.error) return t.error;
        chatOf(chat)[key] = t; touch();
        return `${key === 'liqs' ? 'Liquidations' : 'Taker trades'} of ${usd(t.min)} or more${t.market !== null ? ` on ${escHtml(symbolOf(t.market))}` : ''} will be sent here. /${key} off to stop.`;
      }
      case '/funding': {
        const on = !/^off$/i.test(args[0] ?? 'on');
        chatOf(chat).funding = on; touch();
        return on ? 'You will get a message when a market’s funding changes direction.' : 'Funding alerts off.';
      }
      default: return 'Unknown command. /help lists them.';
    }
  }

  // --- events ----------------------------------------------------------------------
  const txLink = (tx, label) => (tx ? `<a href="${explorer}/tx/${escHtml(tx)}">${label}</a>` : label);
  function tradeLine(v) {
    const pnl = ['decrease', 'close', 'invert', 'liquidation', 'deleverage'].includes(v.kind) && Number(v.pnl) ? ` · PnL ${usd(v.pnl, { sign: true })}` : '';
    return `${escHtml(v.symbol)} ${escHtml(v.side ?? '')} ${escHtml(v.size)} @ ${fmtPrice(v.price ?? v.mark)} (${usd(v.notional)})${pnl} · ${txLink(v.tx, 'tx')}`;
  }
  // Called with each committed range of blocks (ingest 'commit' events).
  async function onCommit(event) {
    const chats = Object.entries(subs);
    if (!chats.length) return;
    // Catching up after downtime: old events are not news.
    if (now() / 1000 - Number(event.ts) > STALE_S) return;
    const watched = new Set(chats.flatMap(([, s]) => Object.keys(s.wallets)));
    const needTrades = chats.some(([, s]) => s.trades), needLiqs = chats.some(([, s]) => s.liqs);
    const rows = event.ev.filter(r => KINDS.includes(r.kind) && (watched.has(String(r.account)) || needLiqs && (r.kind === 'liquidation' || r.kind === 'deleverage') || needTrades && r.role === 'taker'));
    const views = rows.length ? await tradeViews(rows) : [];
    const out = new Map(); // chat -> lines
    const add = (chat, line) => { if (!out.has(chat)) out.set(chat, []); out.get(chat).push(line); };
    for (const [chat, s] of chats) {
      for (const v of views) {
        const n = Number(v.notional);
        if (s.wallets[String(v.account)] !== undefined) add(chat, `${walletLink(v.address, v.account)} ${VERB[v.kind]} ${tradeLine(v)}`);
        else if (s.liqs && (v.kind === 'liquidation' || v.kind === 'deleverage') && n >= s.liqs.min && (s.liqs.market === null || v.market === s.liqs.market)) add(chat, `<b>${v.kind === 'liquidation' ? 'Liquidation' : 'Deleverage'}</b> · ${walletLink(v.address, v.account)} ${tradeLine(v)}`);
        else if (s.trades && v.role === 'taker' && v.kind !== 'liquidation' && n >= s.trades.min && (s.trades.market === null || v.market === s.trades.market)) add(chat, `<b>Large ${v.buy ? 'buy' : 'sell'}</b> · ${walletLink(v.address, v.account)} ${VERB[v.kind]} ${tradeLine(v)}`);
      }
    }
    // Funding direction: positive rates mean longs pay. Zero keeps the last direction.
    const flips = [];
    for (const f of event.funding ?? []) {
      const rate = Number(f.actual_rate) / 1000, sign = Math.sign(rate);
      if (!sign) continue;
      const before = lastFundingSign.get(f.market);
      lastFundingSign.set(f.market, sign);
      if (before !== undefined && before !== sign) flips.push(`<b>Funding flipped</b> on ${escHtml(symbolOf(f.market))}: ${sign > 0 ? 'longs now pay shorts' : 'shorts now pay longs'} (${rate > 0 ? '+' : ''}${rate.toFixed(4)}% this interval)`);
    }
    if (flips.length) for (const [chat, s] of chats) if (s.funding) flips.forEach(line => add(chat, line));
    await Promise.all([...out].map(([chat, lines]) => sendLines(chat, lines)));
  }
  // Telegram caps a message at 4096 characters: split on line boundaries.
  function sendLines(chat, lines) {
    const parts = [];
    let cur = '';
    for (const line of lines) { if (cur && cur.length + line.length + 1 > 3800) { parts.push(cur); cur = ''; } cur += (cur ? '\n' : '') + line; }
    if (cur) parts.push(cur);
    return Promise.all(parts.map(p => send(chat, p)));
  }

  // Positions of watched wallets against their liquidation price, from contract state.
  async function checkRisk() {
    const byAccount = new Map();
    for (const [chat, s] of Object.entries(subs)) for (const id of Object.keys(s.wallets)) { if (!byAccount.has(id)) byAccount.set(id, []); byAccount.get(id).push(chat); }
    for (const [id, chats] of byAccount) {
      let state;
      try { state = await accountState(Number(id)); } catch { continue; }
      const live = new Set();
      for (const p of state?.positions ?? []) {
        const d = p.liquidation_distance_pct;
        for (const chat of chats) {
          const key = `${chat}:${id}:${p.market}:${p.side}`;
          live.add(key);
          if (d === null || d === undefined) continue;
          if (d > REARM_PCT) { warned.delete(key); continue; }
          const level = NEAR_LIQ_PCT.filter(x => d <= x).at(-1);
          if (level === undefined || (warned.get(key) ?? Infinity) <= level) continue;
          warned.set(key, level);
          await send(chat, `<b>Near liquidation</b> · ${walletLink(subs[chat]?.wallets[id], id)} ${escHtml(p.symbol)} ${escHtml(p.side)} ${usd(p.notional)}: mark ${fmtPrice(p.mark)}, liquidation at ${fmtPrice(p.liquidation_price)} (${d.toFixed(1)}% away)`);
        }
      }
      // A closed position clears its warning.
      for (const key of [...warned.keys()]) if (key.split(':')[1] === id && !live.has(key)) warned.delete(key);
    }
  }

  // --- polling loop --------------------------------------------------------------------
  async function pollOnce() {
    const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1); dirty = true;
      const msg = u.message;
      if (!msg?.text || msg.chat?.type !== 'private') continue; // private chats only
      const chat = String(msg.chat.id);
      const reply = await handle(chat, msg.text).catch(error => { log('warn', `alerts: command failed: ${error.message}`); return 'Something went wrong; try again.'; });
      if (reply) send(chat, reply);
    }
    await save();
  }
  async function loop() {
    while (running) {
      try { await pollOnce(); }
      catch (error) { if (!running) break; log('warn', `alerts: poll failed: ${error.message}`); await new Promise(r => setTimeout(r, 5000)); }
    }
  }
  async function start({ riskMs = 60000 } = {}) {
    await load();
    // The last direction per market, so the first flip after a restart is not missed.
    try { for (const f of await fundingSeed()) { const sign = Math.sign(Number(f.actual_rate)); if (sign) lastFundingSign.set(Number(f.market), sign); } } catch (error) { log('warn', `alerts: funding seed failed: ${error.message}`); }
    running = true;
    pollAbort = new AbortController();
    loop();
    riskTimer = setInterval(() => { checkRisk().catch(error => log('warn', `alerts: risk check failed: ${error.message}`)); save(); }, riskMs);
    try { const me = await call('getMe', {}); stats.bot = me.username; log('info', `alerts: Telegram bot @${me.username}, ${stats.chats} chats`); } catch (error) { log('warn', `alerts: getMe failed: ${error.message}`); }
  }
  function stop() { running = false; pollAbort?.abort(); clearInterval(riskTimer); return save(); }

  return { start, stop, handle, onCommit, checkRisk, pollOnce, load, save, stats, subs: () => subs };
}

// Subscriptions live as one JSON value in the kv table.
export function kvStore(ch, key = 'alerts.telegram') {
  return {
    async load() { const r = await ch.first('SELECT value FROM kv FINAL WHERE key = {k:String}', { k: key }); return r ? JSON.parse(r.value) : null; },
    async save(value) { await ch.insert('kv', [{ key, value: JSON.stringify(value) }]); }
  };
}
