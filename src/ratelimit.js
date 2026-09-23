// Per-client token buckets for the public API. Heavy requests (CSV exports,
// wallet comparisons, first-load wallet analytics) cost more than a plain read.
// Behind a local reverse proxy the client is the last X-Forwarded-For entry,
// the one the proxy itself appended; it is trusted only from loopback peers.
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

export function costOf(pathname, query) {
  if (query.get('format') === 'csv') return 10;
  if (pathname === '/api/v1/compare') return 10;
  if (/^\/api\/v1\/wallets\/[^/]+\/analytics$/.test(pathname)) return 3;
  return 1;
}

export function clientOf(req, { trustProxy = true } = {}) {
  const peer = req.socket?.remoteAddress ?? '';
  const forwarded = req.headers?.['x-forwarded-for'];
  if (trustProxy && forwarded && LOOPBACK.test(peer)) {
    const last = String(forwarded).split(',').map(s => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return peer || 'unknown';
}

export function createRateLimiter({ perMinute = 600, burst = 120, trustProxy = true, maxClients = 20000, now = () => Date.now() } = {}) {
  const rate = perMinute / 60000; // tokens per ms
  const buckets = new Map(); // client -> { tokens, at }
  function refill(b, t) { b.tokens = Math.min(burst, b.tokens + (t - b.at) * rate); b.at = t; }
  function prune(t) {
    for (const [k, b] of buckets) { refill(b, t); if (b.tokens >= burst) buckets.delete(k); }
    // Still over the cap (a flood of distinct clients): drop the oldest entries.
    for (const k of buckets.keys()) { if (buckets.size <= maxClients) break; buckets.delete(k); }
  }
  return {
    get clients() { return buckets.size; },
    // { ok, remaining, retryAfterS }
    take(client, cost = 1) {
      const t = now();
      let b = buckets.get(client);
      if (!b) { if (buckets.size >= maxClients) prune(t); b = { tokens: burst, at: t }; buckets.set(client, b); } else refill(b, t);
      if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, remaining: Math.floor(b.tokens), retryAfterS: 0 }; }
      return { ok: false, remaining: 0, retryAfterS: Math.max(1, Math.ceil((cost - b.tokens) / rate / 1000)) };
    },
    check(req, pathname, query) { return this.take(clientOf(req, { trustProxy }), costOf(pathname, query)); }
  };
}

export function rateLimitFromEnv(env) {
  const perMinute = Number(env.RATE_LIMIT_PER_MIN ?? 600);
  if (!(perMinute > 0)) return null;
  return createRateLimiter({ perMinute, burst: Number(env.RATE_LIMIT_BURST ?? 120) || 120, trustProxy: env.TRUST_PROXY !== '0' });
}
