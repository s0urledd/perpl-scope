import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverage } from '../src/coverage.js';
import { segments, intersect } from '../src/query.js';

test('coverage merges touching ranges and reports gaps', () => {
  const c = createCoverage({ floor: 100n });
  c.add(200n, 299n, 2000, 2990);
  c.add(100n, 149n, 1000, 1490);
  c.add(150n, 199n, 1500, 1990); // touches both neighbours
  c.add(500n, 599n, 5000, 5990);
  assert.deepEqual(c.intervals.map(x => [x.from, x.to, x.fromTs, x.toTs]), [[100n, 299n, 1000, 2990], [500n, 599n, 5000, 5990]]);
  assert.deepEqual(c.gaps(100n, 700n), [{ from: 300n, to: 499n }, { from: 600n, to: 700n }]);
  assert.equal(c.blocks(100n, 700n), 300n);
  assert.equal(c.top(), 599n);
  assert.equal(c.contiguousTs(), 2990);
  assert.ok(c.contains(250n) && !c.contains(300n));
});

test('an hour counts as covered only when one interval spans all of it', () => {
  const c = createCoverage({ floor: 0n });
  c.add(1000n, 2000n, 3000, 7300); // first block after the floor: covers everything from the start
  assert.equal(c.hourCovered(3600), true);
  assert.equal(c.hourCovered(7200), false, 'ends before 10800');
  const d = createCoverage({ floor: 0n });
  d.add(5000n, 9000n, 3600, 10800);
  assert.equal(d.hourCovered(3600), false, 'a block with the same timestamp may precede the interval');
  d.add(4000n, 4999n, 3500, 3599);
  assert.equal(d.hourCovered(3600), true);
});

test('window segments split rolled-up hours from raw ranges', () => {
  const rolled = new Set([3600, 7200, 14400]);
  const runs = (from, to) => { const out = []; for (let h = Math.ceil(from / 3600) * 3600; h + 3600 <= to; h += 3600) if (rolled.has(h)) { const last = out.at(-1); if (last && last[1] === h) last[1] = h + 3600; else out.push([h, h + 3600]); } return out; };
  const s = segments(3000, 16000, runs);
  assert.deepEqual(s.rolled, [[3600, 10800]], '14400 is not fully inside the window');
  assert.deepEqual(s.raw, [[3000, 3600], [10800, 16000]]);
  assert.deepEqual(intersect([[0, 100], [200, 300]], [[50, 250]]), [[50, 100], [200, 250]]);
});
