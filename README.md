# PerplScope

**Independent analytics and risk monitor for [Perpl](https://perpl.xyz) on Monad.**
Volume, open interest, TVL, fees, flows, liquidations and funding at protocol
level; full wallet profiles with trade history, realized PnL, performance
analytics and a watchlist; and the liquidation-risk analysis a venue's own UI
does not show. Everything is computed from the exchange contract and its
events at a pinned block, and continuously checked against the contract's own
counters and against Perpl's public figures.

[![ci](https://github.com/s0urledd/perpl-scope/actions/workflows/ci.yml/badge.svg)](https://github.com/s0urledd/perpl-scope/actions/workflows/ci.yml)

![PerplScope overview](docs/images/overview.png)

## Protocol view

Headline metrics with a 1h / 24h / 7d / 30d / all-time switch, each figure
labelled with how much of the window the index covers:

- **Volume** as the sum of maker-fill notional (each match counted once). On
  2026-09-21 the 24 h figure agreed with Perpl's own venue-reported volume to
  within 0.001 % in total and within 1 % per market.
- **Open interest and TVL** now and over time (sampled from the contract at
  every hour boundary), with the change against the start of the window.
- **Fees** with the maker / taker split and the on-chain insurance / protocol
  split, plus the effective take rate.
- **Active traders** and new accounts, **deposits, withdrawals and net capital
  flows**, **liquidations** (count and notional) and traders' realized PnL.
- **Breakdown by market**: volume share, open interest, long / short position
  skew, taker buy share, funding, liquidations, fees and realized PnL.
- **Taker flow**: aggressor buys against sells per period. Perpl's long and
  short open interest are equal by construction, so this is where skew shows.
- **Funding overview** per market: current rate, 8 h and annualised
  equivalents, countdown to the next funding block and event history.

## Wallet view

Search any address or account ID from the header, or click a row anywhere:

- **Portfolio**: account value, free and locked balance, open positions with
  entry, mark, liquidation price, distance, leverage, health and unrealized
  PnL, margin usage and effective leverage.
- **History**: every position change with the price of the fill that settled
  it, role (maker or taker), size, notional, realized PnL and fee, plus
  deposits and withdrawals; CSV export.
- **Performance**: win rate, profit factor, gross profit and loss, max
  drawdown, best / worst streaks, average and median hold time, long share,
  largest win and loss, best and worst markets, cumulative realized PnL curve,
  and round trips per market and side.
- **Observations**: plain-language, rule-based reading of the numbers.
- **Watchlist and compare**: star wallets on any page and see them side by
  side; the list stays in the browser.
- **Traders leaderboard** by realized PnL, losses, volume, trades, fees,
  liquidations, deposits or withdrawals for any window.

![Wallet profile](docs/images/wallet.png)

## Risk view

- **Liquidation ladder** and **liquidation map** per market, with the
  shortfall beyond bankruptcy at each move and the insurance fund's cover.
- **On-chain liquidity versus liquidation demand**: the resting order book is
  walked from the contract at the same block, so each move shows whether the
  bids or asks in range could absorb the forced flow.
- **Stress test** slider, **auto-deleveraging queue**, position health,
  concentration, insurance coverage and the **withdrawal rate limit**
  (remaining allowance, refill rate, share of TVL withdrawable now).
- A **validation page** with the live checks, the event-index status and the
  venue cross-check.

Everything is served as a JSON API (`/api/v1/...`) and a dependency-free
dashboard.

## How it stays honest

1. **Pinned reads.** Every value in a snapshot comes from `eth_call` at one
   block whose hash is re-checked before the snapshot is published.
2. **Positions from getters, never from events.** The contract's paged
   `getPositionsV2` provides the bootstrap; afterwards each block's exchange
   events only name the positions to re-read.
3. **Reconciliation every poll.** Stored positions summed per side must equal
   `getPerpetualInfoV2` open-interest counters at the same block, or the state
   is marked stale and rebuilt.
4. **Independent discovery.** Periodically every account is rescanned through
   its position bitmaps, an enumeration path that shares nothing with the
   paged getter, and compared with the stored positions.
5. **Exact activity metrics.** Volume, fees, flows and wallet history are sums
   over exchange events with the trade price taken from the fill log that
   settles each position change; nothing is estimated. Each window states
   whether it is an exact sum, an hourly aggregate, or partial.
6. **Formula validation on live data.** Delta PnL is recomputed and compared
   with the contract for every open position; funding premium changes were
   checked across live funding events; liquidation classification was checked
   against actual on-chain liquidations. See [validation evidence](docs/validation-gate.md).

| Check (mainnet, 2026-09-21) | Result |
| --- | --- |
| Open interest, paged positions vs contract counters, 11 markets | exact |
| Independent account-bitmap rescan vs stored positions, 5,311 accounts | agrees |
| Delta PnL recomputed vs `getPositionsV2`, 557 positions | 557 / 557 |
| Premium PnL change across live funding events, 208 positions | 208 / 208 |
| 24 h volume from maker fills vs Perpl venue-reported volume | −0.001 % total, within 1 % per market |
| Fill fees vs insurance + protocol fee splits in position events, 3,000 blocks | equal to the unit |
| Perpl public API vs contract: margins, funding rate and sum | match |

## Quick start

Requires Node.js 22.9 or later and an HTTPS Monad JSON-RPC endpoint. The
public `https://rpc.monad.xyz` works for the live snapshot (100-block
`eth_getLogs` limit, recent state only); a node that serves 1000-block log
ranges and a few days of history fills the activity index in about two
minutes (see [runbook](docs/runbook.md)).

```bash
npm ci
cp .env.example .env        # set MONAD_RPC_URL
npm test                    # offline tests, fixtures only
npm start                   # collector + API + dashboard on http://localhost:8787
```

The first snapshot takes a few seconds; the header shows the block, freshness
and age of the state every page is computed from. The event index backfills in
the background and every window says how far back it reaches.

Docker:

```bash
docker build -t perpl-scope .
docker run -p 8787:8787 -v perpl-data:/data -e MONAD_RPC_URL=https://rpc.monad.xyz perpl-scope
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONAD_RPC_URL` | required | HTTPS JSON-RPC endpoint; never logged |
| `CHAIN_ID` | `143` | Expected chain |
| `EXCHANGE_ADDRESS` | mainnet Perpl exchange | Contract address |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | HTTP listener |
| `POLL_MS` | `2000` | Head polling interval |
| `LOG_RANGE` | `100` | Blocks per `eth_getLogs` request while polling |
| `INDEX_BLOCKS` | `2100000` | Raw event window kept in memory (about 7 days); the backfill stops earlier where the provider's history ends |
| `INDEX_LOG_RANGE` | `LOG_RANGE` | Blocks per `eth_getLogs` request during backfill (1000 on a node that allows it) |
| `INDEX_CONCURRENCY` | `4` | Parallel backfill requests |
| `INDEX_PATH` | `data/index.json` | Hourly aggregates and open-interest snapshots persisted across restarts |
| `INDEX_HISTORY_BLOCKS` | `12000000` | Hourly aggregates retained (about 40 days) |
| `INDEX_SNAPSHOTS` | `1` | `0` skips historical open-interest sampling through archive reads |
| `BACKFILL_BLOCKS` | `3000` | Funding and parameter history backfill at start |
| `FUNDING_HISTORY_EVENTS` | `48` | Funding events fetched per market at start |
| `VERIFY_BLOCKS` | `12000` | Blocks between independent rescans (about one hour) |
| `BOOK_LEVELS`, `BOOK_RANGE_BPS`, `BOOK_REFRESH_MS` | `40`, `1500`, `30000` | Order-book walk limits and cadence; `BOOK_DISABLED=1` turns it off |
| `SERIES_EVERY_BLOCKS` | `200` | Sampling interval of the risk series (about one minute) |
| `CHECKPOINT_PATH` | `data/checkpoint.json` | Atomic state checkpoint |
| `MAX_RESUME_GAP` | `20000` | Oldest checkpoint resumed without a fresh bootstrap |
| `STALE_AFTER_MS` | `45000` | Freshness threshold |
| `RPC_TIMEOUT_MS`, `RPC_MAX_BYTES` | `15000`, 4 MiB | Per-request limits (raise `RPC_MAX_BYTES` with `INDEX_LOG_RANGE`) |
| `REFERENCE_DISABLED` | unset | `1` disables the Perpl API cross-check |

## Diagnostics

`npm run validate` (bounded preflight), `npm run snapshot` (full account-bitmap
discovery with open-interest reconciliation), `node --env-file=.env src/replay.js`
(size and side replay between two snapshots), the WebSocket probes, and
`npm run validate:math` (live formula validation, writes
`reports/validation-math.json`).

## Documentation

[Architecture](docs/architecture.md) · [Methodology](docs/methodology.md) ·
[Landscape](docs/landscape.md) ·
[Validation evidence](docs/validation-gate.md) · [API](docs/api.md) ·
[Runbook](docs/runbook.md) · [Data sources](docs/data-sources.md) ·
[Demo](docs/demo.md) · [Submission](docs/submission.md)

## Limits

- Isolated-margin positions only, as deployed.
- Wallet history and windowed metrics reach as far back as the RPC provider's
  log history and the configured window; each response and every page says
  how far that is. Hourly aggregates persist across restarts, so long windows
  fill in as the service runs.
- Liquidation prices use the current maintenance fraction and the contract's
  current premium PnL; funding accrued between events is not projected.
- Memory: about 250 bytes per indexed record, roughly 450 MB for four days of
  current Perpl activity; size `INDEX_BLOCKS` and `--max-old-space-size`
  together.

Built for the Monad Metropolis hackathon. MIT licensed; the ABI subset is
extracted from the MIT-licensed `perpl-sdk` crate (see [abi/README.md](abi/README.md)).
