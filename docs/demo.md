# Demo script (about three minutes)

1. **Open the dashboard.** Point at the header pill: block number, freshness
   and age. Every number on the page comes from that block and the exchange
   events up to it.
2. **Overview, 24h.** Read the tiles: volume (and the venue's own figure next
   to it), open interest with its change, TVL, fees with the insurance and
   protocol split, active traders, net flows, liquidations, realized PnL.
   Switch to 7d and All: the coverage line says exactly how far the index
   reaches. Show the volume, open interest and TVL, flows and taker-flow
   charts, then the market table with the long / short skew bars.
3. **Traders.** Rank by realized PnL, then by liquidated. Star a wallet.
4. **Wallet.** Open the top trader: account value, open positions with
   liquidation prices, win rate, profit factor, drawdown, streaks, hold time,
   best and worst market, the observations, the equity curve, the trade
   history with fill prices and roles, and the CSV export. Add a second
   wallet from the leaderboard and open Watchlist to compare them.
5. **BTC market.** Walk the liquidation ladder and map, the stress-test
   slider, order-book cover, funding history and the countdown to the next
   funding block.
6. **Validation page.** Open-interest reconciliation, independent rescan,
   PnL agreement, the event-index status and the venue-volume table showing
   the chain and Perpl's API within a fraction of a percent.
7. **Terminal.** `curl localhost:8787/api/v1/stats?window=24h | head` to show
   the JSON API with the snapshot block and coverage.
8. **Close** with the methodology: exact sums from events with fill-settled
   prices, formulas from the Perpl docs and SDK validated on live data,
   nothing trusted from the venue.
