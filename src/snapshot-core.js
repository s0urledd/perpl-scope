export function bitmapIds(words) {
  return words.flatMap((word, index) => Array.from({ length: 256 }, (_, bit) =>
    (BigInt(word) & (1n << BigInt(bit))) !== 0n ? index * 256 + bit : null).filter(x => x !== null));
}
// Account bitmap reserves the top 3 bits of bank1. Its offsets differ from
// getPerpetualExistsBitmap. Verified against SDK 0.2.5 state/account.rs.
export function accountMarkets(bitmap) {
  return [[0, 253, bitmap.bank1], [253, 256, bitmap.bank2], [509, 256, bitmap.bank3], [765, 256, bitmap.bank4]]
    .flatMap(([offset, length, word]) => Array.from({ length }, (_, bit) =>
      (word & (1n << BigInt(bit))) !== 0n ? offset + bit : null).filter(x => x !== null));
}
export function reconcile(positions, expectedLong, expectedShort) {
  let long = 0n, short = 0n;
  const seen = new Set();
  for (const p of positions) {
    if (seen.has(String(p.accountId))) throw new Error('DUPLICATE_ACCOUNT');
    seen.add(String(p.accountId));
    if (p.lotLNS === 0n) continue;
    if (p.positionType === 0) long += p.lotLNS;
    else if (p.positionType === 1) short += p.lotLNS;
    else throw new Error('UNKNOWN_POSITION_TYPE');
  }
  return { long, short, expectedLong, expectedShort, matches: long === expectedLong && short === expectedShort };
}
