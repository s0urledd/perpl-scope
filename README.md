# Perpl Scope

Read-only Perpl risk analytics project, currently at the initial validation stage.
The repository contains a bounded RPC preflight, open-position snapshot,
size/side replay diagnostics, WebSocket probes and offline tests. Dashboard,
analytics API and Rust ingestion are pending the live data validation gate.

## Quick start

Requires Node.js 24 or later. The RPC preflight has no external dependencies;
the position reader uses the pinned viem dependency for ABI encoding/decoding.

```powershell
npm.cmd ci
npm.cmd test
Copy-Item .env.example .env
# Set MONAD_RPC_URL in .env to your authorized node endpoint.
npm.cmd run validate
# Mainnet only: bounded direct position sample using the official ABI subset.
node --env-file=.env src/read-sample.js
# Full open-position diagnostic (bounded; overall validation remains pending).
npm.cmd run snapshot
# Optional 20-second WebSocket connectivity probe.
node --env-file=.env src/probe-wss.js
```

Validation emits JSON. Exit 1 means FAIL; exit 2 means BLOCKED. This initial
preflight cannot issue PASS. No RPC URL is printed. Do not commit `.env`.
Requests are sequential, limited to four calls, with a ten-second timeout per
call and a 1 MiB response cap. There are no retries or storage scans.

See [validation gate](docs/validation-gate.md), [plan](docs/plan.md),
[sources](docs/data-sources.md) and [runbook](docs/runbook.md).

License selection is pending. No third-party code is vendored.
