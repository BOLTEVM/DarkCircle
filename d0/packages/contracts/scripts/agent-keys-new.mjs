#!/usr/bin/env node
/**
 * Generates the DarkOrder corporate-agent key swarm on Quai Cyprus-1.
 *
 *   node scripts/agent-keys-new.mjs                 # full swarm (sovereign + 6 sybils)
 *   node scripts/agent-keys-new.mjs --out agents/keys
 *
 * Every key is ground until its address lands in Cyprus-1 (0x00 zone, Quai ledger), then
 * encrypted as an individual keystore under its own random password. The swarm must sign
 * unattended, so passwords live in keys/passwords.json (mode 0600, gitignored) instead of
 * the human prompt used by keystore-new.mjs. The raw private keys are never printed.
 *
 * Output:
 *   agents/keys/<role>-<i>.json   encrypted keystores (SECRET)
 *   agents/keys/passwords.json    keystore passwords      (SECRET)
 *   agents/manifest.json          roles + addresses only  (safe to commit)
 *
 * Only addresses are printed to stdout. Fund the sovereign; the brain funds the rest.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Wallet, getZoneForAddress, isQiAddress, Zone } from 'quais';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const outIdx = process.argv.indexOf('--out');
const KEYS_DIR = outIdx === -1 ? path.join(ROOT, 'agents', 'keys') : path.resolve(process.argv[outIdx + 1]);
const MANIFEST = path.join(ROOT, 'agents', 'manifest.json');

// The swarm. Parcels are whole-token shares of the initial 1000 supply; the brain
// distributes them in its DISTRIBUTE phase. Bloc math: threshold 50%, participation 10%,
// swarm holds 100% at founding and dilutes only if outsiders are ever admitted.
const ROSTER = [
  { role: 'sovereign', count: 1, parcel: 400, brief: 'founds the guild, holds the reserve, funds the swarm' },
  { role: 'director', count: 2, parcel: 150, brief: 'files construction and governance proposals' },
  { role: 'worker', count: 3, parcel: 90, brief: 'rank-and-file vote bloc, staggered timing' },
  { role: 'sentinel', count: 1, parcel: 30, brief: 'watches for hostile proposals, votes last, executes' },
];

const isCyprus1Quai = (a) => getZoneForAddress(a) === Zone.Cyprus1 && !isQiAddress(a);

if (fs.existsSync(MANIFEST)) fail(`${MANIFEST} exists; refusing to overwrite an existing swarm`);

fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });

const manifest = { createdAt: new Date().toISOString(), network: 'mainnet', zone: 'cyprus1', identities: [] };
const passwords = {};
let n = 0;
for (const { role, count, parcel, brief } of ROSTER) {
  for (let i = 0; i < count; i++) {
    const id = count === 1 ? role : `${role}-${i + 1}`;
    let wallet, tries = 0;
    do {
      wallet = new Wallet('0x' + crypto.randomBytes(32).toString('hex'));
      tries++;
    } while (!isCyprus1Quai(wallet.address));
    const password = crypto.randomBytes(24).toString('hex');
    const file = path.join(KEYS_DIR, `${id}.json`);
    fs.writeFileSync(file, await wallet.encrypt(password), { mode: 0o600 });
    passwords[id] = password;
    manifest.identities.push({ id, role, parcel, brief, address: wallet.address, keystore: path.relative(ROOT, file) });
    console.log(`${id.padEnd(12)} ${wallet.address}  (ground in ${tries} tries, parcel ${parcel})`);
    n++;
  }
}

fs.writeFileSync(path.join(KEYS_DIR, 'passwords.json'), JSON.stringify(passwords, null, 2) + '\n', { mode: 0o600 });
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
// Belt and braces: a .gitignore inside keys/ so the secrets stay local even if the
// repository-level ignore rules are ever restructured.
fs.writeFileSync(path.join(KEYS_DIR, '.gitignore'), '*\n!.gitignore\n');

console.log(`\n${n} identities written to ${path.relative(ROOT, KEYS_DIR)}/ (gitignored, mode 0600)`);
console.log(`manifest: ${path.relative(ROOT, MANIFEST)} (addresses only)`);
const sovereign = manifest.identities.find((i) => i.role === 'sovereign');
console.log(`\nfund the sovereign first: ${sovereign.address}`);
console.log('the brain (agents/corporate-brain.mjs) funds every sybil from the sovereign in its FUND phase.');
