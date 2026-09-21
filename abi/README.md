# ABI provenance

`exchange-read.json` contains only read-only (`view`/`pure`) function
descriptions extracted verbatim from `abi/dex/Exchange.json` in the official
`perpl-sdk` crate. The subset was extended on 2026-09-21 from the 0.2.8 crate;
its `Exchange.json` is byte-identical to the 0.2.5 artifact used earlier
(`abi/dex/REVISION` = `rc_v1.1.7-203-g0e5902dd`).

- Source: https://crates.io/api/v1/crates/perpl-sdk/0.2.8/download
  (sha256 `1bbbb35ea3424e1f92f2c0dec7c3d2287ec825d8cda33ea03e0dc5ec56111b62`)
- Earlier source: https://crates.io/api/v1/crates/perpl-sdk/0.2.5/download
  (sha256 `cf1ba86387672458ae92c7c9351bb4ffe8eb492c7a761ecc7249bc702cfe988a`)
- Upstream: https://github.com/PerplFoundation/dex-sdk (manifest declares MIT)
- Live check: `getContractVersion()` on mainnet returned 1.7.4 on 2026-09-21,
  matching `contract_version` in the public context endpoint.

No contract bytecode is included. Functions retained: account and position
getters, `getPerpetualInfoV2`, paged `getPositionsV2`, `getPositionIds`,
`getMarginFractions`, `getLiquidationInfo`, `getInsuranceProtocolSplit`,
`getFundingSumAtBlock`, `getFundingInterval`, `getContractVersion`,
`getUnwindInfo`, `isHalted`, `perpetualExists` and the order-book getters
`getVolumeAtBookPrice`, `getNextPriceBelowWithOrders`,
`getNextPriceAboveWithOrders`, `getOrdersAtPriceLevel`, `getPriceLevelOrderIds`
and `getOrderV2` (added 2026-09-21 for resting-depth measurement).

`exchange-events.json` contains every event ABI entry from the same artifact.
The collector decodes those events to learn which positions changed and to
record funding and liquidation history; it never executes transactions.
Quantity semantics reference the upstream `src/state/exchange.rs`,
`src/state/position.rs` and `src/state/perpetual.rs`. This project has not
executed the Rust SDK itself.
