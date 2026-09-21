import test from 'node:test';
import assert from 'node:assert/strict';
import { backfill } from '../src/backfill.js';

// A provider with a 1000-block range limit and no history below `horizon`.
function provider({ horizon = 0n, maxRange = 1000n, failOnce = null } = {}) {
  const calls = [];
  let failed = false;
  return { calls, fetchLogs: async (from, to) => { calls.push([from, to]); if (to - from + 1n > maxRange) throw new Error('RANGE'); if (from < horizon) throw new Error('HORIZON'); if (failOnce && !failed && from <= failOnce && failOnce <= to) { failed = true; throw new Error('TRANSIENT'); } return Array.from({ length: Number(to - from + 1n) }, (_, i) => ({ block: from + BigInt(i) })); } };
}

test('walks newest to oldest with concurrency and reports contiguous coverage', async () => {
  const p = provider();
  const chunks = [], progress = [];
  const r = await backfill({ fetchLogs: p.fetchLogs, from: 1n, to: 5000n, chunk: 1000n, concurrency: 3, onChunk: async (logs, lo, hi) => { chunks.push([lo, hi, logs.length]); }, onProgress: x => progress.push(x.contiguousFrom) });
  assert.equal(r.complete, true); assert.equal(r.contiguousFrom, 1n); assert.equal(r.chunks, 5);
  assert.deepEqual(chunks.map(c => c[2]).reduce((a, b) => a + b, 0), 5000);
  assert.equal(progress.at(-1), 1n);
  assert.ok(progress.every((v, i) => i === 0 || v <= progress[i - 1]), 'coverage only grows downward');
});

test('splits chunks the provider rejects and stops at the history horizon', async () => {
  const p = provider({ horizon: 2500n, maxRange: 300n });
  const r = await backfill({ fetchLogs: p.fetchLogs, from: 1n, to: 4000n, chunk: 1000n, minChunk: 50n, concurrency: 1 });
  assert.equal(r.complete, false);
  assert.equal(r.contiguousFrom, 3001n, 'the chunk containing the horizon is not counted');
  assert.ok(r.failed && r.failed.from === 2001n);
  assert.ok(p.calls.every(([lo, hi]) => hi - lo + 1n <= 1000n));
});

test('a stopped run reports where it got to', async () => {
  const p = provider();
  let n = 0;
  const r = await backfill({ fetchLogs: p.fetchLogs, from: 1n, to: 5000n, chunk: 1000n, concurrency: 1, isRunning: () => n++ < 2 });
  assert.equal(r.stopped, true); assert.equal(r.complete, false); assert.equal(r.contiguousFrom, 3001n);
});

test('empty range completes immediately', async () => {
  const r = await backfill({ fetchLogs: async () => [], from: 10n, to: 5n });
  assert.equal(r.complete, true); assert.equal(r.chunks, 0);
});
