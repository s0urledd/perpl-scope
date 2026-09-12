# Data sources

Reviewed on 2026-09-12:

- https://github.com/PerplFoundation/api-docs documents mainnet chain 143,
  the configured exchange address, collateral address and public context endpoint
  https://app.perpl.xyz/api/v1/pub/context.
- https://crates.io/crates/perpl-sdk was reachable but its rendered response did
  not provide sufficient version evidence. No SDK dependency has been selected.

Documentation values require runtime verification. Market IDs are not embedded
in analytics code. Token decimals, risk parameters, SDK snapshot semantics,
WebSocket limits, funding scales and event coverage remain unverified.
Hackathon dates and eligibility have not been verified at this setup stage.

## Direct reader source

The official perpl-sdk 0.2.5 archive was downloaded from
https://crates.io/api/v1/crates/perpl-sdk/0.2.5/download.
Its manifest declares MIT licensing, Rust edition 2024 and repository
https://github.com/PerplFoundation/dex-sdk. A read-only ABI subset from
`abi/dex/Exchange.json` is retained in `abi/exchange-read.json`.
No Rust SDK has been built or executed. Runtime getter decoding succeeded
on the selected mainnet deployment. This does not validate every SDK feature.
Source `src/state/position.rs` maps long to 0 and short to 1.
The SDK documentation lists funding event processing as pending.
