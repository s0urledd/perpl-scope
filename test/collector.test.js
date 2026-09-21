import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, collectorOptions } from '../src/collector.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';
import { loadCheckpoint } from '../src/checkpoint.js';
import { readFile } from 'node:fs/promises';

const config = { url: 'https://example.invalid', chain: '143', exchange: EXCHANGE };
const options = dir => ({ ...collectorOptions({ POLL_MS: 1, LOG_RANGE: 100, BACKFILL_BLOCKS: 50, FUNDING_HISTORY_EVENTS: 2, VERIFY_BLOCKS: 5, CHECKPOINT_MS: 0 }), checkpointPath: join(dir, 'checkpoint.json'), indexPath: join(dir, 'index.json'), indexBlocks: 500n, indexBucketBlocks: 100n, indexLogRange: 100n });

async function withDir(fn) { const dir = await mkdtemp(join(tmpdir(), 'perpl-collector-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test('bootstrap, incremental polls and reconciliation', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n); fake.open(20, 7n, 0, 5000n); fake.open(20, 8n, 1, 5000n);
    const collector = createCollector({ config, options: options(dir), rpc: fake.rpc });
    await collector.bootstrap('test');
    assert.equal(collector.state.status, 'fresh');
    assert.equal(collector.state.block.number, 1000n);
    assert.equal(collector.state.markets.get(1).positions.size, 2);
    assert.equal(collector.state.reconciliation.ok, true);
    // New block with one open and one close; only touched positions are re-read.
    fake.advance(3n); fake.open(1, 9n, 0, 20000n); fake.close(20, 8n); fake.open(20, 10n, 1, 5000n);
    const before = fake.stats.byMethod.eth_call ?? 0;
    await collector.poll();
    assert.equal(collector.state.block.number, 1003n);
    assert.equal(collector.state.markets.get(1).positions.size, 3);
    assert.equal(collector.state.markets.get(20).positions.has('8'), false);
    assert.equal(collector.state.markets.get(20).positions.has('10'), true);
    assert.equal(collector.state.reconciliation.ok, true);
    assert.equal(collector.state.stats.dirtyReads, 3);
    assert.ok((fake.stats.byMethod.eth_call ?? 0) - before <= 6, 'incremental poll uses few calls');
    // Nothing new: poll is a no-op.
    await collector.poll();
    assert.equal(collector.state.block.number, 1003n);
  });
});

test('silent drift is caught by OI reconciliation and triggers a bootstrap', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    const collector = createCollector({ config, options: options(dir), rpc: fake.rpc });
    await collector.bootstrap('test');
    fake.advance(); fake.silentDrift(1, 5n, 50000n);
    await collector.poll();
    assert.equal(collector.state.bootstrap.reason, 'oi-mismatch');
    assert.equal(collector.state.markets.get(1).positions.get('5').lotLNS, 150000n);
    assert.equal(collector.state.status, 'fresh');
  });
});

test('funding grid crossings refresh every position', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange({ fundingInterval: 100n });
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    const collector = createCollector({ config, options: options(dir), rpc: fake.rpc });
    await collector.bootstrap('test');
    fake.advance(100n); fake.funding(1, -34n);
    await collector.poll();
    assert.equal(collector.state.markets.get(1).positions.get('5').premiumPnlCNS, 3400000n);
    assert.equal(collector.state.markets.get(1).positions.get('6').premiumPnlCNS, -3400000n);
  });
});

test('reorganisation of the processed block forces a bootstrap', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    const collector = createCollector({ config, options: options(dir), rpc: fake.rpc });
    await collector.bootstrap('test');
    fake.fork(1000n); fake.advance();
    await collector.poll();
    assert.equal(collector.state.bootstrap.reason, 'reorg');
    assert.equal(collector.state.block.number, 1001n);
  });
});

test('independent account-bitmap verification agrees with stored positions', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n); fake.open(20, 6n, 0, 5000n); fake.open(20, 7n, 1, 5000n);
    const collector = createCollector({ config, options: options(dir), rpc: fake.rpc });
    await collector.bootstrap('test');
    const result = await collector.verify();
    assert.equal(result.ok, true);
    assert.equal(result.scanned, 4);
    assert.equal(result.candidates, 4);
  });
});

test('checkpoints resume when canonical and are rejected when stale', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    const first = createCollector({ config, options: options(dir), rpc: fake.rpc });
    await first.bootstrap('test');
    await first.checkpoint();
    const saved = await loadCheckpoint(join(dir, 'checkpoint.json'), { chain: '143', exchange: EXCHANGE });
    assert.equal(saved.block.number, 1000n);
    assert.equal(saved.markets.get(1).positions.size, 2);
    // A second collector resumes and catches up with the incremental path.
    fake.advance(2n); fake.open(1, 9n, 0, 1000n);
    const second = createCollector({ config, options: options(dir), rpc: fake.rpc });
    const logs = [];
    const run = second.start();
    await new Promise(resolve => { const check = () => second.state.block?.number === 1002n && second.state.status === 'fresh' ? resolve() : setTimeout(check, 5); check(); });
    second.stop(); await run;
    assert.equal(second.state.markets.get(1).positions.size, 3);
    assert.equal(second.state.bootstrap.at, first.state.bootstrap.at, 'resumed without a new bootstrap');
    assert.equal(logs.length, 0);
  });
});

test('the event index follows polls and backfills the window in the background', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.chain.head = 900n; fake.open(1, 5n, 0, 100000n); fake.chain.head = 1000n;
    const collector = createCollector({ config, options: options(dir), rpc: fake.rpc });
    await collector.bootstrap('test');
    assert.deepEqual(collector.index.covered, { from: 1000n, to: 1000n });
    assert.equal(collector.index.snapshots.size, 1, 'snapshot at bootstrap');
    fake.advance(2n); fake.open(1, 6n, 1, 50000n); fake.close(1, 5n);
    await collector.poll();
    assert.deepEqual(collector.index.covered, { from: 1000n, to: 1002n });
    assert.equal(collector.index.size, 2);
    assert.equal(collector.index.accountRecords(5).map(r => r.type).join(','), 'close');
    const result = await collector.backfillIndex();
    assert.equal(result.complete, true);
    assert.deepEqual(collector.index.covered, { from: 502n, to: 1002n });
    assert.equal(collector.index.size, 3, 'the open at block 900 was backfilled');
    assert.equal(collector.index.backfill.done, true);
    assert.ok(collector.index.snapshots.size >= 5, 'bucket boundaries sampled through archive reads');
    const agg = collector.index.aggregate(502n, 1002n, new Map());
    assert.equal(agg.opens, 2); assert.equal(agg.closes, 1); assert.equal(agg.activeAccounts, 2);
    await collector.checkpoint();
    const text = await readFile(join(dir, 'index.json'), 'utf8');
    assert.ok(text.includes('"version":2'));
    // A fresh collector reloads the aggregates and rebuilds the raw window.
    const again = createCollector({ config, options: options(dir), rpc: fake.rpc });
    const run = again.start();
    await new Promise(resolve => setTimeout(resolve, 150));
    again.stop(); await run;
    assert.equal(again.index.backfill.done, true);
    assert.equal(again.index.aggregate(502n, 1002n, new Map()).opens, 2);
  });
});
