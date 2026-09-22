# Submission — Monad Metropolis hackathon

Deadline 14 October 2026, 06:59 GMT+3. Requirements: a working product with a
public project profile, a demo, a short write-up and a link to the code; work
built during the six-week window (this repository started 12 September 2026).

Target: sponsor bounty **"Best Analytics / Risk Tool" (Perpl)**, track 01
**Onchain Finance & Trading**. This is the only bounty the product targets.

## The brief, point by point

Judging: fast, modern, dark-mode UI; real-time or near-real-time data; a
seamless switch between protocol view and wallet drill-down; signal over
volume.

| Brief | Where it is |
| --- | --- |
| Headline metrics: volume, open interest, TVL, fees / revenue, active users over 24h / 7d / 30d / all-time | Overview tiles with the 1h / 24h / 7d / 30d / All switch (`GET /stats?window=`) |
| Time-series charts with timeframe switching | Overview charts (volume, open interest and TVL, flows, active traders, liquidations, taker flow) binned per hour, six hours or day by window (`GET /stats/series`) |
| Deposit / withdrawal flows and net capital inflows | Net flows tile, flows chart, per-wallet flow table |
| Breakdown by market or asset, long / short skew | Markets table: volume share, open interest, long / short position skew, taker buy share, funding, liquidations, fees, realized PnL |
| Liquidation data and funding rate overview | Liquidations page (per period, by market, feed with CSV), market pages (ladder, map, funding history, next rate) |
| Market share versus other perps (optional) | Not built; see docs/landscape.md for the comparison of tools |
| Global address search → full wallet profile | Header search accepts a 0x address or account ID (`GET /accounts/{key}`) |
| Open positions with size, entry, leverage, unrealized PnL, liquidation price | Wallet page, positions table (contract state at the snapshot block) |
| Historical trade list and realized PnL | Wallet page history (fill-settled prices, role, fee) and realized PnL tiles; `GET /accounts/{key}/trades?format=csv` |
| Performance: win rate, profit factor, max drawdown, streaks, hold time, best / worst markets | Wallet page tiles, equity curve, performance by market, round trips |
| Save / watch / compare wallets side by side | Star on any wallet or leaderboard row; Watchlist page compares up to twelve |
| Portfolio and margin overview | Account value, free / locked balance, margin usage, effective leverage, closest liquidation |
| AI-driven or behavioral insights (optional) | Rule-based observations on every wallet page (no model, so every sentence is traceable to a number) |
| Real-time data | Collector polls the head every 2 s (blocks are 0.3 s); pages refresh every 5–10 s; every response carries the block it was computed from |
| Dark mode, no clutter | Dark by default, Perpl's typeface and accents, validated colour palette, one idea per card, tables behind every chart |

## Checklist

- [ ] Deploy the service to a public URL with a persistent volume
      (`docs/runbook.md` § Deploy) behind the team's Monad node, and put the
      URL in the project profile.
- [ ] Record the demo following `docs/demo.md`; keep the dashboard live in the
      recording so the block number advances.
- [ ] Write-up: use the README's first sections and the evidence table.
- [ ] Link the repository and `docs/validation-gate.md`.
- [ ] Register the team and confirm country eligibility on the platform.

## Claims that can be made, and their evidence

| Claim | Evidence |
| --- | --- |
| Every metric is computed from chain state and events at a pinned block | `snapshot` on every response; hash re-check in the collector |
| Volume, fees and flows are exact sums, not estimates | `docs/methodology.md` § Activity metrics; `coverage.exact` on `GET /stats` |
| The on-chain 24 h volume matches Perpl's own figure | Validation page, venue table: −0.001 % in total on 2026-09-21 |
| Open interest is reconciled to the contract on every poll | `GET /validation` → `reconciliation` |
| Position discovery is verified by an independent path | `verification` (account-bitmap rescan) |
| PnL and funding formulas match the contract on live data | `docs/validation-gate.md` (557/557, 208/208) |
| Liquidation formulas follow Perpl's documentation and SDK | `docs/methodology.md`; classification agrees with observed liquidations |
| Perpl's API is not an input to any metric | `src/reference.js` is comparison only |

Claims to avoid: all-time volume (the index reaches as far as the RPC history
and the persisted aggregates), exact prediction of liquidation execution
prices, and completeness of wallet history before the indexed window. Each
page states its coverage instead.
