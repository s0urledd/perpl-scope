# Data sources

Reviewed on 2026-09-12:

- https://github.com/PerplFoundation/api-docs documents mainnet chain 143,
  the configured exchange address, collateral address and public context endpoint
  https://app.perpl.xyz/api/v1/pub/context.
- https://crates.io/crates/perpl-sdk was reachable but its rendered response did
  not provide sufficient version evidence. No SDK dependency has been selected.

Documentation values require runtime verification. Market IDs are not embedded
in analytics code. Token decimals, risk parameters, SDK snapshot semantics,
WebSocket limits, funding scales and event coverage remain unverified.
Hackathon dates and eligibility have not been verified at this setup stage.
