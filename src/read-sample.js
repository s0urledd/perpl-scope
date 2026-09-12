import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { encodeFunctionData, decodeFunctionResult, formatUnits } from 'viem';
import { configuration, rpcClient, preflight } from './gate.js';
const abi = JSON.parse(await readFile(new URL('../abi/exchange-read.json', import.meta.url), 'utf8'));
const config = configuration(process.env);
const rpc = rpcClient(config.url);
const report = await preflight(config, rpc);
if (report.status === 'FAIL') throw new Error(report.reason);
const block = '0x' + BigInt(report.block_number).toString(16);
async function call(name, args = []) {
  const data = encodeFunctionData({ abi, functionName: name, args });
  const raw = await rpc('eth_call', [{ to: config.exchange, data }, block]);
  return decodeFunctionResult({ abi, functionName: name, data: raw });
}
const contextResponse = await fetch('https://app.perpl.xyz/api/v1/pub/context', { signal: AbortSignal.timeout(10000) });
if (!contextResponse.ok) throw new Error('CONTEXT_UNAVAILABLE');
const context = await contextResponse.json();
const instance = context.instances.find(x => x.address.toLowerCase() === config.exchange.toLowerCase());
if (String(context.chain.chain_id) !== config.chain || !instance) throw new Error('CONTEXT_MISMATCH');
const info = await call('getExchangeInfo');
const token = context.tokens.find(x => x.id === instance.collateral_token_id);
if (!token || token.address.toLowerCase() !== info[4].toLowerCase() || BigInt(token.decimals) !== info[3]) throw new Error('COLLATERAL_MISMATCH');
report.collateral = { address: info[4], decimals: info[3], context_symbol: token.symbol };
report.number_of_accounts = await call('numberOfAccounts');
report.samples = [];
report.accounts_scanned = 0;
const markets = context.markets.filter(x => x.instance_id === instance.id);
// Bounded diagnostic sample only. Never claim full coverage from this scan.
for (let id = 1n; id <= report.number_of_accounts && id <= 20n; id++) {
  const account = await call('getAccountById', [id]);
  report.accounts_scanned++;
  if (Object.values(account.positions).every(x => x === 0n)) continue;
  for (const market of markets.slice(0, 10)) {
    const [position] = await call('getPositionV2', [BigInt(market.perpetual_id), id]);
    if (position.lotLNS === 0n) continue;
    const perp = await call('getPerpetualInfo', [BigInt(market.perpetual_id)]);
    if (perp.priceDecimals !== BigInt(market.config.price_decimals) || perp.lotDecimals !== BigInt(market.config.size_decimals)) throw new Error('MARKET_PRECISION_MISMATCH');
    const resolved = await call('getAccountByAddr', [account.accountAddr]);
    if (resolved.accountId !== id || position.accountId !== id || resolved.accountAddr.toLowerCase() !== account.accountAddr.toLowerCase()) throw new Error('ACCOUNT_RESOLUTION_MISMATCH');
    report.samples.push({ account, market_id: market.perpetual_id, market: market.name,
      address_resolution: resolved, position,
      display: { direction: position.positionType === 0 ? 'long' : position.positionType === 1 ? 'short' : 'unknown',
        size: formatUnits(position.lotLNS, Number(perp.lotDecimals)),
        entry_price_integer_component: formatUnits(position.pricePNS, Number(perp.priceDecimals)),
        deposit: formatUnits(position.depositCNS, Number(info[3])) },
      entry_price_note: 'V2 residue is retained raw; integer component is not the full effective entry price.' });
  }
  if (report.samples.length) break;
}
const end = await rpc('eth_getBlockByNumber', [block, false]);
if (end?.hash !== report.block_hash) throw new Error('BLOCK_HASH_CHANGED');
report.coverage = 'partial';
report.status = 'BLOCKED';
report.remaining = ['Full SDK snapshot validation', 'Token metadata directly from ERC-20', 'Complete account discovery', 'Independent position reconciliation', 'Replay reconciliation', 'Resource measurements'];
report.note = 'Direct getter sample only. SDK snapshot, independent UI reconciliation and replay remain pending.';
await mkdir('reports', { recursive: true });
const json = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
await writeFile('reports/mainnet-sample.json', json);
console.log(json);
