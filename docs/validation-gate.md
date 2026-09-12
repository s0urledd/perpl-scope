# Validation gate

Result: BLOCKED

## Real mainnet position sample

On 2026-09-12 the direct ABI reader completed at block 104237339, hash
0xe659b8168303547ff113967a01cc13adf6d57c40a0fb352daf7d555341650dcc.
The final block hash recheck matched. The contract reported 5270 accounts.
Only IDs 1 through 6 were scanned, stopping after the first account with an
open position. This is partial sampling, not complete exchange coverage.

| Field | Direct contract result |
| --- | --- |
| Account ID | 6 |
| Address | 0xf91b2eCb1cD59A36F3AED20B46943a75dB08795b |
| Market | BTC, perpetual ID 1 discovered from public context |
| Direction | Long |
| Size | 0.00179 BTC |
| Entry price | 69742.2; V2 price residue is zero in this sample |
| Position deposit | 41.612829 AUSD |
| Account free balance | 0 |

`getAccountByAddr` returned the same account record as `getAccountById`.
Exchange collateral address and decimals (6) matched public context. Market
price and lot decimals matched between context and `getPerpetualInfo`.
Raw responses are in ignored `reports/mainnet-sample.json`.
This demonstrates working getters, not an SDK snapshot or independent UI
comparison. Replay and full discovery remain pending.

A user-supplied Monad testnet RPC was tested on 2026-09-12. The bounded
preflight succeeded. No live full snapshot or position comparison has been
executed. SDK version and ABI are unverified. A subsequent user-supplied mainnet
RPC also passed the initial preflight, as recorded below.

## Live mainnet preflight

- Date: 2026-09-12.
- Chain ID returned: 143.
- Exchange with nonempty bytecode: 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F.
- Block number: 104235620.
- Block hash: 0x5f91e3879e1fa711fbd88750437cddc35983a19fcfe45f70d766f851f201ec78.
- The hash matched a second lookup after the pinned bytecode read.
- Four sequential read-only requests completed without a reported RPC error.
- Local configuration now targets mainnet.

Full validation remains BLOCKED. Bytecode presence and a hash recheck do not
prove ABI identity, full snapshot consistency, account coverage or replay.

## Live testnet preflight

- Chain ID returned: 10143.
- Exchange with nonempty bytecode: 0x1964c32f0be608e7d29302aff5e61268e72080cc.
- Block number: 61955603.
- Block hash: 0x37d6978db38ca0b39b56757eac4cc2a40433bd74766a297f6d22b9364f4756e5.
- The block hash matched a second lookup after the pinned bytecode read.
- Four sequential read-only requests completed without a reported RPC error.
- All seven offline tests passed again.

Overall status remains BLOCKED for the remaining SDK, metadata, discovery,
snapshot, independent account and replay checks. Testnet preflight provides
no mainnet coverage evidence. Local configuration is in the ignored `.env`.

The preflight checks configured chain ID, exchange bytecode at one block number,
and a subsequent canonical hash check. Bytecode presence does not establish the
ABI or deployment identity. This is not a complete exchange snapshot.

| Evidence | Current result |
| --- | --- |
| Network target | Monad mainnet, chain 143, documentation only |
| Exchange | 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F, documentation only |
| Snapshot block/hash | Unavailable |
| Account/position discovery | Unimplemented; coverage unknown |
| Independent real account comparison | Unavailable |
| Replay and snapshot reconciliation | Unimplemented |
| CPU, peak RAM, bootstrap, lag | Unmeasured |
| Historical calls and log retention | Unmeasured |

Offline tests use synthetic RPC responses. They do not establish live accuracy.
Successful preflight remains BLOCKED until the remaining evidence is collected.
