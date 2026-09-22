// Pure integer risk mathematics for Perpl positions.
//
// Every quantity is a BigInt in the contract's own fixed-point systems:
//   PNS    price  x 10^priceDecimals
//   LNS    size   x 10^lotDecimals
//   CNS    amount x 10^collateralDecimals
//   Q16    entry-price residue, 1/65536 of one PNS unit
//   hdths  margin fraction as leverage x 100 (2500 => 25.00 => 4 % of notional)
//   pct100k funding rate x 10^5 (-4 => -0.00004 per funding interval)
//
// Formulas follow perpl-sdk 0.2.8 src/state/position.rs and the Perpl
// liquidation documentation (docs.perpl.xyz/exchange/liquidation). Floating
// point never enters an invariant value; it appears only in display helpers.

export const Q16 = 65536n;
export const LONG = 0;
export const SHORT = 1;
export const MICRO = 1000000n;

export function pow10(decimals) {
  const n = Number(decimals);
  if (!Number.isInteger(n) || n < 0 || n > 77) throw new Error('INVALID_DECIMALS');
  return 10n ** BigInt(n);
}

export function side(positionType) {
  const t = Number(positionType);
  if (t === LONG) return 1n;
  if (t === SHORT) return -1n;
  throw new Error('INVALID_SIDE');
}

export function units(priceDecimals, lotDecimals, collateralDecimals) {
  return { price: pow10(priceDecimals), lot: pow10(lotDecimals), collateral: pow10(collateralDecimals) };
}

