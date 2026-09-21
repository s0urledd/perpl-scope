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
- **On-chain liquidity**: the resting book is walked from the best bid and best ask through `getNextPriceBelowWithOrders` / `getNextPriceAboveWithOrders`, reading `getVolumeAtBookPrice` at each level, at the same pinned block as the positions, up to `BOOK_LEVELS` levels per side within `BOOK_RANGE_BPS` of the mark (defaults 40 and 15 %). Only the firm `bids` / `asks` counters count as depth; the `expBids` / `expAsks` counters were observed to hold expired orders awaiting clearing and are reported separately. **Depth within k %** is the notional of levels within k % of the mark on one side. **Cover** at move k is `depth within k % ÷ liquidation notional within k %` on the side the liquidations would trade into (long liquidations sell into bids, short liquidations buy from asks). A cover below 100 % means resting orders cannot absorb the forced flow without moving through the whole measured book.
- **Stress test**: for any signed move the same ladder arithmetic is evaluated at that single shock, returning the positions hit, shortfall, insurance cover and depth in range.
- **Auto-deleveraging queue**: per side, profitable positions ranked by unrealised return on deposit (`pnl ÷ deposit`), most profitable first, as Perpl documents for ADL counterparty selection. The venue's exact ordering is off-chain, so the queue is an approximation of it.
- **Series**: every `SERIES_EVERY_BLOCKS` blocks the collector samples exchange totals and per-market notional, exposure at 10 %, shortfall, insurance, funding rate and 2 % depth into a bounded ring buffer persisted with the checkpoint.
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
| Resting depth | on-chain | Walked level by level; walk cost 40 requests for 11 markets in 2.4 s on the public RPC |
| Liquidity cover, stress test | derived | Deterministic functions of validated inputs |
| ADL queue | approximation | Ranking rule from the Perpl documentation; venue ordering is off-chain |

Not modelled: order books and resting orders, cross-margin (the venue is
isolated-margin), funding accrued between funding events, dynamic initial
margin for large sizes (reported as `dynamic_max_leverage` only).

## Activity metrics from exchange events

Position state is never derived from events, but volume, fees, flows and
wallet history can only come from them. The index decodes the following and
keeps every amount in contract units:

| Metric | Definition |
| --- | --- |
| Volume | Sum of `MakerOrderFilled(V2).pricePNS × lotLNS`, so every match is counted once. Equal to the taker side (`TakerOrderFilledV2.entryPricePNS × lotLNS`) to the unit over a 3,000-block sample. |
| Fees | Sum of maker and taker `feeCNS` on fills. Perpl charges fees on fills that build a position (open, increase, invert); reducing fills carry zero fee. The insurance / protocol split is the sum of `insFeeCNS` and `protFeeCNS` on the position events, which equalled the fill fees to the unit over the same sample. Builder fees are reported separately. |
| Trade price and size | Every user position event is immediately followed in its transaction by the fill that settled it (a maker fill for the same account or the taker fill). That fill supplies the trade price, the traded size and the fee: `PositionIncreased.pricePNS` is the blended entry price, not the trade price, and `PositionClosed` carries no size. Checked on 3,720 of 3,720 position events. |
| Active traders | Distinct accounts with a fill or position change in the window. New accounts from `AccountCreated`. |
| Flows | `CollateralDeposit` and `CollateralWithdrawal` amounts; net flow is deposits minus withdrawals. |
| Liquidations | `PositionLiquidated` count and exit-price notional; deleverages from `PositionDeleveraged(V2)`. |
| Realized PnL | `deltaPnlCNS + fundingCNS` on decreasing, closing, inverting, liquidated and deleveraged events (before fees). |
| Taker flow | Notional of taker-settled position changes split into buys (opening or increasing a long, reducing or closing a short) and sells. Long and short open interest on Perpl are equal by construction, so skew is read from taker flow and from the count, deposit and leverage of positions per side. |
| Open interest and TVL over time | `getPerpetualInfoV2` counters at the mark and `getExchangeInfo.balanceCNS`, sampled at hour boundaries (historically through archive reads where the provider keeps state). |
| Withdrawal rate limit | `getWithdrawAllowanceData(block)`: remaining allowance, expiry block and refill per block, reported with the refill per hour and the share of TVL withdrawable now. |

Windows are block ranges on the snapshot block converted with the measured
block time. A window inside the raw record window is summed exactly; longer
windows sum hourly buckets and are flagged `partial` when a bucket is missing
or incomplete.

### Wallet analytics

Records of one account are grouped into round trips per market and side: an
open starts one, increases add to it, decreases realize part of it, and a
close, inversion, full liquidation or full deleveraging ends it. A trip whose
open lies before the indexed window is marked incomplete and excluded from
hold-time statistics. Over closed trips: win rate = winning trips / closed
trips; profit factor = gross profit / gross loss; max drawdown = largest
peak-to-trough fall of cumulative realized PnL in trip order; streaks count
consecutive winning or losing trips; hold time = blocks between open and
close times the measured block time. Observations are rule-based sentences
over these numbers; no model is involved.

Validation: on 2026-09-21 the 24 h maker-fill volume ($41,345,871) agreed
with Perpl's venue-reported 24 h volume ($41,346,189) to within 0.001 %, and
every market agreed within 1 % (window alignment).
