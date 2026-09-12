# Methodology

Version: preflight-v0. No financial metrics are implemented or published.
Open interest, long/short, margin, liquidation exposure, funding and insurance
fund metrics remain unavailable until their respective validation is complete.
Coverage is unknown. Block numbers are represented as decimal strings.

## Position snapshot diagnostic

Market IDs come from getPerpetualExistsBitmap, decoded as four 256-bit words.
The SDK source confirms account IDs 1 through numberOfAccounts inclusive.
At one fixed block, every account is read with getAccountById. Its position
bitmap identifies the getPositionV2 calls to make. The first bank has 253 usable
bits; subsequent bank offsets are 253, 509 and 765, following SDK account.rs.
The account bitmap layout differs from the market existence bitmap.
Nonzero lotLNS values are summed as integers separately for positionType 0
(long) and 1 (short). Each sum must exactly equal the corresponding
getPerpetualInfo longOpenInterestLNS/shortOpenInterestLNS value. Tolerance is zero.
These are base-asset quantities scaled by lotDecimals, not quote notional.
The two sides are kept separate; their sum is not reported as single-sided OI.

A matching scan covers open positions only. It does not include orders, funding
history, account balances or prove the full SDK exchange state. Overall gate
status remains BLOCKED until independent reconciliation and replay pass.

## Size replay diagnostic

The diagnostic applies events strictly after snapshot block B through snapshot
block C inclusive. RPC logs are sorted by block, transaction and log index and
deduplicated by chain/hash/transaction/log identity. Removed logs invalidate
the run. The resulting complete account/market size-and-side map must equal
the second snapshot exactly. This does not validate entry price, deposit,
funding or margin replay. Event quantity semantics are referenced to SDK 0.2.5
src/state/exchange.rs: opening uses lotLNS; changes and inversion use endLotLNS;
liquidation uses remaining posLotLNS; close and unwind remove the position.
