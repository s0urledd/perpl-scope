# Demo script (about three minutes)

1. **Open the dashboard.** Point at the header pill: block number, freshness
   and age. Every number on the page comes from that block.
2. **Overview.** Read the hero (open interest at mark) and the tiles: notional
   within 5 % and 10 % of liquidation, shortfall at a 10 % move and how many
   times the insurance funds cover it, liquidatable positions right now.
   Show the per-market chart of exposure at 10 % and the market table.
3. **BTC market.** Walk the liquidation ladder (longs liquidate as price
   falls, shorts as it rises; hover a bar for prices, counts and shortfall).
   Show the liquidation map: where levels cluster relative to the mark. Show
   funding history and the countdown to the next funding block. Sort
   positions by "closest to liquidation".
4. **Validation page.** Show open-interest reconciliation (exact at the
   current block), the independent account-bitmap rescan result, PnL
   agreement per market, and the cross-check against Perpl's own API
   (margins, funding, mark).
5. **Terminal.** `curl localhost:8787/api/v1/markets/1/ladder | head` to show
   the JSON API with the snapshot block and hash. Optionally restart the
   service to show the checkpoint resume in the logs.
6. **Close** with the methodology: formulas from the Perpl docs and SDK,
   validated on live data (557/557 PnL, 208/208 funding), nothing trusted
   from the venue.
