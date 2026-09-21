// ABI loading and event indexing. Read-only function descriptions come from
// abi/exchange-read.json and event descriptions from abi/exchange-events.json;
// both are verbatim subsets of the official perpl-sdk Exchange ABI.
import { readFile } from 'node:fs/promises';
import { toEventSelector, decodeEventLog } from 'viem';

export const readAbi = JSON.parse(await readFile(new URL('../abi/exchange-read.json', import.meta.url), 'utf8'));
export const eventsAbi = JSON.parse(await readFile(new URL('../abi/exchange-events.json', import.meta.url), 'utf8'));

const byTopic = new Map();
const byName = new Map();
for (const item of eventsAbi) {
  const selector = toEventSelector(item);
  byTopic.set(selector, item);
  if (!byName.has(item.name)) byName.set(item.name, []);
  byName.get(item.name).push(selector);
}

// All topic0 selectors for the given event names (overloads included).
export function topicsFor(names) {
  const out = [];
  for (const name of names) {
    const selectors = byName.get(name);
    if (!selectors) throw new Error(`UNKNOWN_EVENT:${name}`);
    out.push(...selectors);
  }
  return out;
}

export function eventName(topic0) { return byTopic.get(topic0)?.name ?? null; }

// Decode one raw log. Returns null for topics outside the exchange ABI.
export function decodeLog(log) {
  const item = byTopic.get(log.topics?.[0]);
  if (!item) return null;
  const { eventName: name, args } = decodeEventLog({ abi: [item], data: log.data, topics: log.topics, strict: true });
  return { name, args };
}
