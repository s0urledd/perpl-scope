// Collector behaviour when things go wrong: a disk that refuses checkpoints,
// overlapping saves, a verification mismatch whose rebuild first fails, and a
// provider whose head stops moving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, collectorOptions } from '../src/collector.js';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';

const config = { url: 'https://example.invalid', chain: '143', exchange: EXCHANGE };
// The fake chain's timestamps are fixed in the past: block age is not checked.
const options = (path, env = {}) => ({ ...collectorOptions({ MAX_BLOCK_AGE_MS: 0, POLL_MS: 1, LOG_RANGE: 100, BACKFILL_BLOCKS: 50, FUNDING_HISTORY_EVENTS: 2, VERIFY_BLOCKS: 1000000, CHECKPOINT_MS: 0, BOOK_DISABLED: '1', ...env }), checkpointPath: path });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function withDir(fn) { const dir = await mkdtemp(join(tmpdir(), 'perpl-resilience-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
async function until(check, ms = 3000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('TIMEOUT'); await sleep(5); } }

test('a checkpoint that cannot be written never fails bootstrap or polls', async () => {
  await withDir(async dir => {
    await writeFile(join(dir, 'blocker'), 'not a directory');
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    const collector = createCollector({ config, options: options(join(dir, 'blocker', 'checkpoint.json')), rpc: fake.rpc });
    await collector.bootstrap('test');
    assert.equal(collector.state.status, 'fresh');
    assert.ok(collector.state.stats.checkpointError?.code, 'the write failure is reported');
    fake.advance(); fake.open(1, 7n, 0, 1000n);
    await collector.poll();
    assert.equal(collector.state.status, 'fresh');
    assert.equal(collector.state.block.number, 1001n);
  });
});

test('overlapping checkpoint saves leave one readable file and no temporaries', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    const path = join(dir, 'checkpoint.json');
    const collector = createCollector({ config, options: options(path), rpc: fake.rpc });
    await collector.bootstrap('test');
    await Promise.all(Array.from({ length: 25 }, () => saveCheckpoint(path, collector.state)));
    const loaded = await loadCheckpoint(path, { chain: config.chain, exchange: config.exchange });
    assert.equal(loaded.block.number, collector.state.block.number);
    assert.deepEqual(await readdir(dir), ['checkpoint.json']);
  });
});

test('a verification mismatch stays stale until a rebuild succeeds', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    let down = false;
    const rpc = (method, params) => (down ? Promise.reject(new Error('RPC down')) : fake.rpc(method, params));
    const collector = createCollector({ config, options: options(join(dir, 'checkpoint.json')), rpc });
    await collector.bootstrap('test');
    // Stored collateral drifts from the contract while sizes still match the OI counters.
    collector.state.markets.get(1).positions.get('5').depositCNS += 1n;
    const verification = await collector.verify();
    assert.equal(verification.ok, false);
    assert.equal(collector.state.status, 'stale');
    down = true;
    const running = collector.start();
    await sleep(60);
    assert.notEqual(collector.state.status, 'fresh', 'no poll may mark wrong positions fresh');
    assert.equal(collector.state.verification.ok, false, 'the mismatch record is kept');
    down = false;
    await until(() => collector.state.status === 'fresh');
    collector.stop();
    await running;
    assert.equal(collector.state.bootstrap.reason, 'verification-mismatch');
    assert.equal(collector.state.markets.get(1).positions.get('5').depositCNS, fake.state.markets.get(1).positions.get('5').depositCNS);
  });
});

test('a head that stops advancing is reported stale while polls still succeed', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    // No checkpoint writes after polls, and a limit well above a slow runner's
    // disk and scheduling delays: only the head's progress decides freshness.
    const collector = createCollector({ config, options: options(join(dir, 'checkpoint.json'), { STALE_AFTER_MS: 250, CHECKPOINT_MS: 600000 }), rpc: fake.rpc });
    await collector.bootstrap('test');
    assert.equal(collector.freshness().status, 'fresh');
    await sleep(300);
    await collector.poll(); // succeeds, but the head has not moved
    assert.deepEqual([collector.freshness().status, collector.freshness().reason], ['stale', 'head-stalled']);
    fake.advance();
    await collector.poll();
    assert.equal(collector.freshness().status, 'fresh');
  });
});

test('a zero account scan batch is clamped instead of looping forever', () => {
  assert.equal(collectorOptions({ ACCOUNT_SCAN_BATCH: '0' }).accountScanBatch, 1);
});

test('wake() polls without waiting for the poll timer', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n); fake.open(1, 6n, 1, 100000n);
    const collector = createCollector({ config, options: { ...options(join(dir, 'checkpoint.json')), pollMs: 60000, minPollMs: 0 }, rpc: fake.rpc });
    const run = collector.start();
    await until(() => collector.state.block !== null && collector.state.status === 'fresh');
    const before = collector.state.block.number;
    fake.advance(); fake.open(1, 7n, 0, 1000n);
    collector.wake();
    await until(() => collector.state.block.number > before, 2000);
    collector.stop();
    await run;
  });
});

test('a head far behind the clock is stale even while it advances', async () => {
  await withDir(async dir => {
    const fake = createFakeExchange();
    fake.open(1, 5n, 0, 100000n);
    const collector = createCollector({ config, options: { ...options(join(dir, 'checkpoint.json')), maxBlockAgeMs: 60000 }, rpc: fake.rpc });
    await collector.bootstrap('test');
    const ts = collector.state.block.timestamp * 1000;
    assert.equal(collector.freshness(ts + 5000).status, 'fresh');
    const late = collector.freshness(ts + 120000);
    assert.equal(late.status, 'stale'); assert.equal(late.reason, 'head-behind'); assert.equal(late.blockAgeMs, 120000);
  });
});
