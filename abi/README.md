# ABI provenance

exchange-read.json contains only read-only function descriptions extracted
from abi/dex/Exchange.json in the official perpl-sdk 0.2.5 crate.
Source: https://crates.io/api/v1/crates/perpl-sdk/0.2.5/download
Upstream: https://github.com/PerplFoundation/dex-sdk
The upstream crate manifest declares MIT. No contract bytecode is included.

exchange-events.json contains the event ABI entries from the same artifact.
The replay diagnostic reads those event descriptions; it does not execute
transaction functions. Quantity update rules reference the upstream
src/state/exchange.rs. This project has not executed the Rust SDK itself.
