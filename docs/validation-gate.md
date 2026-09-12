# Validation gate

Result: BLOCKED

## Full open-position discovery diagnostic

Two mainnet samples passed exact per-market, per-side OI reconciliation:

| Block | Accounts | Discovered markets | Open positions | RPC calls | Duration |
| --- | --- | --- | --- | --- | --- |
| 104240009 | 5270 | 11 | 670 | 143 | 46.363 s |
| 104240260 | 5270 | 11 | 673 | 143 | 45.545 s |

Block hashes:

- 104240009: 0xec49a0a57df5afede0ca4493c49cdae26e8c14e5dcadbadd02adf81353bb8ada
- 104240260: 0xd928ded885e374a0ba8a8833d724f29d22abb46acd6c1a6ae2ec1e190011449c

Both hashes matched final rechecks. Discovered market IDs were
1, 10, 20, 30, 31, 40, 50, 60, 70, 80 and 90. Zero-position markets were included.
All account IDs were scanned, using the SDK account bitmap layout, then marked
open positions were read. Each side's integer sum exactly equalled the market
getter, including zeros. Sampled process RSS peaks were 107905024 and 108466176
bytes. These measurements cover this diagnostic process, not a Rust L3 snapshot.

An earlier all-account/all-market getter scan failed at market 30 after 330
requests. Adaptive splitting was attempted and stopped when that route remained
expensive. The bitmap route completed without omitting that market.

The result proves the recorded position/OI scope. Full exchange snapshot,
independent UI reference, financial replay and persistent collector restart
remain outside this result. Overall gate is still BLOCKED.

## WSS and isolated reconnect

The supplied endpoint supports mainnet JSON-RPC WSS. A 20-second subscription
received 61 newHeads notifications. An isolated three-second client disconnect
was followed by 14 blocks of backfill containing 847 logs; HTTP and WSS returned
identical log identities and payloads. This is transport validation only.
See gateway-integration.md for the custom gateway assessment and stage-filter
limitations. No production service or node configuration was changed.

## Position size/side replay

Result: PASS within the explicitly limited size/side scope.
From block 104240009 exclusive through 104240260 inclusive, 15337 exchange
logs were read in ten-block ranges. The replay applied 243 increases, 182 opens,
179 closes, 130 decreases and 6 inversions, for 740 size/side mutations.
All resulting account/market quantities and directions matched the second
snapshot exactly. The comparison was corrected to ignore JSON property order;
a regression test covers that bug. Thirteen local tests passed.

Partial liquidation, deleveraging and unwind quantity rules follow the SDK,
but no such events were observed in this live interval. Their full financial
effects are outside this diagnostic. Deposits, prices, funding and margin have
not passed replay validation. Live reconnect tests and replay tests are separate;
no continuously running collector or atomic persistent cursor is implemented.

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
