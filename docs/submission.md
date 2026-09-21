# Submission — Monad Metropolis hackathon

Deadline 13 October 2026. Requirements: a working product with a public
project profile, a demo, a short write-up and a link to the code; work built
during the six-week window (this repository started 12 September 2026).

Targets:

- Sponsor bounty **"Best Analytics / Risk Tool" (Perpl)** — primary.
- Sponsor bounty **"Best use of Perpl's API"** — the public context endpoint is
  used as an independent cross-check surfaced on the validation page.
- Track 01 **Onchain Finance & Trading**.

## Checklist

- [ ] Deploy the service to a public URL with a persistent volume
      (`docs/runbook.md` § Deploy) and put the URL in the project profile.
- [ ] Record the demo following `docs/demo.md`; keep the dashboard live in the
      recording so the block number advances.
- [ ] Write-up: use the README's first two sections and the evidence table.
- [ ] Link the repository and `docs/validation-gate.md`.
- [ ] Register the team and confirm country eligibility on the platform.

## Claims that can be made, and their evidence

| Claim | Evidence |
| --- | --- |
| Every metric is computed from chain state at a pinned block | `snapshot` on every response; hash re-check in collector |
| Open interest is reconciled to the contract on every poll | `GET /api/v1/validation` → `reconciliation` |
| Position discovery is verified by an independent path | `verification` (account-bitmap rescan) |
| PnL and funding formulas match the contract on live data | `docs/validation-gate.md` (557/557, 208/208) |
| Liquidation formulas follow Perpl's documentation and SDK | `docs/methodology.md`; classification agrees with observed liquidations |
| Perpl's API is not an input to any metric | `src/reference.js` is comparison only |

Claims to avoid: exact prediction of liquidation execution prices (the ladder
uses trigger prices), coverage of order-book liquidity, or completeness of
liquidation history beyond the collected window.
