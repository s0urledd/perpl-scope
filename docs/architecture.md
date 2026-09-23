# Architecture

PerplScope reads two things from Monad and trusts nothing else:

- **Exchange events** since the deployment block. They are the only source
  for history: volume, fees, flows, liquidations, funding payments, realized
  PnL, every wallet's trades. They are decoded once and stored in ClickHouse.
- **Contract state** at the latest finalized block. It is the only source for
  what exists now: open positions, mark prices, liquidation prices, open
  interest counters, TVL, insurance funds, the resting order book.

Both are read at finalized blocks, so an event row and a state snapshot never
describe different forks, and nothing written is ever rolled back.

```
        RPC host (Monad node)                               PerplScope
 ┌────────────────────────────────┐          ┌───────────────────────────────────────────────┐
 │ monad-execution                │ shared   │ Monode sidecar ─ws─▶ wake-ups, proposed trades │
 │   execution event ring  ───────┼─memory──▶│                                                │
 │ monad-rpc (JSON-RPC, WS) ◀─────┼──────────┤ ingest ── eth_getLogs, finalized blocks only   │
 └────────────────────────────────┘          │   └─▶ decode + link fills ─▶ ClickHouse  ev     │
   archive RPCs (one-time backfill) ────────▶│ rollups (closed, covered hours) ─▶ agg_*        │
                                             │ collector ── eth_call at the finalized block    │
                                             │   positions, OI, TVL, funding, order book       │
                                             │ HTTP API (JSON, CSV, SSE) ─▶ dashboard (static) │
                                             └───────────────────────────────────────────────┘
```

| Module | Role |
| --- | --- |
| `src/ingest.js` | Live loop and backfill over finalized blocks; coverage; exactly-once commits |
| `src/decode.js` | Static-ABI log decoder; links every position event to its fill |
| `src/schema.js` | ClickHouse tables and migration |
| `src/rollup.js`, `src/aggregates.js` | Hourly rollups; one definition per metric shared by rollups and raw queries |
| `src/query.js` | Window queries: rolled hours plus raw segments, clipped to coverage |
| `src/analytics-api.js`, `src/analytics.js` | Protocol, market, trader and wallet views; round trips and performance |
| `src/collector.js`, `src/state.js`, `src/metrics.js`, `src/book.js` | Contract state, reconciliation, verification, risk metrics, book walk |
| `src/live.js` | Monode client, WebSocket heads, server-sent events |
| `src/api.js`, `src/server.js` | HTTP routes, static files, wiring |
| `web/` | Dashboard: ES modules, hash router, ECharts and Geist served locally |

## Ingest

**One writer, finalized blocks only.** `eth_getLogs` is only ever asked for
explicit block numbers at or below the node's `finalized` block (Monad
finalizes about two blocks behind the proposal). Exchange logs are filtered
by address and by the topics the decoder knows.

**Live loop.** The loop reads the finalized head, fetches logs for the new
blocks, decodes and commits them, at most once per `LIVE_COMMIT_MS` (1 s).
Between rounds it sleeps until one of these wakes it, fastest first:

1. the Monode sidecar reports `BlockFinalized` from the node's execution event
   ring (the node updates its database before emitting it, so `eth_getLogs`
   already answers for that block);
2. a WebSocket `newHeads` subscription on the node;
3. a `LIVE_POLL_MS` (400 ms) timer.

**Backfill.** Everything between the deployment block (54,773,010) and the
live loop's start that is not yet covered is split into grid-aligned ranges
and fetched newest first by parallel workers. Ranges within
`LIVE_HISTORY_BLOCKS` of the head come from the local node; older ones from
the archive endpoints in `ARCHIVE_RPC_URLS`, round-robin. A range a provider
rejects as too large is halved. Rows are committed in batches of
`INGEST_BATCH_ROWS` or every `INGEST_BATCH_MS`. From two public archives the
backfill runs at 5,000–9,500 blocks per second, so the full history (about
52 million blocks) takes one to three hours once. Recent windows are exact
from the first minutes; each response says whether its window is complete.

