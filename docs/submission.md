# Submission: Monad Metropolis hackathon

- **Target:** the Perpl sponsor bounty "Best Analytics / Risk Tool" (track 01,
  Onchain Finance & Trading). No other bounty is targeted.
- **Submissions:** open 2 October 2026 and close 14 October 2026, 06:59
  GMT+3.
- **Required:** a working product with a public URL, a demo, a short
  write-up and a link to the code, built during the hackathon window. This
  repository started on 12 September 2026.

## The brief, point by point

Judging criteria:
- a fast, modern, dark-mode UI;
- real-time data;
- a seamless switch between the protocol view and a wallet;
- signal over clutter.

### Protocol view

| Brief | Where |
| --- | --- |
| Volume, open interest, TVL, fees / revenue, active users over 24h / 7d / 30d / all time | Overview KPIs with the window switch, each compared with the previous period (open interest and TVL: change within the window) and with a sparkline (`/api/v1/protocol`) |
| Time-series charts with timeframes | Volume by market (per period or cumulative), open interest, TVL, net deposits, active traders, fees, liquidations; hourly, 4-hourly or daily by window; CSV and PNG download (`/api/v1/protocol/series`) |
| Deposit / withdrawal flows | Net deposits chart; latest deposits and withdrawals; per-wallet flows tab (`/api/v1/flows`) |
| Per-market breakdown, long / short skew | Markets table and market pages. Perpl's long and short open interest are equal by construction, so skew is shown as the share of positions per side, average leverage per side and taker buy share |
| Liquidations | Liquidations page, liquidations chart by market, latest liquidations on the overview, liquidation ladder per market |
| Funding | Funding per 8 h and APR in every market row; a markets × time funding map on the Markets page; funding history and the next funding block on each market page |
| Market share (optional) | Not built: no neutral on-chain source for other venues (DefiLlama's API became paid) |

### Wallet view

| Brief | Where |
| --- | --- |
| Address search → full profile | Header search (`/`): address, prefix or account ID |
| Open positions: size, entry, leverage, unrealized PnL, liquidation price | Wallet page, from contract state at the latest finalized block |
| Trade history and realized PnL | Trade history tab with fill prices, role and realized PnL; CSV; round trips tab |
| Win rate, profit factor, max drawdown, streaks, hold time, best / worst markets | Performance panel and KPI strip |
| Save / watch / compare wallets | Star on any trader; Watchlist; Compare up to five wallets with overlaid PnL curves |
| Portfolio and margin overview | Account value, free and locked balance, margin usage, leverage, closest liquidation |
| Behavioural insights (optional) | Behaviour panel: rule-based notes and a weekday × hour activity map |

### Beyond the brief

- **Rank of any wallet** by PnL and by volume among the accounts that traded
  in the window, for 24h,
  7d, 30d and all time.
- **Trade actions** (open, add, reduce, close, flip, liquidated) on every
  tape, with a size filter.
- **Risk measured from the contract:**
  - notional at risk and bad debt for a market-wide move, with each market's
    insurance cover;
  - liquidation ladder per market;
  - order-book absorption and the cost of a market order, walked from the
    on-chain book;
  - stress test;
  - in the API: liquidation map and an estimated auto-deleveraging order.
- **PnL as the contract settles it:** funding realized at position
  increases and liquidation fees are counted, which event PnL alone misses.
- **Integrity checks:**
  - open interest and TVL rebuilt from every event since launch are
    compared with the contract's own counters;
  - the decoder's linking counters and the collector's reconciliation are
    on the status page.
- **Self-hosted on a Monad node:**
  - execution events via Monode: proposed-block trades on the tape within
    milliseconds, finalized data about a second after the block;
  - no dependency on Perpl's API or any third-party indexer.

## Demo (about three minutes)

1. **Header.** Point out the live pill: finalized block number and age. The
   indexing banner goes away once history is complete.
2. **Overview, 24h:**
   - read the KPI strip (volume, open interest, TVL, fees, traders,
     liquidations) with the change on the previous day;
   - toggle a market in the volume chart and switch to cumulative;
   - hover a chart and download it as CSV;
   - show the live tape with trade actions and the size filter;
   - switch the window to 30D and All.
3. **Markets.** Sort by open interest and read the skew bars. Scroll to the
   funding map and hover a cell. Open BTC to show candles, positioning, the
   funding history with its countdown, and the liquidation ladder.
4. **Traders.** Top PnL for 7D, then Top losses. Star a wallet.
5. **Wallet.** Open the top trader:
   - positions with liquidation prices and the By period table with ranks;
   - the PnL curve and the performance panel;
   - the behaviour notes and the trade history, exported as CSV.

   Add it to Compare with a second wallet.
6. **Risk.** Drag the stress slider to −10 % on BTC: positions hit, bad debt,
   insurance and book cover.
7. **Status page:**
   - the pipeline (live ingest, backfill, rollups);
   - the integrity check against the contract;
   - the decoder's counters.
8. **Close.** Every number comes from a Monad node: events since launch and
   contract state, both at finalized blocks, and both cross-checked.

## Checklist

- [ ] Deploy on the Huginn RPC host with `docker compose` and put the
      dashboard behind TLS (`docs/runbook.md`).
- [ ] Enable the execution event ring and the `exec-events` profile.
- [ ] Wait for the backfill to complete, then confirm on the status page
      that the integrity check passes.
- [ ] Refresh the screenshots in `docs/images/` from the deployment.
- [ ] Record the demo while the dashboard is live, so the block number
      advances.
- [x] Make the repository public (also restores free CI minutes).
- [ ] Link the repository in the project profile.
- [ ] Write-up: the README's opening and "Why the numbers hold".

## Claims and their evidence

| Claim | Evidence |
| --- | --- |
| Every figure comes from Monad chain data | Ingest and collector read only the node and archive RPCs; `src/reference.js` (Perpl API) is off by default and used only for comparison |
| Windows are exact sums, and partial windows say so | `meta.coverage` on every windowed response; `docs/methodology.md` |
| Trade prices, sizes and fees come from the settling fills | Full history: 33,557,868 / 33,557,868 position events linked; 18,630,950 / 18,630,950 fee splits equal |
| Event history reproduces the contract | 67 million events since launch give open interest equal to the contract for all 11 markets, and TVL equal to the micro-dollar (`docs/evidence/integrity-2026-09-23.json`, live at `/api/v1/integrity`) |
| Live positions match the contract | Reconciliation every poll; independent rescan hourly (`/api/v1/validation`) |
| PnL and funding formulas match the contract | `docs/validation-gate.md` (557 / 557, 208 / 208) |
| 24 h volume matches Perpl's own figure | Within 0.001 % on 2026-09-21 and 0.035 % on 2026-09-23 (all markets within 0.1 %) |
| A liquidation's result is the trader's balance change | The trader gets back exactly 80 % of the remaining margin (`accAmountCNS`), e.g. at block 107,162,461; the rest is counted as a fee (`test/decode.test.js`) |
| Fees are not double counted | A builder's share is inside the fill fee and the protocol part on all 1.6 million fills that carry one (checked in ClickHouse, 2026-09-23) |

Claims to avoid:
- exact prediction of liquidation execution prices;
- market share against other venues;
- anything about accounts or periods the status page shows as not yet
  indexed.
