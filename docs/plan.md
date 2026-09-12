# Incremental delivery plan

1. Prepare repository, configuration, read-only preflight and offline checks.
2. Obtain an authorized Monad RPC endpoint. Verify SDK/CLI source, license,
   toolchain requirements and deployment ABI; pin the selected SDK version.
3. Build a fixed-block snapshot, document discovery coverage, reconcile a real
   position against an independent source, and test replay against a new snapshot.
4. Record PASS, FAIL or BLOCKED with measurements. On PASS implement ingestion,
   metrics and read API, then dashboard. On FAIL evaluate a public-data fallback.
5. Run financial and operational tests as each corresponding component exists.

The supplied brief is design input. Its external claims remain subject to
verification. Current user scope is incremental project setup and testing.
Initial Node.js tooling accommodates the installed runtime; it does not replace
the proposed Rust ingestion architecture. Rust is absent from the current PATH.
