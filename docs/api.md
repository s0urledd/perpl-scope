# HTTP API

All routes are `GET`, read-only, JSON unless noted, gzip-compressed and served
with `access-control-allow-origin: *`. Amounts are decimal strings in USD
(AUSD) or in the market's units; they are exact and should be parsed as
decimals, not floats. Times are Unix seconds (UTC).

Every analytics response has a `meta` object with the last indexed block
(`block`, `ts`) and, for windowed routes, the window and its `coverage`:
`complete: false` means history for part of the window is still being
indexed. Risk routes carry a `snapshot` with the contract block, hash, status
and age they were computed from.

Errors: `{ "error": "CODE" }` with 400 (bad parameter), 404 (unknown market,
account or route) or 503 (`SYNCING` before the first contract snapshot).

## Protocol

| Route | Parameters | Returns |
| --- | --- | --- |
| `/api/v1/protocol` | `window` = `24h` (default), `7d`, `30d`, `90d`, `all` | `headline`, the window's totals, each with `value`, `prev` (the previous window of the same length) and `change_pct`: volume, trades, fees (protocol, insurance, builder), take rate, traders, new accounts, deposits, withdrawals, net flow, liquidations, liquidated notional, deleverages, taker buy share, realized PnL. `current`: contract state now, i.e. open interest, TVL, insurance, positions, accounts. `markets[]`: volume and share, trades, traders, fees, OHLC and change, taker buy share, liquidations, plus live mark, open interest, long/short positions, funding and OI cap. `windows[]`: 24h, 7d, 30d and all-time totals |
| `/api/v1/protocol/series` | `window`, `bucket` = `1h`, `4h`, `1d`, `1w` (default by window), `market` | `times[]` and `points[]` per bucket: volume, trades, fees, protocol fees, taker buy and sell, liquidations, realized PnL, open interest; exchange-wide also traders, deposits, withdrawals, net flow, new accounts, TVL; for one market also OHLC. `by_market[]` has volume, liquidated notional and fees per market. `meta.cumulative_complete` says whether open interest and TVL are available (history contiguous from launch) |
| `/api/v1/trades` | `limit` ≤ 200 (default 50), `market` | Latest taker-side trades: kind (`open`, `increase`, `decrease`, `close`, `invert`, `liquidation`), side, buy, price, size, notional, fee, PnL, account and address |
| `/api/v1/liquidations` | `limit` ≤ 500, `market`, `format=csv` | Latest liquidations and deleverages, and `last_24h` totals |
| `/api/v1/funding` | `window` (default `7d`) | Per market: current rate per interval, 8 h and APR equivalents, interval length, positions and open interest; `series` of funding rates over the window |
| `/api/v1/flows` | `window` | Deposits, withdrawals and net flow; top depositors and withdrawers; latest transfers |
| `/api/v1/leaderboard` | `window`, `by` = `pnl`, `loss`, `volume`, `realized`, `fees`, `trades`, `liquidated`, `deposits`, `withdrawals`, `net_flow`; `market`, `limit` ≤ 200, `offset`, `format=csv` | Ranked accounts: net PnL (realized − fees), realized, fees, volume, maker share, trades, PnL per volume, liquidations, flows, markets traded, open positions and unrealized PnL now; `total` accounts |
| `/api/v1/search` | `q`: address, address prefix or account ID | Up to eight matching accounts |

## Wallets

`:key` is a `0x` address or an account ID.

