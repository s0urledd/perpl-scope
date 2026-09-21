# Architecture

```
Monad JSON-RPC ──► src/exchange.js (pinned-block reader, Multicall3, paging)
                      │
                      ▼
               src/collector.js ──► src/state.js ──► src/checkpoint.js (atomic JSON)
               bootstrap · poll ·      │
               reconcile · verify      ▼
                                 src/metrics.js (BigInt risk math via src/math.js)
                                       │
                                       ▼
                                 src/api.js (JSON + static web/) ◄── src/reference.js (Perpl API cross-check)
```

## Components

- **gate.js**: configuration, credential-redacting JSON-RPC client with
  timeout and response cap, preflight.
- **abi.js**: read-only ABI subset and event index (topic0 → event).
- **exchange.js**: `eth_call` at an explicit block, Multicall3 batches with
  adaptive splitting, market and position readers, log fetching with shape
  validation.
- **math.js**: pure integer risk mathematics (entry price with residue,
  notional, PnL, MMR, liquidation and bankruptcy prices, health, funding).
- **metrics.js**: per-market aggregates (ladder, map, concentration, health,
  insurance) and exchange totals.
- **events.js**: watched event allowlist, dirty-position derivation, funding,
  liquidation, deleveraging, unwind and parameter history.
- **state.js**: in-memory state, reconciliation, metric cache keyed by block
  hash, serialisation.
- **collector.js**: bootstrap, incremental polling, reorganisation and gap
  handling, funding-grid refresh, periodic independent verification,
  checkpoints and resume.
- **reference.js**: Perpl public context comparison (reference only).
- **api.js / server.js**: HTTP API, static dashboard, graceful shutdown with a
  final checkpoint.

## Poll cycle

1. Read `latest`; re-read the previously processed block and compare hashes
   (reorganisation ⇒ bootstrap).
2. Fetch watched exchange logs for `(previous, head]` in `LOG_RANGE` chunks.
3. Read market ids, market info, margin fractions, liquidation parameters and
   unwind status for every market at `head`; read exchange info.
4. Re-read every position named by the logs at `head`; re-read whole markets
   when a funding grid block was crossed, a funding event applied, or a market
   was added.
5. Re-check the head hash, then apply everything to the state in one
   synchronous step.
6. Reconcile stored sizes against the contract's open-interest counters. A
   mismatch marks the state stale and rebuilds it.
7. Checkpoint (throttled) and, once per `VERIFY_BLOCKS`, run the account-bitmap
   rescan in the background.

## Failure handling

| Condition | Behaviour |
| --- | --- |
| RPC error | Poll retried with exponential backoff; after three consecutive failures the state is `stale` |
| Reorganisation below the processed block | Fresh bootstrap (`reason: reorg`) |
| Gap larger than `MAX_RESUME_GAP` | Fresh bootstrap (`reason: gap`) |
| Open-interest mismatch | `stale`, then bootstrap (`reason: oi-mismatch`) |
| Verification mismatch | `stale`, then bootstrap (`reason: verification-mismatch`) |
| Checkpoint non-canonical or too old | Ignored, fresh bootstrap |
| Head hash changed during a poll | Poll discarded, retried |

Freshness is exposed on every response: `syncing`, `fresh` or `stale` with a
reason and the age of the last successful poll.

## Security posture

The service is read-only and unauthenticated by design. Provider errors are
collapsed to constants so the RPC URL or an embedded key never reaches logs or
responses; the health endpoint reports error codes only. User input reaches
the contract only through regex-gated account ids and addresses encoded by
viem's typed ABI encoder. Static files are served from `web/` only, CSV cells
that start with a formula character are quoted, download filenames are
restricted to safe characters, and every response carries `nosniff`,
`no-referrer` and `DENY` framing headers with a same-origin script policy on
the page. The independent review of 2026-09-21 found no high or medium
severity issue; its hardening notes are implemented.
