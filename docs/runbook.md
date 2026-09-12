# Runbook

Run `npm.cmd test` for offline checks. Run `npm.cmd run validate` after setting
MONAD_RPC_URL in the ignored `.env` file. A missing endpoint produces BLOCKED.
The process exits after its bounded checks. Stop with Ctrl+C if necessary.
Restart repeats preflight from the current head; no collector, cursor, persistent
state, backfill or history exists yet. Do not interpret preflight as readiness.

Next live test: verify chain and deployed code, then independently confirm ABI
and collateral metadata before implementing SDK snapshot collection.

## Position snapshot and transport diagnostics

`npm.cmd run snapshot` writes reports/snapshot.json atomically after a bounded
scan. It permits at most 10000 accounts, 20 discovered markets, 4000 RPC calls
and ten minutes, with sequential batches of at most 50 contract getters.
Only open-position/OI coverage can pass; overall gate remains BLOCKED.
Preserve a successful result as reports/replay-start.json, run another snapshot,
then run `node --env-file=.env src/replay.js`. Replay is limited to 2000 blocks,
queried ten at a time, and checks position size and side only.

Set MONAD_WSS_URL and run `node --env-file=.env src/probe-wss.js` or
`node --env-file=.env src/probe-reconnect.js` for isolated transport tests.
These scripts are diagnostics, not persistent production collectors.
