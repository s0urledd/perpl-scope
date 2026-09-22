# Validation gate

Result: **PASS** for the implemented scope (open positions, open interest,
PnL, funding, liquidation classification, live collector with reconciliation
and independent discovery). Remaining outside the gate: direct contract
liquidation-price diagnostics (none observed in sampled windows) and
historical position reads older than public-RPC state retention.

All evidence below was collected on mainnet, chain 143, exchange
`0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`, contract version 1.7.4.

## 2026-09-21 — formula validation on live data

`npm run validate:math` against `https://rpc1.monad.xyz` (2000-block log
ranges) at block 106780694. Full report: [evidence/validation-math-2026-09-21.json](evidence/validation-math-2026-09-21.json).

| Check | Result |
| --- | --- |
| Delta PnL recomputed vs `getPositionsV2.deltaPnlCNS` | 557 / 557 with truncation toward zero (floor: 464 / 557, rejected) |
| `pnlCNS = deltaPnlCNS + premiumPnlCNS` | 557 / 557 |
| Paged positions vs open-interest counters, 11 markets | all exact |
| Log scan 106580694–106780694 (200,000 blocks) | 263 watched logs: 33 liquidations, 230 funding events, 0 diagnostics |
| Liquidation classification at the event's mark, block − 1 | 1 / 1 with retained state: `liquidatable`, health 99.08 % (BTC, account 3939) |
| Premium change across latest funding event vs SDK formula | 208 / 208 positions (2 markets with retained state) |
| `getFundingSumAtBlock` vs emitted `fundingSumPNS` | 2 / 2 where the call succeeded |

Public providers prune historical state: 8 of 10 markets' funding-block reads
and 32 of 33 liquidation pre-states were unavailable through `rpc1`. The
script records these as `stateUnavailable` / `errors` rather than failing.

## 2026-09-21 — live collector

`npm start` against the public `https://rpc.monad.xyz`:

| Measurement | Value |
| --- | --- |
| Bootstrap (exchange info, 11 markets, 557 positions, hash re-check) | 1.6 s |
| Independent account-bitmap rescan, 5,311 accounts | 152–153 requests, 10.4–10.8 s, agrees |
| Poll cadence | 2 s, 0.4–0.5 s per poll, incremental reads only for touched positions |
| Open-interest reconciliation | exact on every poll observed (200+ polls) |
| Checkpoint resume after restart | resumed at block 106780717 with head 106780799, no bootstrap |
| Perpl API cross-check | margins, funding rate and funding sum match on all listed markets; mark within ±15 bps; OI within ±0.6 % (timing) |

## 2026-09-21 — full discovery snapshot on the public RPC

`npm run snapshot` at block 106773861: 5,311 accounts, 11 markets, 561
positions, 141 requests, 12.6 s, sampled peak RSS 135 MB; every per-market,
per-side sum equalled the contract. Summary: [evidence/snapshot-2026-09-21.json](evidence/snapshot-2026-09-21.json).

## Earlier evidence (2026-09-12)

### Full open-position discovery diagnostic

Two mainnet samples passed exact per-market, per-side OI reconciliation:

| Block | Accounts | Discovered markets | Open positions | RPC calls | Duration |
| --- | --- | --- | --- | --- | --- |
| 104240009 | 5270 | 11 | 670 | 143 | 46.363 s |
| 104240260 | 5270 | 11 | 673 | 143 | 45.545 s |

Block hashes:

- 104240009: 0xec49a0a57df5afede0ca4493c49cdae26e8c14e5dcadbadd02adf81353bb8ada
- 104240260: 0xd928ded885e374a0ba8a8833d724f29d22abb46acd6c1a6ae2ec1e190011449c

Both hashes matched final rechecks. Discovered market IDs were
1, 10, 20, 30, 31, 40, 50, 60, 70, 80 and 90. All account IDs were scanned
using the SDK account bitmap layout, then marked open positions were read.
An earlier all-account/all-market getter scan failed at market 30 after 330
requests; the bitmap route completed without omitting that market.

### Position size/side replay

From block 104240009 exclusive through 104240260 inclusive, 15337 exchange
logs were read in ten-block ranges. The replay applied 243 increases, 182
opens, 179 closes, 130 decreases and 6 inversions, for 740 size/side
mutations. All resulting account/market quantities and directions matched the
second snapshot exactly.

### WSS and isolated reconnect

The supplied endpoint supports mainnet JSON-RPC WSS. A 20-second subscription
received 61 newHeads notifications. An isolated three-second client disconnect
was followed by 14 blocks of backfill containing 847 logs; HTTP and WSS
returned identical log identities and payloads.

### Real mainnet position sample

Direct ABI reader at block 104237339: account 6, BTC long 0.00179 at 69742.2,
deposit 41.612829 AUSD; `getAccountByAddr` matched `getAccountById`; collateral
address and decimals matched the public context.

### Preflights

Mainnet (chain 143, block 104235620) and testnet (chain 10143, block 61955603)
preflights completed four sequential read-only requests with hash rechecks.
