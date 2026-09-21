# Methodology

Version: risk-v1 (2026-09-21). Supersedes preflight-v0. Every metric below is
computed from Monad chain state at one pinned block; the block number, hash and
freshness accompany every API response.

## Units

The contract stores fixed-point integers. PerplScope keeps them as BigInt and
converts only for display.

| Suffix | Meaning |
| --- | --- |
| PNS | price × 10^priceDecimals |
| LNS | size × 10^lotDecimals |
| CNS | collateral × 10^collateralDecimals (AUSD, 6) |
| Q16 | entry-price residue, 1/65536 of one PNS unit |
| hdths | margin fraction as leverage × 100 (`2500` ⇒ 25.00 ⇒ 4 % of notional) |
| pct100k | funding rate × 10^5 (`-4` ⇒ −0.00004 per funding interval) |

Effective entry price follows `perpl-sdk` `Position::effective_entry_price`:
long entries are stored rounded up and the residue is subtracted
(`(pricePNS − 1) + residue / 65536`), short entries are stored rounded down
(`pricePNS + residue / 65536`); with a zero residue the stored price is exact.

## Position quantities

- Notional at price P: `N = P × size`.
- Delta PnL: `side × (mark − entry) × size`, rounded toward zero. This matches
  the contract's `getPositionsV2.deltaPnlCNS` exactly (557 / 557 live).
- Premium PnL is the contract's `premiumPnlCNS` (cumulative funding). Its
  change across a funding event equals `−side × payment × size`, where
  `payment = fundingPaymentPNS / 10^(fundingSumScalingExp + priceDecimals)`;
  positive payments flow from longs to shorts (208 / 208 live).
- Equity (fair market value): `FMV = deposit + deltaPnl + premiumPnl`.
- Maintenance margin requirement: `MMR = entry × size ÷ (maintHdths / 100)`,
  using the market's current `getMarginFractions` value.
- Liquidation condition (Perpl docs): `0 < FMV ≤ MMR`; bankrupt when `FMV ≤ 0`.
- Health: `FMV ÷ MMR` in basis points.
- Liquidation price: `P_liq = entry + side × (MMR − deposit − premiumPnl) ÷ size`,
  clamped at zero; `side` is +1 for longs and −1 for shorts.
- Bankruptcy price: `P_bkpt = entry − side × (deposit + premiumPnl) ÷ size`.
- Distance to liquidation: adverse move of the mark, in basis points, that
  reaches `P_liq`; negative means already crossed.
- Leverage: entry notional over deposit; effective leverage: mark notional
  over equity.

Both price formulas come from docs.perpl.xyz/exchange/liquidation and
`perpl-sdk` `src/state/position.rs` (`liquidation_price`, `bankruptcy_price`).
Liquidation prices are reported in micro-PNS and floored. Positions liquidated
on-chain are checked against this classification on every validation run.

## Market aggregates

- **Open interest**: sum of stored sizes per side. Must equal
  `longOpenInterestLNS` / `shortOpenInterestLNS` at the same block; any
  difference marks the state stale. On a matched order book both sides are
  equal by construction, so exposure is analysed per side rather than as a
  long/short ratio.
- **Liquidation ladder**: for each adverse move `k` in
  {0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50} %, the count and mark notional of
  positions whose liquidation distance is ≤ `k`, per side. **Shortfall** at
  `k` is the sum of `max(0, −FMV(P_k))` over positions whose bankruptcy price
  is crossed at the shocked price `P_k`; it is the bad debt that would arise
  if no liquidation executed before the move. **Insurance coverage** divides
  the market's `insuranceBalanceCNS` by that shortfall.
- **Liquidation map**: mark notional of positions binned by the signed
  distance of their liquidation price from the mark, 50 bps bins over ±30 %;
  positions beyond the range are reported as tails.
- **Health distribution**: notional and count per health bucket
  (<100 %, 100–125, 125–150, 150–200, 200–300, 300–500, >500 %).
- **Concentration**: top-1/5/10 shares of mark notional and HHI (sum of
  squared shares, 0–10000) for all positions and per side.
- **Insurance**: balance relative to total notional and to total maintenance
  margin; liquidation proceeds split from `getLiquidationInfo`.
- **Funding**: `fundingRatePct100k / 10^5` per funding interval; the 8 h and
  annualised equivalents scale by the measured block time (from block
  timestamps over the last 1000 blocks) and `getFundingInterval` (8571
  blocks). Next funding block: `block − block mod interval + interval`.
  History from `FundingEventCompleted` (rate, funding price, payment per unit,
  cumulative sum).
- **Basis**: `(mark − oracle) / oracle`.
- **Exchange totals** sum the per-market values; `liquidations_24h` counts
  `PositionLiquidated` events within the last 24 h of blocks.

## Validation status per metric

| Metric | Status | Evidence |
| --- | --- | --- |
| Open interest | validated | Exact per side at every poll; independent account-bitmap rescan agrees |
| Delta PnL | validated | 557 / 557 positions equal the contract (truncation) |
| Premium PnL | validated | Contract value; funding formula 208 / 208 across live events |
| Funding history | validated | `getFundingSumAtBlock` equals emitted sums where state was available |
| Liquidation classification | validated on available samples | Every on-chain liquidation with retained state was classified liquidatable (health 99.08 %) |
| Liquidation price | formula | Documentation and SDK; direct contract diagnostics (`CantLiquidatePosAboveMMR`) not observed in the sampled windows |
| Ladder, map, shortfall, coverage | derived | Deterministic functions of the validated inputs above |
| Concentration, health | derived | Deterministic |
| Insurance balances | on-chain | `getPerpetualInfoV2` |

Not modelled: order books and resting orders, cross-margin (the venue is
isolated-margin), funding accrued between funding events, dynamic initial
margin for large sizes (reported as `dynamic_max_leverage` only).
