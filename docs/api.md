# HTTP API

Base path: `/api/v1`. All responses are JSON with `cache-control: no-store`
and `access-control-allow-origin: *`. Every response carries a `snapshot`
object describing the chain state it was computed from:

```json
{
  "chain_id": "143",
  "exchange": "0x34b6552d57a35a1d042ccae1951bd1c370112a6f",
  "block": "106780799",
  "block_hash": "0x…",
  "block_timestamp": 1790003309,
  "finalized_block": "106780766",
  "block_time_ms": 302,
  "status": "fresh",
  "status_reason": null,
  "age_ms": 412
}
```

`status` is `syncing` before the first pinned snapshot, `fresh` while polls
succeed, and `stale` after repeated RPC failures, an open-interest mismatch or
no successful poll within `STALE_AFTER_MS`. While syncing every endpoint except
`/health` returns `503` with `{"error":"SYNCING"}`. The header
`x-snapshot-block` repeats the block number.

Exact amounts are decimal strings in collateral units (AUSD) or base units;
percentages and ratios are numbers.

| Endpoint | Content |
| --- | --- |
| `GET /health` | Liveness, snapshot, collector counters. Never 503. |
| `GET /overview` | Exchange totals (notional, equity, insurance, exposure at 5 % and 10 %, shortfall and coverage, liquidations in 24 h) and a summary row per market. |
| `GET /markets` | Market summaries only. |
| `GET /markets/{id}?limit=25` | Summary plus liquidation ladder, liquidation map, health distribution, per-side concentration, top positions, funding history (last 48 events) and recent liquidations. |
| `GET /markets/{id}/positions?sort=notional|risk|pnl|size&side=long|short&limit=50` | Enriched open positions. `risk` sorts by distance to liquidation. |
| `GET /markets/{id}/ladder` | Ladder and map only. |
| `GET /markets/{id}/funding?limit=48` | Current funding view (including the next announced rate when already set on-chain) and event history. |
| `GET /markets/{id}/stress?move_pct=-12.5` | Stress at one signed move: positions hit, notional, share of OI, shortfall, insurance cover, resting depth in range and its cover. Negative moves liquidate longs, positive moves shorts. |
| `GET /markets/{id}/book` | Walked order-book levels per side, depth bands and cover per ladder row. 404 until the first walk. |
| `GET /accounts/{id-or-address}` | All open positions of an account with liquidation prices, distance, health and PnL, plus free and locked balance. Resolved on-chain at the snapshot block; cached 15 s. |
| `GET /series?hours=24&market={id}` | Sampled time series of exchange totals or one market. |
| `GET /liquidations?limit=100&market={id}` | `PositionLiquidated` events, newest first, plus deleveraging events. `format=csv` downloads the list. |
| `GET /validation` | Bootstrap, reconciliation, independent discovery result, PnL agreement per market, metric status table, RPC and collector counters. |
| `GET /reference` | Perpl public-API cross-check per market (reference only). |
| `GET /events` | Parameter changes, unwind events and liquidation diagnostics seen by the collector. |

## Market summary fields

- `prices`: `mark`, `oracle`, `last`, `basis_pct` (mark versus oracle), `mark_age_seconds`, `mark_stale`.
- `open_interest`: per-side size and notional at mark, `max_size` and `utilisation_pct` from `getMarginFractions`, `reconciled` (stored positions equal contract counters).
- `long` / `short`: count, size, notional, deposit, delta and premium PnL, equity, maintenance margin, `average_leverage` (entry notional over deposit), liquidatable and bankrupt counts.
- `margin`: `max_leverage`, `maintenance_margin_pct`, raw `hdths` fractions.
- `insurance`: balance, coverage of notional and of total maintenance margin, liquidation proceeds split.
- `risk`: notional within 5 % and 10 % of liquidation, shortfall at 10 %, insurance coverage of that shortfall.
- `concentration`: top-1/5/10 shares, HHI (0–10000), largest position.
- `funding`: rate per interval, 8 h and annualised equivalents, direction, clamp, next funding block and countdown, latest event, `next_announced` when the next rate is already set on-chain.
- `liquidity`: book block and age, levels walked, truncation flags, best bid and ask, spread, depth within 1 / 2 / 5 / 10 % per side, cover at 2 / 5 / 10 % per side (`null` before the first walk). Market detail adds the full `absorption` rows and `adl_queue`.
- `validation`: `oi_reconciled`, `pnl_checked`, `pnl_agree`.
- `reference`: deltas against the Perpl context endpoint, or `null` when disabled.

## Ladder rows

Each row is an adverse move `shock_pct` of the mark. `long` counts positions
whose liquidation price is at or above the shocked price (price falling);
`short` counts positions whose liquidation price is at or below the shocked
price (price rising). `shortfall` is the negative equity of positions whose
bankruptcy price is crossed at that shocked price, and
`insurance_coverage_pct` divides the market's insurance balance by the total
shortfall (`null` when there is none).

`GET /markets/{id}/positions?format=csv` downloads the same rows as CSV.

## Position fields

`entry_price` is the effective entry including the 16-bit residue.
`liquidation_price` and `bankruptcy_price` are computed with the current
maintenance fraction and the contract's premium PnL. `health_pct` is equity
over maintenance margin; `status` is `healthy`, `liquidatable`
(0 < equity ≤ maintenance) or `bankrupt` (equity ≤ 0).
`pnl_matches_contract` reports whether the recomputed delta PnL equals the
contract's value at the mark the position was read at.
