// Refresh the bundled Quainance launchpad snapshot (src/quainanceCatalog.snapshot.json).
//
//   node apps/stats-app/scripts/refresh-quainance-catalog.mjs        (from q0/)
//
// The browser cannot read Quainance's catalog directly from production (no CORS header), so the page falls back to this
// file, labelled with the time it was taken. Only the fields the app reads are kept, and addresses are re-checked by the
// app's parser at load time; this script trusts nothing it writes. Read-only: one GET, no key, nothing sent.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CATALOG_URL = 'https://www.quainance.com/api/trade-zone/catalog';
const OUT = fileURLToPath(new URL('../src/quainanceCatalog.snapshot.json', import.meta.url));

const KEEP = [
  'id', 'source', 'sourceContract', 'token', 'curveAddress', 'creator', 'tokenName', 'tokenSymbol', 'tokenDecimals',
  'totalSupply', 'phase', 'latestPriceQuoteE12', 'buyCount', 'sellCount', 'buyQuoteAmount', 'sellQuoteAmount',
  'createdAtTimestamp', 'launchedAtTimestamp', 'pair'
];

const res = await fetch(CATALOG_URL, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
if (!res.ok) throw new Error(`catalog answered ${res.status}`);
const body = await res.json();
const launches = body?.data?.tradeLaunches;
if (!Array.isArray(launches) || launches.length === 0) throw new Error('catalog has no tradeLaunches');

const slim = launches.map(l => Object.fromEntries(KEEP.filter(k => l[k] !== undefined && l[k] !== null).map(k => [k, l[k]])));
const out = {
  fetchedAt: Math.floor(Date.now() / 1000),
  source: CATALOG_URL,
  catalog: { data: { tradeLaunches: slim, _meta: { block: body?.data?._meta?.block ?? null } } }
};
writeFileSync(OUT, JSON.stringify(out) + '\n');
const bySource = {};
for (const l of slim) bySource[l.source] = (bySource[l.source] ?? 0) + 1;
console.log(`wrote ${slim.length} launches to ${OUT}`, bySource);
