import test from 'node:test';
import assert from 'node:assert/strict';
import { createRollups } from '../src/rollup.js';

const HOUR = 3600, START = 1788220800; // an hour boundary

test('a rollup run that times out is retried in halves down to single hours', async () => {
  const ran = [];
  const ch = {
    query: async () => [],
    insert: async () => {},
    // Statements over more than a day time out, as a busy week can.
    exec: async (sql, { from, to }) => { if (to - from > 24 * HOUR) throw new Error('CLICKHOUSE_UNREACHABLE: timeout'); ran.push([from, to]); }
  };
  const coverage = { intervals: [{ from: 1n, to: 2n, fromTs: START, toTs: START + 72 * HOUR }], hourCovered: () => true };
  const rollups = createRollups({ ch, coverage, maxHoursPerStatement: 72 });
  await rollups.run(START + 100 * HOUR);
  const hours = new Set(ran.map(([from, to]) => `${from}-${to}`));
  assert.ok([...hours].every(k => { const [a, b] = k.split('-').map(Number); return b - a <= 24 * HOUR; }));
  const covered = new Set(); for (const [a, b] of ran) for (let h = a; h < b; h += HOUR) covered.add(h);
  assert.equal(covered.size, 72, 'every hour rolled once the pieces fit');
  assert.equal(rollups.status.lastError, null);
});