**Exactly once.** Coverage is a set of disjoint block intervals stored in
`chunks`; ranges handed to workers never overlap it or each other. A range is
recorded in `chunks` only after its rows are inserted. If a commit fails
part-way, the rows of exactly those ranges are deleted before the ranges are
retried. On start, any row outside the recorded coverage (a crash between the
two inserts) is deleted. Tables are `ReplacingMergeTree` keyed by
`(block, log_index)`, so even an insert that the server applied after the
client gave up collapses on merge.

**Timestamps and metadata.** Monad's `eth_getLogs` returns `blockTimestamp`
on each log; for providers that do not, the timestamp comes from the block
header. Market price and size decimals come from `ContractAdded` events and
the contract. A log for a market whose decimals are unknown refreshes the
metadata before the range is decoded.

## Decoding and linking

`src/decode.js` decodes the exchange ABI directly (no generic decoder on the
hot path) and turns each log into one row of `ev`.

Position events (`PositionOpened`, `PositionIncreased`, `PositionDecreased`,
`PositionClosed`, `PositionInverted`, …) do not carry the trade price or, for
closes, the size. Every one of them is immediately followed in its
transaction by the fill that settled it: a `MakerOrderFilled` for the same
account and market, or the `TakerOrderFilled` of the aggressor. The decoder
links each position event to that fill and takes the price, size and fee from
it. Over 400,000 live blocks, 154,264 of 154,264 position events linked, with
no size mismatch, and the insurance and protocol fee split on the position
event equalled the fill fee on every building fill.

Two cases need care:

- **Liquidations on the book** report the liquidated account's taker fill
  *before* `PositionLiquidated`; the decoder holds that fill and links it when
  the liquidation arrives.
- **`PositionInverted`** carries the *new* side. The old side's open interest
  drops by the starting size and the new side's rises by the ending size.

Volume is the sum of maker-fill notional, so each match counts once. The
decoder's counters (linked, unlinked, size and fee mismatches) are exposed on
the status page and in `/api/v1/health` (`index.decoder_checks`).

## Storage

| Table | Contents | Key |
| --- | --- | --- |
| `ev` | Every decoded exchange event: kind, market, account, side, price, size, notional, fees, PnL, funding, amounts, flags | `(block, log_index)` |
| `ev_account` | Copy of `ev` ordered by account (filled by a materialized view), for wallet queries | `(account, block, log_index)` |
| `chunks` | Coverage intervals with their first and last block timestamps | `from_block` |
| `markets`, `accounts` | Market metadata; account id ↔ address from `AccountCreated` | id |
| `funding` | `FundingEventCompleted`: rate, funding price, payment, cumulative sum | `(market, funding_block, block, log_index)` |
| `params` | Parameter-change events (margins, fees, limits) as JSON | `(block, log_index)` |
| `agg_market_hour`, `agg_hour`, `agg_account_hour` | Hourly rollups per market, per exchange and per account and market | hour |
| `rollup_hours` | Which hours are rolled, with the rollup version | hour |
| `snapshots`, `exchange_snapshots` | Contract state every 5 minutes: mark, oracle, OI, funding, insurance; TVL and account count | ts |

The full history takes about 5 GB compressed (`ev` and `ev_account` hold
almost all of it); rollups are tens of megabytes.

## Aggregation

**Rollups.** Once an hour has closed and its blocks are fully covered, one
`INSERT … SELECT` per rollup table writes its aggregates and the hour is
recorded in `rollup_hours`. Every metric has one definition in
`src/aggregates.js`, used both by the rollup and by queries over raw rows, so
the two cannot drift. The integration test checks that window queries answer
the same with and without rollups.

**Windows.** A query for `[from, to)` reads rolled hours for the full hours
inside the window and raw rows for the edges and any hour not rolled yet,
each clipped to coverage. A window that reaches outside coverage is marked
`partial` in the response (`meta.coverage.complete: false`) instead of being
silently short.

