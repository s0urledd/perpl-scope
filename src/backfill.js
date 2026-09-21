// Concurrent newest-to-oldest log backfill. Chunks halve when a provider
// rejects a range and the walk stops where the provider's history ends, so a
// node that keeps four days serves four days and a public endpoint with a
// 100-block limit still works, only slower. Coverage is reported as the
// lowest block reached contiguously from the top, which is what makes an
// aggregate over [from, to] trustworthy.
export async function backfill({ fetchLogs, from, to, chunk = 1000n, minChunk = 50n, concurrency = 4, onChunk = async () => {}, onProgress = () => {}, isRunning = () => true }) {
  if (from > to) return { contiguousFrom: to + 1n, complete: true, chunks: 0, failed: null };
  const ranges = [];
  for (let hi = to; hi >= from; hi -= chunk) ranges.push([hi - chunk + 1n > from ? hi - chunk + 1n : from, hi]);
  const done = new Set();
  let next = 0, contiguousIndex = 0, stopped = false, failed = null, chunks = 0;

  async function fetchRange(lo, hi, size) {
    try { return await fetchLogs(lo, hi); }
    catch (error) {
      if (hi - lo + 1n <= minChunk) { try { return await fetchLogs(lo, hi); } catch { throw error; } }
      const half = (hi - lo + 1n) / 2n; const mid = lo + half - 1n;
      const upper = await fetchRange(mid + 1n, hi, half);
      const lower = await fetchRange(lo, mid, half);
      return [...lower, ...upper];
    }
  }

  async function worker() {
    while (!stopped && isRunning()) {
      const i = next++;
      if (i >= ranges.length) return;
      const [lo, hi] = ranges[i];
      try {
        const logs = await fetchRange(lo, hi, chunk);
        await onChunk(logs, lo, hi);
        done.add(i); chunks++;
        while (done.has(contiguousIndex)) contiguousIndex++;
        onProgress({ contiguousFrom: contiguousIndex < ranges.length ? ranges[contiguousIndex][1] + 1n : from, chunks, total: ranges.length, failed });
      } catch (error) {
        if (!stopped) { stopped = true; failed = { from: lo, to: hi, message: error.message }; }
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ranges.length)) }, worker));
  const contiguousFrom = contiguousIndex < ranges.length ? ranges[contiguousIndex][1] + 1n : from;
  return { contiguousFrom, complete: contiguousFrom === from, chunks, failed, stopped: !isRunning() };
}