// Division rounding toward negative infinity.
export function floorDiv(a, b) {
  if (b === 0n) throw new Error('DIVISION_BY_ZERO');
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

export function absBig(a) { return a < 0n ? -a : a; }

// Effective entry price in PNS x Q16 (SDK Position::effective_entry_price).
// Long entries are stored rounded up with the residue kept separately; short
// entries are stored rounded down.
export function entryPriceQ16(positionType, pricePNS, residueQ16) {
  const price = BigInt(pricePNS), residue = BigInt(residueQ16);
  if (price < 0n) throw new Error('INVALID_PRICE');
  if (residue < 0n || residue >= Q16) throw new Error('INVALID_RESIDUE');
  if (residue === 0n) return price * Q16;
  if (Number(positionType) === LONG) return (price >= 1n ? price - 1n : price) * Q16 + residue;
  side(positionType);
  return price * Q16 + residue;
}

// Notional at the effective entry price, in CNS (floored).
export function entryNotionalCNS(entryQ16, lotLNS, u) {
  return floorDiv(BigInt(entryQ16) * BigInt(lotLNS) * u.collateral, Q16 * u.price * u.lot);
}

// Notional at an arbitrary PNS price, in CNS (floored).
export function notionalCNS(pricePNS, lotLNS, u) {
  return floorDiv(BigInt(pricePNS) * BigInt(lotLNS) * u.collateral, u.price * u.lot);
}

// Unrealized delta PnL at a PNS price, in CNS. Rounded toward zero, which is
// what the contract's getPositionV2 reports (validated live, see docs).
export function deltaPnlCNS(positionType, entryQ16, pricePNS, lotLNS, u) {
  const raw = side(positionType) * (BigInt(pricePNS) * Q16 - BigInt(entryQ16)) * BigInt(lotLNS) * u.collateral;
  return raw / (Q16 * u.price * u.lot);
}

// Maintenance margin requirement in CNS: entry notional / (hdths / 100).
export function maintenanceMarginCNS(entryQ16, lotLNS, maintMarginFracHdths, u) {
  const hdths = BigInt(maintMarginFracHdths);
  if (hdths <= 0n) throw new Error('INVALID_MARGIN_FRACTION');
  return floorDiv(BigInt(entryQ16) * BigInt(lotLNS) * u.collateral * 100n, Q16 * u.price * u.lot * hdths);
}

// Initial margin requirement in CNS from initMarginFracHdths (same shape).
export const initialMarginCNS = maintenanceMarginCNS;

// Fair market value (equity) of an isolated position, in CNS.
export function fmvCNS(depositCNS, deltaPnl, premiumPnl) {
  return BigInt(depositCNS) + BigInt(deltaPnl) + BigInt(premiumPnl);
}

// Liquidation price in micro-PNS (PNS x 10^6), floored, clamped at zero.
//   P_liq = P_entry + s * (MMR - deposit - premiumPnl) / size
export function liquidationPriceMicroPNS(positionType, entryQ16, lotLNS, depositCNS, premiumPnlCNS, mmrCNS, u) {
  const lot = BigInt(lotLNS);
  if (lot <= 0n) throw new Error('INVALID_SIZE');
  const shortfall = BigInt(mmrCNS) - BigInt(depositCNS) - BigInt(premiumPnlCNS);
  const numerator = MICRO * BigInt(entryQ16) * lot * u.collateral + side(positionType) * shortfall * u.lot * u.price * MICRO * Q16;
  const value = floorDiv(numerator, Q16 * lot * u.collateral);
  return value < 0n ? 0n : value;
}

// Bankruptcy price in micro-PNS, floored, clamped at zero.
//   P_bkpt = P_entry - s * (deposit + premiumPnl) / size
export function bankruptcyPriceMicroPNS(positionType, entryQ16, lotLNS, depositCNS, premiumPnlCNS, u) {
  return liquidationPriceMicroPNS(positionType, entryQ16, lotLNS, depositCNS, premiumPnlCNS, 0n, u);
}

// Health in basis points of the maintenance requirement: 10000 means FMV == MMR.
export function healthBps(fmv, mmr) {
  const m = BigInt(mmr);
  if (m <= 0n) return null;
  return floorDiv(BigInt(fmv) * 10000n, m);
}

// Liquidation condition from the docs: 0 < FMV <= MMR. Bankrupt: FMV <= 0.
export function classify(fmv, mmr) {
  const f = BigInt(fmv), m = BigInt(mmr);
  if (f <= 0n) return 'bankrupt';
  if (f <= m) return 'liquidatable';
  return 'healthy';
}

// Adverse move, in basis points of the mark, that reaches a target price.
// Negative means the target is already crossed. Returns null without a mark.
export function distanceBps(positionType, markPNS, targetMicroPNS) {
  const mark = BigInt(markPNS) * MICRO;
  if (mark <= 0n) return null;
  const diff = side(positionType) * (mark - BigInt(targetMicroPNS));
  return floorDiv(diff * 10000n, mark);
}

// Price after an adverse move of `bps` for the side, in PNS (floored).
export function shockedPricePNS(positionType, markPNS, bps) {
  return floorDiv(BigInt(markPNS) * (10000n - side(positionType) * BigInt(bps)), 10000n);
}

// Signed premium change caused by one funding event, in CNS.
//   premium += sign * paymentPerUnit * size, sign = -1 long, +1 short.
export function fundingPremiumDeltaCNS(positionType, fundingPaymentPNS, lotLNS, fundingSumScalingExp, u) {
  const raw = -side(positionType) * BigInt(fundingPaymentPNS) * BigInt(lotLNS) * u.collateral;
  return raw / (pow10(fundingSumScalingExp) * u.price * u.lot);
}

export function fundingRateFraction(pct100k) { return Number(pct100k) / 1e5; }

// Block of the first funding event strictly after `block` (SDK perpetual.rs).
export function nextFundingBlock(block, interval) {
  const b = BigInt(block), i = BigInt(interval);
  if (i === 0n) return b;
  return b - (b % i) + i;
}

// Exact decimal rendering of a scaled integer.
export function toDecimalString(value, decimals) {
  let v = BigInt(value);
  const negative = v < 0n; if (negative) v = -v;
  const scale = pow10(decimals);
  const whole = v / scale, frac = v % scale;
  const text = Number(decimals) === 0 ? whole.toString() : `${whole}.${frac.toString().padStart(Number(decimals), '0')}`;
  return negative ? `-${text}` : text;
}

// Float for display only.
export function toNumber(value, decimals) { return Number(toDecimalString(value, decimals)); }

export function bigintJson(_, value) { return typeof value === 'bigint' ? value.toString() : value; }