**Running sums.** Open interest and TVL over time are running sums of events
since launch: per-market open-interest lots (long equals short on a matched
book) priced at the last trade of each bucket, and net collateral flows. They
are drawn only when coverage is contiguous from the deployment block.

## Contract state

The collector (`src/collector.js`) follows the finalized block:

- **Bootstrap** reads every market and every position through the contract's
  paged getter at one pinned block, then checks that stored sizes sum to the
  contract's open-interest counters.
- **Polls** read the logs of the new blocks, re-read only the positions they
  touched (all positions of a market after a funding event) and reconcile
  sizes with the open-interest counters at the same block. A mismatch
  rebuilds from the contract.
- **Verification** periodically rescans the whole account space through the
  account position bitmaps, an enumeration path independent of the paged
  getter, and compares size, side and collateral of every position. A
  mismatch keeps the state stale until a rebuild succeeds.
- **Order book** depth is walked level by level (bounded) at the same block
  as the positions; depth past a walk that hit its level cap is reported as a
  lower bound.
- **Checkpoints** make restarts instant; one is trusted only if its block
  hash is still canonical.

Status is `fresh`, `syncing` or `stale` with a reason (`rpc-errors`,
`oi-mismatch`, `verification-mismatch`, `head-stalled`, `no-recent-poll`).
Every risk response carries the block, hash and age it was computed from.

## Integrity checks

`GET /api/v1/integrity` compares, at the collector's block, the open interest
obtained by summing every indexed event since launch with the contract's own
counters for each market, and the net collateral flow since launch with the
exchange's balance. A difference means an event was missed or misread. The
status page shows the result next to the decoder counters and the
collector's reconciliation and verification.

## Live updates

The server pushes server-sent events on `/api/v1/stream`:

| Event | When | Payload |
| --- | --- | --- |
| `block` | each commit | finalized block number and timestamp |
| `trades` | each commit with trades | taker-side trades of the new blocks |
| `proposed` | Monode `BlockEnd` | trades decoded from a proposed block; shown dimmed, never stored |
| `liquidations` | each commit with liquidations | signal to refresh |
| `protocol` | at most every 2 s | 24 h headline and per-market figures |
| `backfill` | while indexing history | progress, rate and ETA |

## Performance

Measured on the development instance (ClickHouse 26.8, 8 markets, about 4,900
accounts):

| Request | First | Cached |
| --- | --- | --- |
| Protocol, 24 h | < 5 ms (pushed every 2 s) | 1 ms |
| Protocol, 30 d | 0.42 s | 1 ms |
| Protocol series, 7 d | 90 ms | 1 ms |
| Leaderboard, 30 d | 75 ms | 1 ms |
| Wallet profile (211,000 trades) | 0.13–0.16 s | 8 ms |
| Wallet analytics (round trips, performance) | 1.0–1.7 s | 15–20 ms |
| Wallet periods and ranks | 0.29 s | 17 ms |

Responses are gzip-compressed. Heavy aggregates are cached for seconds to a
minute and shared between viewers, so the load on ClickHouse does not grow
with the number of viewers.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Node RPC unavailable | Live ingest retries with backoff; pages keep serving indexed data and say how old it is |
| Archive unavailable or rate-limited | Backfill ranges retry on another source; ranges within the node's history use the node |
| ClickHouse restart | Server waits for it; commits resume from coverage; interrupted commits are repaired |
| Crash mid-commit | Rows outside recorded coverage are deleted on start |
| Monode or WebSocket down | Falls back to the next wake-up source, then to polling |
| Execution restarts (new event ring) | Monode exits on its health check and Docker restarts it on the new ring |
| Missed or misread event | Contract reconciliation and the integrity check flag it; the collector rebuilds from state |
| Disk refuses checkpoints | Reported on the status page; polls continue |
