# Runbook

PerplScope is meant to run on the host of a Monad node: logs and state come
from that node, and the execution-events sidecar needs the node's shared
memory. It also runs against any remote RPC. In that case, wake-ups fall back
to WebSocket heads or polling.

## Requirements

- Docker Engine with Compose v2, on the node's host if execution events are
  wanted.
- Disk: 3.4 GB for ClickHouse with the full history since the exchange
  launched (block 54,773,010, 11 February 2026; 67 million events by
  September 2026), growing with trading activity.
- Memory: ClickHouse is capped at 8 GB and the app at 3 GB by default
  (`CLICKHOUSE_MEMORY`, `APP_MEMORY`); neither needs that much at today's
  volume.
- RPC (your node):
  - `eth_getLogs` over 1000-block ranges;
  - `eth_call` at explicit block numbers;
  - `eth_getBlockByNumber('finalized')`;
  - Multicall3 at `0xca11bde05977b3631167028862be2a173976ca11`.
- History older than the node keeps (about 3 days on a full node) comes from
  archive endpoints, once. `https://rpc1.monad.xyz` and
  `https://rpc2.monad.xyz` return `blockTimestamp` on logs and accept
  1000-block ranges.

## Deploy

```bash
git clone https://github.com/s0urledd/perpl-scope && cd perpl-scope
cp .env.example .env
#   MONAD_RPC_URL=http://host.docker.internal:8080   (the node, seen from a container)
#   ARCHIVE_RPC_URLS=https://rpc1.monad.xyz,https://rpc2.monad.xyz
#   CLICKHOUSE_PASSWORD=<random>
docker compose up -d --build
curl -s localhost:8787/api/v1/health | jq '.index.backfill | {pct, eta_s, rate_blocks_per_s}'
```

The app is published on `127.0.0.1:8787` only. Put a TLS reverse proxy in
front of it. Server-sent events (`/api/v1/stream`) must not be buffered:

```caddy
perplscope.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
```

```nginx
location /api/v1/stream { proxy_pass http://127.0.0.1:8787; proxy_buffering off; proxy_read_timeout 1h; }
location / { proxy_pass http://127.0.0.1:8787; }
```

**First start.**
- The live loop starts at the node's finalized head.
- The backfill fills everything back to the deployment block, newest first.
  With two archives this takes one to three hours.
- The dashboard shows a progress bar meanwhile. Windows that are already
  covered are exact. Longer windows are marked `partial` until history
  reaches them. Open interest and TVL over time appear once history is
  contiguous from launch.

## Execution events (optional, fastest)

With the node's execution event ring enabled, new blocks and Perpl trades
reach the dashboard within milliseconds of execution. Proposed trades appear
dimmed and are replaced by the finalized ones. On the node host:

1. Huge pages and the ring directory:
   ```bash
   apt install libhugetlbfs-bin
   hugeadm --create-user-mounts monad        # run at boot, e.g. from a oneshot unit
   mkdir -p /var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings
   chown monad:monad /var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings
   ```
   The default ring needs about 330 free 2 MB huge pages (512 MiB payload
   plus descriptors) on top of what the node already uses. Raise
   `vm.nr_hugepages` if execution fails with `ENOSPC`.
2. Add the ring to execution (`systemctl edit monad-execution`, append to
   `ExecStart`) and restart it:
   ```
   --exec-event-ring /var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings/monad-exec-events
   ```
3. In `.env`, set `MONODE_WS_URL=ws://monode:8443`, then start the profile:
   ```bash
   docker compose --profile exec-events up -d --build
   ```

