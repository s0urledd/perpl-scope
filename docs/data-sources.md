# Data sources

## On-chain (authoritative)

- Monad mainnet, chain 143. Exchange `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`
  (contract version 1.7.4 via `getContractVersion()`), collateral AUSD
  `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals (via
  `getExchangeInfo()`).
- Getters used: `getPerpetualExistsBitmap`, `getPerpetualInfoV2`,
  `getMarginFractions`, `getLiquidationInfo`, `getUnwindInfo`,
  `getPositionsV2` (paged), `getPositionV2`, `getAccountById`,
  `numberOfAccounts`, `getFundingInterval`, `getFundingSumAtBlock`,
  `getContractVersion`, `isHalted`, `getExchangeInfo`; order book:
  `getVolumeAtBookPrice`, `getNextPriceBelowWithOrders`,
  `getNextPriceAboveWithOrders` (levels are offsets from `basePricePNS`, which
  is zero on every listed market; `getOrdersAtPriceLevel` was used only to
  confirm that the `exp` volume counters hold expired orders).
- Events used: position lifecycle, collateral changes, `FundingEventCompleted`,
  `PositionLiquidated`, deleveraging, unwind, parameter updates, liquidation
  diagnostics (`src/events.js`).
- Multicall3 `0xca11bde05977b3631167028862be2a173976ca11`.

## ABI and formulas

- `perpl-sdk` crate 0.2.8 (crates.io, MIT), `abi/dex/Exchange.json`
  (`REVISION rc_v1.1.7-203-g0e5902dd`), `src/state/position.rs`,
  `src/state/perpetual.rs`, `src/state/exchange.rs`. See `abi/README.md`.
- Perpl documentation: `exchange/margin`, `exchange/liquidation`,
  `exchange/liquidation/insurance-and-adl`, `exchange/funding`
  (docs.perpl.xyz, Markdown versions).

## Reference only

- Perpl public context `https://app.perpl.xyz/api/v1/pub/context`: market
  list, `state.mrk`, `state.oi`, `funding.rate` (×10⁻⁶), `funding.sum`,
  margin fractions. Compared with the contract on the validation page; never
  used to compute a metric. The API omits markets 30, 70 and 80, which the
  contract lists with zero positions.

## RPC endpoints tested (2026-09-21)

| Endpoint | Chain | `eth_getLogs` range | Notes |
| --- | --- | --- | --- |
| https://rpc.monad.xyz | 143 | 100 blocks | Perpl's documented default; used for the live collector |
| https://rpc1.monad.xyz | 143 | ≥ 2000 blocks | Used for long log scans; prunes older state |
| https://rpc-mainnet.monadinfra.com | 143 | 100 blocks | |
| https://monad-mainnet.drpc.org | 143 | 100 blocks (free plan) | |
| https://testnet-rpc.monad.xyz | 10143 | — | Testnet exchange `0x1964c32f0be608e7d29302aff5e61268e72080cc` |

Measured block time on 2026-09-21: about 0.30 s (1000-block window), so one
funding interval (8571 blocks) is about 43 minutes, matching the public
context's `funding_interval_sec`.

Self-hosted node `https://monad-rpc.huginn.tech` (2026-09-21): `eth_getLogs`
accepts 1000-block ranges (1500 rejected as too large, 1000 unfiltered blocks
exceed the response size limit, so the index always filters by topic), keeps
about 98 hours of logs and state, and answers eight parallel log requests in
under a second. Used for the index backfill; the public endpoints remain
sufficient for the live snapshot.
