#!/usr/bin/env node
/**
 * Creates an encrypted keystore for a new Cyprus-1 Quai account (the deployer, or the three
 * owners of an Orchard soak run).
 *
 *   node scripts/new-keystore.mjs --out deployer.json
 *
 * The password comes from the file named by DARKSAFE_KEYSTORE_PASSWORD_FILE, or is typed twice
 * at a hidden prompt; it must be at least 12 characters. The file is written with owner-only
 * permissions and never overwritten. Only the address is printed: the key never leaves the
 * encrypted file. Keep keystores out of the repository (*.keystore.json and keystores/ are
 * gitignored) and back them up with the password stored separately.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Wallet, getZoneForAddress, isQiAddress, Zone } from 'quais';

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function hiddenPrompt(question) {
  if (!process.stdin.isTTY) fail('no TTY for the password prompt; set DARKSAFE_KEYSTORE_PASSWORD_FILE');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => (s.includes(question) ? write(s) : undefined);
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const i = process.argv.indexOf('--out');
const out = i > 0 ? process.argv[i + 1] : fail('usage: node scripts/new-keystore.mjs --out <file.json>');
if (fs.existsSync(out)) fail(`${out} already exists; refusing to overwrite a keystore`);

let password;
const pwFile = process.env.DARKSAFE_KEYSTORE_PASSWORD_FILE;
if (pwFile) {
  password = fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '');
} else {
  password = await hiddenPrompt('New keystore password: ');
  if ((await hiddenPrompt('Repeat the password: ')) !== password) fail('the passwords do not match');
}
if (password.length < 12) fail('use a password of at least 12 characters');

// Quai accounts must sit in the Cyprus-1 zone on the Quai (not Qi) ledger: about 1 key in 512.
let wallet;
for (;;) {
  wallet = new Wallet('0x' + crypto.randomBytes(32).toString('hex'));
  if (getZoneForAddress(wallet.address) === Zone.Cyprus1 && !isQiAddress(wallet.address)) break;
}
const json = await wallet.encrypt(password);
fs.writeFileSync(out, json, { mode: 0o600, flag: 'wx' });
console.log(`wrote ${out} for ${wallet.address}`);
console.log('Fund this address before using it. Keep the file and its password in separate, safe places.');
