export function sizeState(snapshot) {
  return new Map(snapshot.markets.flatMap(m => m.positions.map(p => [`${m.id}:${p.accountId}`, { lot: BigInt(p.lotLNS), side: Number(p.positionType) }])));
}
export function applySizeEvent(state, name, args) {
  const supported = ['PositionOpened', 'PositionOpenedV2', 'PositionIncreased', 'PositionIncreasedV2', 'PositionDecreased', 'PositionClosed', 'PositionInverted', 'PositionLiquidated', 'PositionDeleveraged', 'PositionDeleveragedV2', 'PositionUnwound', 'PositionUnwoundV2', 'PositionUnwoundWithoutPayment', 'PositionUnwoundWithoutPaymentV2'];
  if (!supported.includes(name)) {
    if (/^Position(Inverted|Liquidated|Deleveraged|Unwound)/.test(name)) throw new Error('UNSUPPORTED_SIZE_EVENT');
    return false;
  }
  const key = `${args.perpId}:${args.accountId ?? args.posAccountId}`, existing = state.get(key);
  const side = Number(args.positionType);
  if (![0, 1].includes(side)) throw new Error('INVALID_SIDE');
  if (name.startsWith('PositionOpened')) {
    if (existing) throw new Error('POSITION_ALREADY_OPEN');
    if (args.lotLNS <= 0n) throw new Error('INVALID_SIZE');
    state.set(key, { side, lot: args.lotLNS });
  } else {
    if (!existing || (name === 'PositionInverted' ? existing.side === side : existing.side !== side)) throw new Error('POSITION_PRECONDITION_FAILED');
    if (name === 'PositionClosed' || name.startsWith('PositionUnwound')) state.delete(key);
    else {
      if (args.startLotLNS !== undefined && existing.lot !== args.startLotLNS) throw new Error('START_SIZE_MISMATCH');
      const endLot = name === 'PositionLiquidated' ? args.posLotLNS : args.endLotLNS;
      if (endLot === 0n) state.delete(key);
      else state.set(key, { side, lot: endLot });
    }
  }
  return true;
}
export function canonicalSizes(state) {
  return JSON.stringify([...state].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) =>
    [key, value ? [String(value.lot), value.side] : null]));
}
