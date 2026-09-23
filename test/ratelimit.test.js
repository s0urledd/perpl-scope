import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, clientOf, costOf, rateLimitFromEnv } from '../src/ratelimit.js';

const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('a burst is allowed, then requests wait for the refill', () => {
  let t = 0;
  const rl = createRateLimiter({ perMinute: 60, burst: 3, now: () => t });
  assert.ok(rl.take('a').ok); assert.ok(rl.take('a').ok); assert.ok(rl.take('a').ok);
  const denied = rl.take('a');
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterS, 1);
  assert.ok(rl.take('b').ok, 'clients have separate buckets');
  t = 1000;
  assert.ok(rl.take('a').ok, 'one token back after a second at 60/min');
  assert.equal(rl.take('a').ok, false);
});

test('heavy requests cost more', () => {
  assert.equal(costOf('/api/v1/protocol', new URLSearchParams('window=7d')), 1);
  assert.equal(costOf('/api/v1/leaderboard', new URLSearchParams('format=csv')), 10);
  assert.equal(costOf('/api/v1/compare', new URLSearchParams('w=1,2')), 10);
  assert.equal(costOf('/api/v1/wallets/0xabc/analytics', new URLSearchParams()), 3);
  const rl = createRateLimiter({ perMinute: 60, burst: 12, now: () => 0 });
  assert.ok(rl.take('a', 10).ok);
  assert.equal(rl.take('a', 10).ok, false);
  assert.ok(rl.take('a', 1).ok);
});

test('the forwarded client is trusted only from a loopback proxy', () => {
  assert.equal(clientOf(req('127.0.0.1', '1.2.3.4, 5.6.7.8')), '5.6.7.8', 'last hop is the one nginx appended');
  assert.equal(clientOf(req('::ffff:127.0.0.1', '9.9.9.9')), '9.9.9.9');
  assert.equal(clientOf(req('203.0.113.7', '1.2.3.4')), '203.0.113.7', 'a direct client cannot pick its own key');
  assert.equal(clientOf(req('127.0.0.1', '1.2.3.4'), { trustProxy: false }), '127.0.0.1');
});

test('the client table stays bounded', () => {
  const rl = createRateLimiter({ perMinute: 60, burst: 5, maxClients: 100, now: () => 0 });
  for (let i = 0; i < 1000; i++) rl.take(`c${i}`);
  assert.ok(rl.clients <= 101);
});

test('configuration from the environment; zero disables', () => {
  assert.equal(rateLimitFromEnv({ RATE_LIMIT_PER_MIN: '0' }), null);
  assert.ok(rateLimitFromEnv({}));
});
