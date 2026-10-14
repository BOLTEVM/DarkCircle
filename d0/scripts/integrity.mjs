#!/usr/bin/env node
/**
 * Static gate for DarkOrder. Fails on things a unit test would not notice:
 *  - a required file is missing (brand assets, contracts, deploy tooling)
 *  - names from the templates leak back: @darkquestate/*, b6 CIDs, the old product names
 *  - mainnet is configured with anything but chain 9, Orchard with anything but 15000
 *  - the site title or favicon is wrong
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
  'packages/contracts/contracts/Guild.sol',
  'packages/contracts/contracts/GovernanceToken.sol',
  'packages/contracts/contracts/MajorityVoting.sol',
  'packages/contracts/contracts/CouncilMultisig.sol',
  'packages/contracts/contracts/GuildNameRegistry.sol',
  'packages/contracts/contracts/GuildFactory.sol',
  'packages/contracts/contracts/TokenStackDeployer.sol',
  'packages/contracts/scripts/deploy-quai.mjs',
  'packages/contracts/scripts/keystore-new.mjs',
  'packages/core/src/deployments.ts',
  'packages/core/src/voice/grammar.ts',
  'packages/core/src/x402/challenge.ts',
];
for (const f of REQUIRED) check(fs.existsSync(path.join(ROOT, f)), `exists: ${f}`);

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'artifacts', 'cache', '.turbo', 'typechain-types'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx|mjs|js|cjs|sol|html|json|md)$/.test(e.name) && e.name !== 'pnpm-lock.yaml') yield p;
  }
}

const LEGACY = [
  [/\bbafybeib6/, 'fake "bafybeib6" CID from the b6 pipeline'],
  [/0x003B4b96bF0793EB1D53B79f8c38746A298eEef8/i, 'Quaiswap Q0/WQUAI pool address that b6 labelled as its admin'],
  [/@darkquestate\//, 'Dark Questate package scope'],
  [/Dark Questate|QuestateDeed|QuestateBrokerage/, 'Dark Questate product names'],
  [/@b6\//, 'old @b6/* package scope'],
  [/DualSignerEngine|Wallet\.createRandom\(\)\s*;?\s*\/\/\s*Default testnet key/, 'embedded random-key signer'],
];
// Code only: the README may describe what the templates did.
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
if (!legacyHits) check(true, 'no template names, fake CIDs or misattributed addresses in code');

const config = fs.readFileSync(path.join(ROOT, 'packages/core/src/config.ts'), 'utf8');
const mainnet = config.match(/export const MAINNET[\s\S]*?chainId:\s*(\d+)/);
check(mainnet?.[1] === '9', `mainnet chain id is 9 (found ${mainnet?.[1] ?? 'none'})`);
const orchard = config.match(/export const ORCHARD[\s\S]*?chainId:\s*(\d+)/);
check(orchard?.[1] === '15000', `Orchard chain id is 15000 (found ${orchard?.[1] ?? 'none'})`);

const html = fs.readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8');
check(html.includes('href="./0.png"') && html.includes('<title>DarkOrder · Grand Guild Halls</title>'), 'index.html: DarkOrder title and 0.png favicon');

// The voice grammar must never accept an address by voice: tokenize would shred it, so the
// raw-text check has to come first in parseCommand.
const grammar = fs.readFileSync(path.join(ROOT, 'packages/core/src/voice/grammar.ts'), 'utf8');
check(
  grammar.indexOf('0x[0-9a-fA-F]{6,}') !== -1 && grammar.indexOf('0x[0-9a-fA-F]{6,}') < grammar.indexOf('canonicalize(text)'),
  'voice grammar rejects addresses before tokenization'
);

const dist = path.join(ROOT, 'apps/web/dist');
if (fs.existsSync(dist)) {
  const bundle = [...sources(dist)]
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  check(!bundle.includes('Dev wallet (local Hardhat)') && !bundle.includes('hardhat_setBalance'), 'production bundle has no local dev wallet');
} else {
  console.log('  SKIP  production bundle check (apps/web/dist not built)');
}

if (failures.length) {
  console.error(`\n${failures.length} integrity failure(s).`);
  process.exit(1);
}
console.log('\nintegrity: all checks passed');
