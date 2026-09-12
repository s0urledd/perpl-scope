# Validation gate

Result: BLOCKED

No authorized user-node RPC endpoint was supplied. No live snapshot or position
comparison has been executed. SDK version and ABI are unverified.

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
