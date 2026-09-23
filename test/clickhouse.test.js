// Integration test against a real ClickHouse (skipped unless CLICKHOUSE_URL is
// set; CI runs one as a service). Ingests synthetic exchange logs through the
// real ingest path, rolls up hours and checks that rollup-backed window
// queries equal raw-event queries, that interrupted commits are repaired and
// that restarts never duplicate rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClickHouse } from '../src/clickhouse.js';
import { migrate } from '../src/schema.js';
import { createIngest, ingestOptions } from '../src/ingest.js';
import { createRollups } from '../src/rollup.js';
import { createQueries } from '../src/query.js';
import { createFakeExchange, EXCHANGE } from './helpers/fake-exchange.js';
import { logBuilder, ev, BLOCK_TS } from './helpers/logs.js';

const url = process.env.CLICKHOUSE_URL;
const LONG = 0, SHORT = 1;

function syntheticChain() {
  const fake = createFakeExchange();
  const b = logBuilder();
  // Three hours of trading on markets 1 (BTC-like) and 20, one match every ~5 minutes.
  for (let block = 1000, i = 0; block < 11800; block += 300, i++) {
    b.at(block).tx()
      .add(...ev.increase(1, 7, SHORT, 1000000n, 100000n + BigInt(i) * 10n, 100000n + BigInt(i + 1) * 10n, { insFeeCNS: 0n, protFeeCNS: 3n }))
      .add(...ev.makerFill(1, 7, 1000000n + BigInt(i) * 100n, 10n, 3n))
      .add(...ev.open(1, 100 + i, LONG, 1000000n + BigInt(i) * 100n, 10n, { insFeeCNS: 1n, protFeeCNS: 9n }))
      .add(...ev.takerFill(1000000n + BigInt(i) * 100n, 10n, 10n));
    if (i % 3 === 0) b.tx().add(...ev.deposit(100 + i, 5000000n));
    if (i % 5 === 0) b.at(block + 1).tx().add(...ev.makerFill(20, 8, 5000n, 1000n, 0n)).add(...ev.close(20, 9, SHORT, 5000n, -1000n)).add(...ev.takerFill(5000n, 1000n, 0n));
  }
  for (const log of b.logs) { log.address = EXCHANGE; delete log.blockTimestamp; } // headers supply the time
  fake.chain.logs.push(...b.logs);
  fake.chain.head = 12000n;
  return fake;
}

test('ClickHouse ingest, rollups, windows, repair and restart', { skip: !url && 'set CLICKHOUSE_URL to run' }, async t => {
  const database = `perpl_test_${process.pid}_${Date.now()}`;
  const ch = createClickHouse({ url, user: process.env.CLICKHOUSE_USER || 'default', password: process.env.CLICKHOUSE_PASSWORD || '', database });
  t.after(() => ch.exec(`DROP DATABASE IF EXISTS ${database}`, {}, {}, { db: null }));
  await migrate(ch);
  const fake = syntheticChain();
  const config = { exchange: EXCHANGE, deployBlock: 900n };
  const options = ingestOptions({ LIVE_LOG_RANGE: 700, ARCHIVE_LOG_RANGE: 700, LIVE_BACKFILL_CONCURRENCY: 3 });
  const ingest = createIngest({ ch, config, liveRpc: fake.rpc, options });
  await ingest.init();
  await ingest.liveStep();
  await ingest.backfill();
  assert.deepEqual(ingest.coverage.intervals.map(x => [x.from, x.to]), [[900n, 12000n]]);
  assert.equal(ingest.progress().complete, true);
  const makerFills = Number((await ch.first("SELECT count() AS n FROM ev WHERE kind = 'maker_fill'")).n);
  assert.equal(makerFills, 36 + 8, 'one BTC maker fill per 300 blocks plus one market-20 fill every fifth');
  assert.equal(ingest.status.checks.unlinked, 0);
  assert.equal(ingest.status.checks.feeMismatch, 0);

  // Every closed hour rolls up, and rollup-backed windows equal raw windows.
  const rollups = createRollups({ ch, coverage: ingest.coverage });
  await rollups.run(BLOCK_TS(20000));
  assert.ok(rollups.status.hours >= 2, `rolled ${rollups.status.hours} hours`);
  const withRollups = createQueries({ ch, rollups, coverage: ingest.coverage });
  const rawOnly = createQueries({ ch, rollups: { rolledRuns: () => [] }, coverage: ingest.coverage });
  const from = BLOCK_TS(950), to = BLOCK_TS(11900);
  const strip = rows => rows.map(r => ({ ...r }));
  assert.deepEqual(strip(await withRollups.marketTotals(from, to)), strip(await rawOnly.marketTotals(from, to)));
  assert.deepEqual(strip(await withRollups.protocolTotals(from, to)), strip(await rawOnly.protocolTotals(from, to)));
  assert.deepEqual(await withRollups.traders(from, to), await rawOnly.traders(from, to));
  assert.deepEqual(await withRollups.accounts(from, to, { sort: 'volume', limit: 5 }), await rawOnly.accounts(from, to, { sort: 'volume', limit: 5 }));
  const series = await withRollups.marketTotals(Math.floor(from / 3600) * 3600, to, { bucket: 3600 });
  assert.ok(series.length >= 3);
  // Open interest from events equals the positions opened (each open adds 10 lots long).
  const cum = await withRollups.cumulativeBefore(to + 1);
  assert.equal(cum.oi.get(1).long, 360n);

  // A crash between the event insert and the coverage insert leaves rows that the next start removes.
  await ch.insert('ev', [{ block: 12500, log_index: 0, tx_index: 0, ts: BLOCK_TS(12500), tx: '0x' + 'ab'.repeat(32), kind: 'deposit', account: 5, amount: 1n }]);
  const restarted = createIngest({ ch, config, liveRpc: fake.rpc, options });
  await restarted.init();
  assert.equal(restarted.status.repaired, 1);
  assert.equal(Number((await ch.first('SELECT count() AS n FROM ev WHERE block > 12000')).n), 0);

  // Resuming adds nothing twice.
  const before = Number((await ch.first('SELECT count() AS n FROM ev')).n);
  await restarted.liveStep();
  await restarted.backfill();
  assert.equal(Number((await ch.first('SELECT count() AS n FROM ev')).n), before);
});
