#!/usr/bin/env node
/**
 * Bytecode gate for the v2 contracts (run after `hardhat compile`; exits 1 on violation).
 *
 *  - DarkSafeVault: no DELEGATECALL, CALLCODE or SELFDESTRUCT (invariant I1), no CREATE/CREATE2.
 *  - Every v2 contract: no opcode introduced after the Paris fork (PUSH0, TLOAD, TSTORE,
 *    MCOPY, BLOBHASH, BLOBBASEFEE), so the code does not depend on Quai's EVM version.
 *
 * Runtime code is walked instruction by instruction (PUSH data skipped) after stripping the
 * trailing CBOR metadata. The factory embeds the proxy's creation code as data, so only the
 * fork check (which also holds for that data) is applied to it, not the DELEGATECALL check.
 */
const fs = require('node:fs');
const path = require('node:path');

const ART = path.resolve(__dirname, '../artifacts/contracts/v2');
const POST_PARIS = { 0x5f: 'PUSH0', 0x5c: 'TLOAD', 0x5d: 'TSTORE', 0x5e: 'MCOPY', 0x49: 'BLOBHASH', 0x4a: 'BLOBBASEFEE' };
const DANGEROUS = { 0xf4: 'DELEGATECALL', 0xf2: 'CALLCODE', 0xff: 'SELFDESTRUCT', 0xf0: 'CREATE', 0xf5: 'CREATE2' };

function stripMetadata(bytes) {
  if (bytes.length < 2) return bytes;
  const cborLength = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  return cborLength + 2 <= bytes.length ? bytes.subarray(0, bytes.length - cborLength - 2) : bytes;
}

function opcodes(hex) {
  const bytes = stripMetadata(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
  const found = new Map();
  for (let i = 0; i < bytes.length; ) {
    const op = bytes[i];
    found.set(op, (found.get(op) || 0) + 1);
    i += op >= 0x60 && op <= 0x7f ? op - 0x5e : 1;
  }
  return found;
}

const checks = [
  { contract: 'DarkSafeVault', forbid: { ...POST_PARIS, ...DANGEROUS } },
  { contract: 'DarkSafeVaultProxy', forbid: { ...POST_PARIS, 0xf2: 'CALLCODE', 0xff: 'SELFDESTRUCT' } },
  { contract: 'DarkSafeVaultFactory', forbid: { ...POST_PARIS, 0xff: 'SELFDESTRUCT' } },
];

let failed = false;
for (const { contract, forbid } of checks) {
  const file = path.join(ART, `${contract}.sol`, `${contract}.json`);
  if (!fs.existsSync(file)) {
    console.error(`missing artifact for ${contract}; run hardhat compile first`);
    process.exit(1);
  }
  const art = JSON.parse(fs.readFileSync(file, 'utf8'));
  const found = opcodes(art.deployedBytecode);
  const hits = Object.entries(forbid)
    .filter(([op]) => found.has(Number(op)))
    .map(([op, name]) => `${name} x${found.get(Number(op))}`);
  if (hits.length) {
    failed = true;
    console.error(`FAIL ${contract}: ${hits.join(', ')}`);
  } else {
    console.log(`ok   ${contract}: none of ${Object.values(forbid).join(', ')}`);
  }
}
process.exit(failed ? 1 : 0);
