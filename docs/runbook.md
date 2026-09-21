# Runbook

## Run

```bash
npm ci
cp .env.example .env   # MONAD_RPC_URL=https://…
npm start              # http://localhost:8787
```

Logs are JSON lines on stdout and never contain the RPC URL. `GET /api/v1/health`
is the liveness probe; `snapshot.status` must be `fresh` for the numbers to be
current. Stop with SIGINT or SIGTERM; a final checkpoint is written.

## RPC requirements

- HTTPS JSON-RPC with `eth_call` at explicit blocks, `eth_getLogs` and
  `eth_getBlockByNumber` (`latest`, `finalized`).
- Multicall3 at `0xca11bde05977b3631167028862be2a173976ca11` (present on Monad).
- Log range: public `rpc.monad.xyz` and `rpc-mainnet.monadinfra.com` allow
  100 blocks; `rpc1.monad.xyz` allowed 2000. Set `LOG_RANGE` accordingly.
- State retention: public providers prune older state; bootstrap and polling
  only read the head, so they are unaffected. Historical validation scripts
  need an archive-capable endpoint for older blocks.
- Request budget at steady state: about 6–8 requests per 2 s poll plus one
  position read per touched position; bootstrap about 20 requests; the hourly
  verification about 150 requests.

## Checkpoints

`CHECKPOINT_PATH` (default `data/checkpoint.json`) is written atomically
(temp file + rename) at most every `CHECKPOINT_MS`. On start the checkpoint is
accepted only if its block hash is still canonical and the head is within
`MAX_RESUME_GAP` blocks; otherwise a fresh bootstrap runs. Deleting the file
is always safe.

## Reading the state

- `stale (rpc-errors)`: the provider is failing; the last good snapshot is
  still served with its block and age.
- `stale (oi-mismatch)` followed by `fresh`: the collector detected a missed
  update and rebuilt from the contract. Persistent mismatches point at an
  event not in the watched allowlist; `GET /api/v1/validation` shows the
  mismatching markets.
- `verification.ok = false`: the account-bitmap rescan disagreed with the paged
  getter; the collector rebuilds and the result stays visible on the
  validation page.

## Diagnostics

- `npm run validate`: bounded preflight, exit 2 = BLOCKED.
- `npm run snapshot`: full account-bitmap discovery with reconciliation,
  writes `reports/snapshot.json`.
- `npm run validate:math`: live formula validation, writes
  `reports/validation-math.json`. Options: `LOG_RANGE`,
  `VALIDATE_LOOKBACK_BLOCKS`, `VALIDATE_STATE_WINDOW`, `VALIDATE_MAX_VECTORS`.
- `node --env-file=.env src/replay.js`: size/side replay between
  `reports/replay-start.json` and `reports/snapshot.json`.
- `node --env-file=.env src/probe-wss.js` / `src/probe-reconnect.js`: transport
  probes (`MONAD_WSS_URL`).

## Deploy

The Dockerfile builds a production image (`node:22-alpine`, non-root). Mount
`/data` for the checkpoint and set `MONAD_RPC_URL`. Any host that runs a
container with one persistent volume works (Fly.io, Railway, Render, a VPS).
Expose port 8787 behind TLS; the API is read-only and sends
`access-control-allow-origin: *`.
