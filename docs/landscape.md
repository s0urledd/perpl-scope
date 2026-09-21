# Landscape: comparable tools and where PerplScope differs

Reviewed 2026-09-21.

| Tool | Scope | Positions | Liquidation levels | Liquidity | Validation | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Coinglass, CoinMarketCap liquidation dashboards | Centralised exchanges | Not observable | Estimated from open-interest changes and price | No | No | Heatmaps are inferred, not measured |
| TapeSurf, HypurrTrade dashboard, Hypurrscan | Hyperliquid | Real, from the venue's API | Computed per position | Partial (venue API) | No | Depend on the venue's own API for state |
| Open-source heatmap scripts (e.g. minchillo4/btc-liquidation-heatmap) | Binance via third-party APIs | Not observable | Statistical zones over candles | No | No | Backtests, not live risk |
| Chaos Labs dYdX risk portal | dYdX | Indexed | At-risk positions | Order-book depth informs parameter recommendations | Internal | Institutional risk management |
| Perpl app | Perpl | Own account only | Own positions only | Order book | Venue-reported | The venue's own UI |
| **PerplScope** | Perpl on Monad | **Read from the contract at a pinned block** | **Exact per position, contract-validated formulas** | **Resting depth walked from the on-chain book** | **Continuous reconciliation, independent rescan, live formula checks** | No venue API in any metric |

## What only PerplScope shows

1. **Liquidation ladder with bad debt and insurance cover**: notional liquidated per adverse move, the equity below zero if price gaps past bankruptcy, and whether the market's insurance balance covers it.
2. **On-chain liquidity versus liquidation demand**: because Perpl's central limit order book is a contract, the resting depth that a liquidation cascade would trade through can be read at the same block as the positions. The cover ratio (depth ÷ demand) per move is a cascade-risk gauge that estimated heatmaps cannot produce. On 2026-09-21 BTC showed 11× cover for long liquidations at a 5 % move but only 84 % for short liquidations, and 39 % at 10 %.
3. **Interactive stress test**: any move from −30 % to +30 % returns the positions hit, bad debt, insurance cover and the depth available.
4. **Auto-deleveraging queue**: the opposing positions Perpl's ADL would close first, ranked as the venue documents (most profitable first).
5. **Independent account risk view**: any account ID or address, all positions, liquidation prices, distance and health without connecting a wallet.
6. **Validation page**: reconciliation, independent discovery, PnL agreement and a cross-check against the venue's own API, all live.

## Design language

The dashboard follows Perpl's visual identity (Geist typeface, dark `#161418` base, smoke `#f1f1f1` light theme, purple `#6f5cff` and lilac `#a2a4ff` accents) while keeping data colours from a validated palette: long `#008300`, short `#e34948` / `#e66767`, single-series blue. Every chart has a legend, named tooltips and a table view, which is the secondary encoding the colour-vision checks require for a green/red pair.
