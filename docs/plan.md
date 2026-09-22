# Delivery plan and status

1. ✅ Repository, configuration, read-only preflight, offline checks.
2. ✅ Authorized RPC, SDK/ABI verification (perpl-sdk 0.2.5 → 0.2.8, ABI
   identical), pinned ABI subset.
3. ✅ Fixed-block snapshot with complete account-bitmap discovery, exact
   open-interest reconciliation, size/side replay between snapshots.
4. ✅ Live collector with paged-getter bootstrap, event-driven re-reads,
   per-poll reconciliation, periodic independent verification, checkpoints.
5. ✅ Risk metrics (PnL, health, liquidation and bankruptcy prices, ladder,
   map, concentration, insurance coverage, funding) validated on live data.
6. ✅ JSON API and dashboard.
7. ⬜ Public deployment, demo recording, hackathon submission
   (`docs/submission.md`).
8. ⬜ Nice-to-have: WebSocket head subscription to cut polling latency,
   historical time series (persisted per-block metrics), alerts.

Rust ingestion was considered and not built: the Node.js collector meets the
budget (bootstrap in seconds, sub-second polls) and the SDK's own paged
getter removed the need for an L3 snapshot.