The sidecar is [Monode](https://github.com/monad-developers/monode),
built from a pinned commit (`deploy/monode/Dockerfile`):
- it runs in restricted mode, forwarding only block lifecycle events and
  logs of the Perpl exchange (`deploy/monode/restricted_filters.json`);
- it mounts the ring directory read-only;
- it is not published outside the compose network.

When execution restarts, the ring file is replaced. Monode's health check
then fails and Docker restarts it on the new ring.

If Monode cannot read the ring (for example after a node upgrade that
changes the ring format, until the pinned SDK is updated), PerplScope keeps
working on the next wake-up source: `MONAD_WS_URL` (`newHeads`, monad-rpc
with `--ws-enabled`) or polling every `LIVE_POLL_MS`. The status page shows
which one is active.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONAD_RPC_URL` | required | JSON-RPC of the node |
| `CHAIN_ID` | `143` | Monad mainnet |
| `EXCHANGE_ADDRESS` | `0x34B6…2a6F` | Perpl exchange proxy |
| `EXCHANGE_DEPLOY_BLOCK` | `54773010` | First block with exchange logs |
| `ARCHIVE_RPC_URLS` | none | Comma-separated archive endpoints for the backfill |
| `MONODE_WS_URL` | none | Monode sidecar, e.g. `ws://monode:8443` |
| `MONAD_WS_URL` | none | WebSocket endpoint for `newHeads` |
| `LIVE_HISTORY_BLOCKS` | `600000` | How far back the node serves `eth_getLogs` |
| `LIVE_LOG_RANGE`, `ARCHIVE_LOG_RANGE` | `1000` | Blocks per `eth_getLogs` request |
| `LIVE_BACKFILL_CONCURRENCY`, `ARCHIVE_CONCURRENCY` | `4` | Parallel backfill requests per source |
| `LIVE_POLL_MS` | `400` | Poll interval when no push source is connected |
| `LIVE_COMMIT_MS` | `1000` | Minimum interval between live commits |
| `INGEST_BATCH_ROWS`, `INGEST_BATCH_MS` | `150000`, `3000` | Backfill commit batch |
| `BACKFILL` | `1` | `0` disables the history backfill |
| `BACKFILL_FROM_BLOCK` | deploy block | Partial history (development) |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB` | `http://127.0.0.1:8123`, `default`, empty, `perpl` | Storage (set by compose) |
| `ROLLUP_MS` | `60000` | Rollup interval |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listen address (use `127.0.0.1` behind a proxy outside Docker) |
| `RPC_TIMEOUT_MS`, `RPC_MAX_BYTES` | `30000`, 64 MiB | Ingest RPC limits |
| `POLL_MS`, `VERIFY_BLOCKS`, `STALE_AFTER_MS` | `2000`, `12000`, `45000` | Contract-state collector |
| `BOOK_LEVELS`, `BOOK_RANGE_BPS`, `BOOK_REFRESH_MS`, `BOOK_DISABLED` | `40`, `1500`, `30000`, `0` | Order-book walk |
| `CHECKPOINT_PATH` | `data/checkpoint.json` (`/data/…` in Docker) | Collector checkpoint |
| `REFERENCE_ENABLED` | `0` | `1` compares contract figures with Perpl's public API (never used for metrics) |

## Operating

- **Health**: `GET /api/v1/health` returns 200 with:
  - `snapshot.status`: the collector (`fresh`, `syncing`, `stale` and a
    reason);
  - `index.live`: the last committed block and its age;
  - `index.backfill`: progress;
  - `index.decoder_checks`: decoder counters;
  - `feeds`: which wake-up source is connected.

  The dashboard's status page (`#/status`) shows the same, plus the
  integrity check.
- **Logs**: JSON lines on stdout. RPC URLs never appear in logs or
  responses.
- **Restarts** are safe at any point:
  - ingest resumes from recorded coverage;
  - rows of an interrupted commit are removed on start;
  - the collector resumes from its checkpoint when that block is still
    canonical.
- **Upgrades**: `git pull && docker compose up -d --build`. Schema changes
  are additive. A change to rollup definitions bumps `ROLLUP_VERSION`, and
  the rollups are recomputed from the stored events.
- **Re-index from scratch**: `docker compose down`, remove the
  `perpl-scope_clickhouse-data` volume, then `docker compose up -d`. Nothing
  else is stored, so there is nothing else to back up.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Backfill slow, `rate` errors in `index.backfill.last_error` | Archive rate limits: lower `ARCHIVE_CONCURRENCY` or add another archive |
| `pruned` errors from the node | `LIVE_HISTORY_BLOCKS` exceeds what the node keeps: lower it so older ranges go to archives |
| Integrity check fails for a market | An event was missed or misread. Check `index.decoder_checks` (unlinked, mismatches) and the status page, and report it with the block range |
| Collector `stale (head-stalled)` | The node's finalized head stopped moving: check the node |
| Live pill says *Delayed* | No commit for 15 s: check `index.live.last_error` |
| Monode restarts every 30 s | The ring file is missing or unreadable: check the execution flags and huge pages, or run without the profile |
| Live updates stop behind a proxy | The proxy buffers server-sent events: see the proxy settings above |

## Development

```bash
npm ci
docker run -d --name ch -p 127.0.0.1:8123:8123 -e CLICKHOUSE_PASSWORD=dev clickhouse/clickhouse-server:26.8
cp .env.example .env   # MONAD_RPC_URL, CLICKHOUSE_PASSWORD=dev, optional BACKFILL_FROM_BLOCK
npm start              # http://localhost:8787
npm run check          # syntax of every file
npm test               # unit tests (fake exchange, no network)
CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_PASSWORD=dev npm run test:integration
npm run validate:math  # formula checks against live contract state
```
