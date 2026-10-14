#!/usr/bin/env node
/**
 * Static gate for Dark Questate. Fails on things a unit test would not notice:
 *  - a required file is missing (brand assets, contracts, deploy tooling)
 *  - something from the b6 build comes back: its name, its fake "bafybeib6" CIDs, the embedded
 *    random-key signer, or the Quaiswap pool address it presented as a brokerage admin
 *  - mainnet is configured with anything but chain 9
 *  - a production build (if one exists) contains the local dev wallet
 *
 *   node scripts/integrity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const REQUIRED = [
  'apps/web/public/0.png',
  'apps/web/public/Boltfont.png',
  'packages/contracts/contracts/QuestateDeed.sol',
  'packages/contracts/contracts/QuestateBrokerage.sol',
  'packages/contracts/contracts/interfaces/IERC6065.sol',
  'packages/contracts/scripts/deploy-quai.mjs',
  'packages/contracts/scripts/keystore-new.mjs',
  'packages/core/src/deployments.ts',
  'scripts/local-market.mjs',
];
for (const f of REQUIRED) check(fs.existsSync(path.join(ROOT, f)), `exists: ${f}`);

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'artifacts', 'cache', '.turbo', 'typechain-types', '.venv-slither', 'reports'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx|mjs|js|cjs|sol|html|json|md)$/.test(e.name) && e.name !== 'pnpm-lock.yaml') yield p;
  }
}

const LEGACY = [
  [/\bbafybeib6/, 'fake "bafybeib6" CID from the b6 pipeline'],
  [/0x003B4b96bF0793EB1D53B79f8c38746A298eEef8/i, 'Quaiswap Q0/WQUAI pool address that b6 labelled as its admin'],
  [/@b6\//, 'old @b6/* package scope'],
  [/B6 Real Estate|B6 Monorepo|\bB6-PROP\b/, 'old B6 product name'],
  [/DualSignerEngine|Wallet\.createRandom\(\)\s*;?\s*\/\/\s*Default testnet key/, 'embedded random-key signer'],
];
// Code only: the README may describe what the b6 build did.
const self = path.join('scripts', 'integrity.mjs');
let legacyHits = 0;
for (const file of sources(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (rel === self || rel.endsWith('.md')) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const [re, what] of LEGACY) {
    if (re.test(text)) {
      legacyHits++;
      check(false, `${rel}: ${what}`);
    }
  }
}
if (!legacyHits) check(true, 'no legacy b6 names, fake CIDs or misattributed addresses in code');

const config = fs.readFileSync(path.join(ROOT, 'packages/core/src/config.ts'), 'utf8');
const mainnet = config.match(/export const MAINNET[\s\S]*?chainId:\s*(\d+)/);
check(mainnet?.[1] === '9', `mainnet chain id is 9 (found ${mainnet?.[1] ?? 'none'})`);
const orchard = config.match(/export const ORCHARD[\s\S]*?chainId:\s*(\d+)/);
check(orchard?.[1] === '15000', `Orchard chain id is 15000 (found ${orchard?.[1] ?? 'none'})`);

const html = fs.readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8');
check(html.includes('href="./0.png"') && html.includes('<title>Dark Questate</title>'), 'index.html: Dark Questate title and 0.png favicon');

const env = fs.readFileSync(path.join(ROOT, 'apps/web/src/lib/env.ts'), 'utf8');
const browserNets = env.match(/BROWSER_DEPLOYMENT_NETWORKS[^=]*=\s*\[([^\]]*)\]/);
check(Boolean(browserNets) && !/mainnet/.test(browserNets[1]), 'mainnet addresses never come from browser storage');

const dist = path.join(ROOT, 'apps/web/dist');
if (fs.existsSync(dist)) {
  const bundle = [...sources(dist)].filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  check(!bundle.includes('Dev wallet (local Hardhat)') && !bundle.includes('hardhat_setBalance'), 'production bundle has no local dev wallet');
  const builtHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const csp = builtHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? '';
  check(/script-src 'self'(;|$)/.test(csp) && /object-src 'none'/.test(csp), "production index.html carries the CSP (script-src 'self', object-src 'none')");
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(builtHtml), 'production index.html has no inline scripts');
} else {
  console.log('  SKIP  production bundle check (apps/web/dist not built)');
}

if (failures.length) {
  console.error(`\n${failures.length} integrity failure(s).`);
  process.exit(1);
}
console.log('\nintegrity: all checks passed');