| Route | Parameters | Returns |
| --- | --- | --- |
| `/api/v1/wallets/:key` | | `account` (id, address, creation time); `summary` (all-time volume, trades, realized, fees, net PnL, funding, liquidations, deposits, withdrawals, first and last trade, active days, maker share); `markets[]`; `pnl_daily[]` (net and cumulative); `recent_trades[]`; `flows[]`; `portfolio` (balance, locked, margin, account value, unrealized PnL, margin usage, leverage, closest liquidation) and `positions[]` from contract state |
| `/api/v1/wallets/:key/analytics` | | `performance` over closed round trips: win rate, profit factor, expectancy, largest win and loss, max drawdown with dates, streaks, hold times (all, winners, losers), long and short splits, best and worst market, per-market results; `insights[]` (rule-based); `activity` (weekday × hour); `trip_curve`; `trips[]` (latest 200) and `open_trips[]`. `performance.based_on` says how many events were used |
| `/api/v1/wallets/:key/periods` | | For 24h, 7d, 30d and all time: volume, trades, net PnL, realized, fees, funding, liquidations, PnL per volume (bps) and `rank` by PnL and by volume among every account that traded in that window |
| `/api/v1/wallets/:key/trades` | `before` = `block:log_index` cursor, `limit` ≤ 500 (10,000 as CSV), `market`, `format=csv` | Every position change with the price, size and fee of the fill that settled it, role, realized PnL and remaining size; `next` cursor |
| `/api/v1/compare` | `wallets` = up to ten keys, comma-separated | Profile and performance of each wallet |

## Pipeline and integrity

| Route | Returns |
| --- | --- |
| `/api/v1/health` | Liveness (200). Collector snapshot and status. `index.live` (last committed block, commits, errors). `index.backfill` (progress, rate, ETA). `index.coverage` intervals, `index.rollups`, `index.decoder_checks`. `feeds` (execution events, WebSocket heads, SSE clients). Memory |
| `/api/v1/integrity` | Event-derived open interest per market and net collateral flow compared with the contract's counters and balance at the collector's block (available once history is complete) |
| `/api/v1/stream` | Server-sent events: `block`, `trades`, `proposed`, `liquidations`, `protocol`, `backfill` (see `docs/architecture.md`) |

## Risk (contract state)

| Route | Parameters | Returns |
| --- | --- | --- |
| `/api/v1/overview` | | Exchange totals: positions, notional, deposits, equity, liquidatable and bankrupt positions, notional at risk at 5 % and 10 % moves, shortfall and insurance cover, book cover at 10 % (`complete: false` when the book walk stopped at its level cap) |
| `/api/v1/markets` | | Per-market risk summary |
| `/api/v1/markets/:id` | `limit` | Ladder, liquidation map, liquidity and absorption, ADL queue, health distribution, concentration by side, top positions, funding and liquidation history |
| `/api/v1/markets/:id/positions` | `side`, `sort`, `limit`, `format=csv` | Every open position with entry, mark notional, deposit, PnL, equity, maintenance margin, health, liquidation and bankruptcy prices and distances, leverage |
| `/api/v1/markets/:id/ladder` | | Liquidation ladder and map |
| `/api/v1/markets/:id/stress` | `move_pct` (signed, e.g. `-10`) | Positions liquidated at that move, notional and share of open interest, shortfall, insurance cover, book depth and absorption, largest positions hit |
| `/api/v1/markets/:id/book` | | Resting depth walked from the contract, per level and per band |
| `/api/v1/markets/:id/funding` | `limit` | Current and next funding, history of funding events |
| `/api/v1/series` | `hours` ≤ 168, `market` | Sampled risk totals over time |
| `/api/v1/validation` | | Reconciliation, independent verification, PnL agreement and the integrity check |
| `/api/v1/events` | | Recent parameter changes and unwinds |
| `/api/v1/reference` | | Perpl public API figures next to the contract's (only with `REFERENCE_ENABLED=1`) |

## Examples

```bash
curl -s localhost:8787/api/v1/protocol?window=7d | jq '.headline.volume'
# → { "value": "<USD>", "prev": "<USD, previous 7 days>", "change_pct": <number> }

curl -s 'localhost:8787/api/v1/leaderboard?window=30d&by=pnl&limit=3' | jq '.rows[] | {rank, address, pnl, volume}'

curl -s localhost:8787/api/v1/wallets/0xc8d79f44912a9f55c6faf819283efcea9661d1dc/periods | jq '.periods[] | {window, net_pnl, rank}'

curl -s 'localhost:8787/api/v1/markets/1/stress?move_pct=-10' | jq '{liquidated, shortfall, liquidity}'

curl -N localhost:8787/api/v1/stream   # event: block / trades / protocol …
```
