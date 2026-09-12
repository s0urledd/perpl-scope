# Runbook

Run `npm.cmd test` for offline checks. Run `npm.cmd run validate` after setting
MONAD_RPC_URL in the ignored `.env` file. A missing endpoint produces BLOCKED.
The process exits after its bounded checks. Stop with Ctrl+C if necessary.
Restart repeats preflight from the current head; no collector, cursor, persistent
state, backfill or history exists yet. Do not interpret preflight as readiness.

Next live test: verify chain and deployed code, then independently confirm ABI
and collateral metadata before implementing SDK snapshot collection.
