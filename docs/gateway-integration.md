# Gateway integration assessment

Reviewed the user-provided repository https://github.com/s0urledd/monad-execution-gateway
on 2026-09-12, including docs/wire.md, docs/spec.md and TxnLog serialization.
No modifications were made to that repository.

The gateway supports TxnLog address/topic filters, block lifecycle messages,
sequence cursor resume and explicit backpressure warnings. These are useful for
a shared collector connection. Its stream uses a custom protocol, not JSON-RPC
eth_subscribe. A live URL and deployed protocol verification remain pending.

Resume mode `snapshot` contains gateway telemetry, not Perpl exchange state.
A stale cursor, gateway restart or message-drop warning requires reconciliation
from the last fully applied canonical block. Do not mark the collector fresh
merely because the socket reconnects. Filtered sequence numbers need not be
consecutive; stream sequence is not a block completeness proof.

Proposed path:

1. Obtain the fixed-block position snapshot with bounded multicall reads.
2. Buffer the gateway stream during bootstrap, retaining lifecycle information.
3. Normalize TxnLog bytes and transaction-local indices against RPC receipts.
4. Publish only complete canonical blocks after replay verification.
5. Use bounded eth_getLogs backfill if cursor resume cannot cover a gap.

WSS reduces polling delay for live notifications. It does not remove contract
execution cost from eth_call. Snapshot HTTP versus WSS latency has not been
benchmarked. A single shared upstream feeds downstream consumers.

Critical detail from docs/spec.md section on stage filters: events below
`min_stage` are dropped, not buffered for later delivery. Therefore subscribing
to TxnLog with `min_stage: Finalized` can omit logs emitted before finalization.
Collect logs without that filter and track finalization separately; unknown
commit stage must not be treated as finalized.

The supplied WSS endpoint was verified as standard JSON-RPC on chain 143.
An isolated 20-second newHeads probe received 61 notifications. Measured RPC
round trips were 142 ms (chain ID), 184 ms (subscription), 189 ms (block number).
This is connectivity evidence only, not a comparative latency benchmark or
evidence that this endpoint implements the custom gateway protocol.
