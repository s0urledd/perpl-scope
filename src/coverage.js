// Set of ingested block intervals with the timestamps of their end blocks.
// An hour is fully covered when one interval starts before it (or at the
// exchange deployment) and ends at or after the hour's end: block timestamps
// never decrease, so every block of that hour lies inside the interval.
export function createCoverage({ floor = 0n } = {}) {
  let list = []; // sorted, merged: { from, to, fromTs, toTs }

  function add(from, to, fromTs, toTs) {
    from = BigInt(from); to = BigInt(to);
    if (to < from) throw new Error('INVALID_RANGE');
    let item = { from, to, fromTs: Number(fromTs), toTs: Number(toTs) };
    const next = [];
    for (const x of list) {
      if (x.to + 1n < item.from || x.from > item.to + 1n) { next.push(x); continue; }
      item = {
        from: x.from < item.from ? x.from : item.from, fromTs: x.from < item.from ? x.fromTs : item.fromTs,
        to: x.to > item.to ? x.to : item.to, toTs: x.to > item.to ? x.toTs : item.toTs
      };
    }
    next.push(item);
    next.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    list = next;
    return item;
  }

  // Uncovered sub-ranges of [lo, hi], ascending.
  function gaps(lo, hi) {
    lo = BigInt(lo); hi = BigInt(hi);
    const out = [];
    let cursor = lo;
    for (const x of list) {
      if (x.to < cursor) continue;
      if (x.from > hi) break;
      if (x.from > cursor) out.push({ from: cursor, to: x.from - 1n < hi ? x.from - 1n : hi });
      cursor = x.to + 1n;
      if (cursor > hi) break;
    }
    if (cursor <= hi) out.push({ from: cursor, to: hi });
    return out;
  }

  const blocks = (lo, hi) => { let n = 0n; for (const x of list) { const a = x.from > lo ? x.from : lo, b = x.to < hi ? x.to : hi; if (b >= a) n += b - a + 1n; } return n; };
  const top = () => (list.length ? list.at(-1).to : null);
  const topTs = () => (list.length ? list.at(-1).toTs : null);
  const contains = block => list.some(x => x.from <= BigInt(block) && BigInt(block) <= x.to);
  // Hour [start, start + 3600) inside one interval.
  const hourCovered = start => list.some(x => (x.from <= floor || x.fromTs < start) && x.toTs >= start + 3600);
  // Seconds-range [start, end] inside one interval.
  const spanCovered = (start, end) => list.some(x => (x.from <= floor || x.fromTs < start) && x.toTs >= end);
  // Latest time T such that everything from the exchange deployment up to T is covered.
  const contiguousTs = () => (list.length && list[0].from <= floor ? list[0].toTs : null);

  return { add, gaps, blocks, top, topTs, contains, hourCovered, spanCovered, contiguousTs, get intervals() { return list.map(x => ({ ...x })); }, get size() { return list.length; } };
}
