# Landscape

Reviewed 2026-09-21 and 2026-09-23. Captures were taken in dark mode at
desktop and phone widths. The open-source ones (gmx-stats, gmx-interface,
hyperliquid-stats, perps-observatory) were read alongside.

## Perp analytics dashboards

| Product | Venue | What it does well | What Plumb takes from it |
| --- | --- | --- | --- |
| stats.nado.xyz | Nado | One hue per chart with a grey cumulative line; KPIs directly above their chart; tooltips with a date header and a net row | Per-period / cumulative switch; KPI-over-chart rhythm; tooltip layout |
| HyperScreener (ASXN) | Hyperliquid | Hero cards with deltas and background sparklines; section labels with hairline rules; chart screenshots | KPI strip with deltas (inverted colours where rises are bad) and sparklines; section labels |
| LighterDash | Lighter | Liquidation and analytics pages; averages drawn as dashed lines | Liquidations page layout (and a warning: its liquidation dates show a seconds-vs-milliseconds bug) |
| GMX stats and account pages | GMX | Performance by period; share cards; CSV links on every chart; "updated at block N" | By-period table with ranks; CSV and PNG on the charts; block and age in the header |
| Hyperdash, Hypurrscan | Hyperliquid | Cohorts; labelled fills (open, add, reduce, close, flip); size filters | Trade actions and size filter on the live tapes |
| CoinGlass | Centralised venues and Hyperliquid | Funding heatmaps; liquidation heatmaps (modelled) | Markets × time funding map on a diverging scale; measured liquidation ladder instead of a modelled heatmap |
| Gains, Orderly, Paradex, Synthetix stats | Their venues | Protocol totals, leaderboards | Leaderboard sorts and CSV |

## Risk tools

| Tool | Positions | Liquidation levels | Liquidity | Validation |
| --- | --- | --- | --- | --- |
| CoinGlass, CoinMarketCap liquidation maps | Not observable | Estimated from open-interest changes and price | No | No |
| Hyperliquid dashboards (TapeSurf, HypurrTrade, Hypurrscan) | From the venue's API | Per position | Partial (venue API) | No |
| Chaos Labs risk portals | Indexed | At-risk positions | Informs parameters | Internal |
| Perpl app | Own account | Own positions | Order book | Venue-reported |
| **Plumb** | **Read from the contract at a pinned block** | **Per position, from the documented formulas (delta PnL checked against the contract)** | **Resting depth walked from the on-chain book** | **Reconciliation every poll, independent rescan, event history checked against the contract** |

## What only Plumb shows

1. **Measured, not modelled, liquidation risk.** The ladder of notional
   liquidated per adverse move, the bad debt past bankruptcy and whether the
   market's insurance fund covers it. The positions are read from the
   contract, not inferred.
2. **Order-book cover.** Perpl's order book is a contract, so the resting
   depth a liquidation cascade would trade through is read from chain state
   (every 30 s, at its own block) and set against the liquidations each
   move would force, market by market and side by side.
3. **A wallet's rank in every window**, next to its PnL, volume and
   performance.
4. **History that reproduces the contract.** Open interest and net flows
   summed from every event since launch are checked against the contract's
   own counters.

## Design language

The page follows the dark Perpl and Monad look:
- black page (`#000`) with near-black panels (`#0e0d10`, `#121113`);
- the Geist typeface, served locally;
- lilac and purple accents (`#a2a4ff`, `#6f5cff`).

Data colours come from a categorical palette validated for colour-vision
deficiency against the dark surface:
- market series use `#7b7dea`, `#d36c00`, `#00a999`, `#b28500`, `#cd5ea2`
  and `#0098de`, with grey `#5c5b66` for Other;
- colours follow each market's all-time volume rank and never change with
  filters.

Long and short use `#81c784` and `#f65a6e`. Funding uses a diverging
blue–orange pair around a grey midpoint. Every chart has a legend or labels,
a tooltip and a CSV or PNG download (the liquidation ladders are PNG only),
so no reading depends on colour alone. The page states that it is
unofficial and does not use Perpl's logo; market rows show each asset's own
logo (MON's is the Monad mark, from the Monad token list).
