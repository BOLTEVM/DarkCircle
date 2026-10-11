#!/usr/bin/env node
/**
 * Fails unless the v2 vault's coverage meets the bar set in the security plan.
 * Run after `hardhat coverage` (reads coverage/coverage-summary.json).
 */
const fs = require('node:fs');
const path = require('node:path');

const SUMMARY = path.resolve(__dirname, '../coverage/coverage-summary.json');
const GATES = [
  { file: 'contracts/v2/SafeBuddyVault.sol', branches: 95, lines: 98, functions: 100 },
  { file: 'contracts/v2/SafeBuddyVaultFactory.sol', branches: 90, lines: 95, functions: 100 },
];

if (!fs.existsSync(SUMMARY)) {
  console.error('coverage/coverage-summary.json not found; run `hardhat coverage` first.');
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));

let failed = false;
for (const gate of GATES) {
  const key = Object.keys(summary).find((k) => k.replace(/\\/g, '/').endsWith(gate.file));
  if (!key) {
    console.error(`FAIL ${gate.file}: not in the coverage report`);
    failed = true;
    continue;
  }
  const s = summary[key];
  const results = ['branches', 'lines', 'functions'].map((metric) => {
    const pct = s[metric].pct;
    const ok = pct >= gate[metric];
    if (!ok) failed = true;
    return `${metric} ${pct}% (min ${gate[metric]}%)${ok ? '' : ' <-- below gate'}`;
  });
  console.log(`${gate.file}: ${results.join(', ')}`);
}
process.exit(failed ? 1 : 0);
