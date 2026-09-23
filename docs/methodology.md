# Methodology

Version 2 (2026-09-23). PerplScope uses two sources, both read at finalized
blocks:

- **History** (volume, fees, flows, liquidations, funding payments, realized
  PnL, wallet trades) is summed from the exchange's own events since its
  deployment, decoded once into ClickHouse (see the second half of this
  document).
- **Current state** (positions, liquidation prices, open interest, TVL,
  insurance, the order book) is read from the contract at one pinned block.
  The block number, hash and freshness accompany every response.

Perpl's public API is never an input.

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
- **Exchange totals** sum the per-market values.

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
| Resting depth | on-chain | Walked level by level; walk cost 40 requests for 11 markets in 2.4 s on the public RPC. Depth past a walk that hit its level cap is a lower bound (`complete: false`, shown as "≥") |
| Liquidity cover, stress test | derived | Deterministic functions of validated inputs |
| ADL queue | approximation | Ranking rule from the Perpl documentation; venue ordering is off-chain |
| Trade price, size and fee from linked fills | validated | 154,264 / 154,264 position events linked over 400,000 blocks, no size mismatch; fee split equals the fill fee on every building fill |
| Volume | validated | 24 h maker-fill volume within 0.001 % of Perpl's venue figure (2026-09-21) |
| Open interest from events | validated | Event deltas equal the contract's counters for all 11 markets (400,000 blocks); rechecked from launch by `/api/v1/integrity` |

Not modelled: individual resting orders (only aggregate depth per price
level), cross-margin (the venue is isolated-margin), funding accrued between
funding events, dynamic initial margin for large sizes (reported as
`dynamic_max_leverage` only).

## History metrics from exchange events

Every figure below is a sum over decoded exchange events for the requested
window. Each metric has one definition (`src/aggregates.js`), used both for
hourly rollups and for raw rows, so a window gives the same answer however it
is assembled. All amounts stay in contract units (integers) until they are
formatted for display.

**Trade price, size and fee.** A position event does not carry the price it
traded at (`PositionIncreased.pricePNS` is the blended entry price) and
`PositionClosed` carries no size. Every position event is immediately
followed in its transaction by the fill that settled it: a maker fill for the
same account and market, or the aggressor's taker fill. The decoder links
them and takes price, size and fee from the fill. On 400,000 live blocks,
154,264 of 154,264 position events linked, with no size mismatch. A
liquidation executed on the book reports its taker fill before
`PositionLiquidated`, and is linked the same way. `PositionInverted` carries
the new side.

| Metric | Definition |
| --- | --- |
| Volume | Sum of maker-fill notional (`MakerOrderFilled(V2)`, price × size), so each match counts once. It equals the taker side to the unit. |
| Trades | Position changes (open, increase, decrease, close, invert). Per account, liquidations settled as taker also count. |
| Fees | Sum of `feeCNS` on maker and taker fills. Fees are charged on fills that build a position (open, increase, invert). Their split into insurance fund (`insFeeCNS`) and protocol (`protFeeCNS`) comes from the position event, and must equal the fill fee; this is checked on every building fill at ingest. Builder fees are reported separately. Take rate is fees ÷ volume. |
| Active traders | Distinct accounts with at least one trade in the window (each account once per window or chart bucket). |
| New accounts | `AccountCreated` events. |
| Deposits, withdrawals, net flow | `CollateralDeposit` and `CollateralWithdrawal` amounts; net flow is deposits − withdrawals. |
| Liquidations | `PositionLiquidated`: count, and notional as liquidated size × liquidation price. Deleverages come from `PositionDeleveraged(V2)`. |
| Realized PnL | `deltaPnlCNS + fundingCNS` on decrease, close, invert, liquidation and deleverage events, before fees. **Net PnL** = realized − fees. |
| Taker buy share | Taker notional of position changes that buy (opening, adding to or flipping into a long; reducing or closing a short) ÷ all taker notional. Long and short open interest are equal on a matched book, so this is where directional pressure shows. |
| Price, OHLC, change | Fill prices per market and bucket. Change is the last fill price of the window against the first. |
| Open interest over time | Running sum since launch of each market's open-interest change (open and increase add, decrease, close, liquidation and deleverage remove; invert moves size across sides), priced at the last fill of each bucket. It is drawn only when history is contiguous from launch. The headline figure is the contract's counter at the mark. |
| TVL over time | Running sum since launch of user and protocol deposits minus withdrawals. Trading moves collateral between accounts inside the contract, so only transfers change the contract's balance. |
| Window comparison | A window is `[head − length, head]`. `prev` is the preceding window of the same length; `change_pct` = (value − prev) ÷ prev. All-time starts at the first indexed block. |
| Coverage | Every windowed response states whether indexed history covers the whole window. A partial window is labelled, never silently short. |

**Integrity.** Summing every event since launch must reproduce the contract:
per market, the event-derived open interest equals `longOpenInterestLNS` and
`shortOpenInterestLNS`, and the net flow equals the exchange's collateral
balance at the same block. `GET /api/v1/integrity` and the status page run
this check. On 400,000 blocks of live data the event-derived open-interest
deltas equalled the contract's counters for all 11 markets.

### Funding

The current rate is the contract's `fundingRatePct100k` per funding interval
(8,571 blocks). The 8 h and annual equivalents scale it by the interval
length measured from block timestamps. History comes from
`FundingEventCompleted`: rate, funding price, payment per unit and cumulative
sum per market.

### Wallet analytics

- **Round trips.** Perpl margins each market in isolation, so an account has
  at most one position per market. A trip opens with an open and grows with
  increases. It realizes PnL on decreases and ends with a close, a full
  liquidation or a full deleverage. A flip ends the trip and starts one on
  the other side. A trip's net result is realized PnL (funding included)
  minus fees. A trip opened before the indexed history is marked incomplete
  and left out of hold-time statistics.
- **Performance** over closed trips:
  - win rate = winning trips ÷ closed trips;
  - profit factor = gross profit ÷ gross loss;
  - expectancy = mean net per trip;
  - max drawdown = largest peak-to-trough fall of cumulative net PnL in trip
    order, with its dates;
  - streaks count consecutive wins or losses;
  - hold time = close time − open time (mean, median, winners, losers);
  - best and worst market by net PnL.

  For very active wallets, trips are built from the latest 150,000 events
  and the response says so. Totals, per-market sums and period ranks always
  use full history.
- **Periods and ranks.** For the last 24 h, 7 d, 30 d and all time: volume,
  trades, net PnL, PnL per volume (bps), and the wallet's rank by net PnL and
  by volume. The rank is 1 + the number of accounts with a strictly higher
  value, among accounts with at least one trade in the same window. The rank
  tables are recomputed every minute.
- **Behaviour** notes are rule-based sentences over these numbers (style,
  discipline, streaks, leverage, timing); no model is involved, so every
  sentence traces to a figure on the page.
- **Leaderboard** ranks accounts over any window by net PnL, losses, volume,
  realized PnL, fees, trades, liquidated notional or flows. PnL per volume is
  shown next to PnL, so large PnL from large volume can be told apart from an
  edge.

### Earlier cross-check

On 2026-09-21 the 24 h maker-fill volume ($41,345,871) agreed with Perpl's
venue-reported 24 h volume ($41,346,189) to within 0.001 %, and every market
agreed within 1 % (window alignment). The same volume rule is used here.
