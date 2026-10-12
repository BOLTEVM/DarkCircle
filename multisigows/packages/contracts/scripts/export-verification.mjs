#!/usr/bin/env node
/**
 * Writes what a block explorer needs to verify the deployed v2 source code, from the exact
 * Hardhat compilation that produced the pinned bytecode (run at the deployed commit, after
 * `hardhat compile`):
 *
 *   node scripts/export-verification.mjs [--network orchard|mainnet]
 *
 * For each contract, deployments/verification/<Name>.json holds the fully qualified name, the
 * compiler version, the standard-JSON input, and (for deployed contracts, from
 * deployments/v2-<network>.json) the ABI-encoded constructor arguments. Upload the input with
 * "Solidity (Standard JSON input)" on the explorer. Vault proxies are created per vault: their
 * constructor arguments are abi.encode(implementation, initialize(owners, threshold, delay)).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, keccak256 } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--network');
const network = i > 0 ? process.argv[i + 1] : null;
const record = network ? JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `v2-${network}.json`), 'utf8')) : null;

const CONTRACTS = [
  { name: 'DarkSafeVault', source: 'contracts/v2/DarkSafeVault.sol', address: record?.implementation.address, args: '0x' },
  {
    name: 'DarkSafeVaultFactory',
    source: 'contracts/v2/DarkSafeVaultFactory.sol',
    address: record?.factory.address,
    args: record ? AbiCoder.defaultAbiCoder().encode(['address'], [record.implementation.address]) : null,
  },
  { name: 'DarkSafeVaultProxy', source: 'contracts/v2/DarkSafeVaultProxy.sol', address: null, args: null },
];

const outDir = path.join(ROOT, 'deployments', 'verification');
fs.mkdirSync(outDir, { recursive: true });
for (const c of CONTRACTS) {
  const dir = path.join(ROOT, 'artifacts', c.source);
  const art = JSON.parse(fs.readFileSync(path.join(dir, `${c.name}.json`), 'utf8'));
  const dbg = JSON.parse(fs.readFileSync(path.join(dir, `${c.name}.dbg.json`), 'utf8'));
  const buildInfo = JSON.parse(fs.readFileSync(path.resolve(dir, dbg.buildInfo.replace(/\\/g, '/')), 'utf8'));
  const entry = {
    contract: `${c.source}:${c.name}`,
    compilerVersion: `v${buildInfo.solcLongVersion}`,
    address: c.address ?? null,
    constructorArguments: c.args,
    runtimeCodeHash: keccak256(art.deployedBytecode),
    standardJsonInput: buildInfo.input,
  };
  fs.writeFileSync(path.join(outDir, `${c.name}.json`), JSON.stringify(entry, null, 2) + '\n');
  console.log(`${c.name}: ${entry.compilerVersion}${c.address ? ` at ${c.address}` : ''}`);
}
console.log(`written to ${path.relative(process.cwd(), outDir)}`);
