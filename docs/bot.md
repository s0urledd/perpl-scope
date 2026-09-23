# Trading bot

Status: in progress. This page will describe the strategy, the risk limits
and the onchain record once the bot trades on mainnet.

The plan:
- trade through Perpl's official API and SDK, with Plumb's data as the
  signal: leaderboards, cohorts, live positions and the order book;
- risk limits enforced before every order: position and leverage caps, a
  floor on the distance to liquidation, a daily loss limit with a kill
  switch, and a slippage check against the book;
- back-test on the full indexed history before trading, then small size on
  mainnet;
- run as a separate service with its own keys, so the analytics side stays
  read-only;
- list every order and fill with its transaction hash on a Bot page of the
  dashboard.
