#!/usr/bin/env node
/**
 * Creates an encrypted Quai deployer keystore for deploy-quai.mjs.
 *
 *   node scripts/keystore-new.mjs k.json
 *
 * The key is ground until its address lands in Cyprus-1 (0x00 zone, Quai ledger), then
 * encrypted under a password typed at a hidden prompt (or read from the file named by
 * DARKORDER_KEYSTORE_PASSWORD_FILE). The raw key is never printed or stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { Wallet, getZoneForAddress, isQiAddress, Zone } from 'quais';

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const out = process.argv[2];
if (!out) fail('usage: node scripts/keystore-new.mjs <keystore.json>');
if (fs.existsSync(out)) fail(`${out} exists; refusing to overwrite`);

const isCyprus1Quai = (a) => getZoneForAddress(a) === Zone.Cyprus1 && !isQiAddress(a);

async function hiddenPrompt(question) {
  if (!process.stdin.isTTY) fail('no TTY for the password prompt; set DARKORDER_KEYSTORE_PASSWORD_FILE');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => (s.includes(question) ? write(s) : undefined);
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const pwFile = process.env.DARKORDER_KEYSTORE_PASSWORD_FILE;
const password = pwFile ? fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '') : await hiddenPrompt('New keystore password: ');
if (password.length < 8) fail('password must be at least 8 characters');

let wallet;
do wallet = new Wallet('0x' + crypto.randomBytes(32).toString('hex'));
while (!isCyprus1Quai(wallet.address));

const json = await wallet.encrypt(password);
fs.writeFileSync(out, json, { mode: 0o600 });
console.log(`wrote ${path.resolve(out)}`);
console.log(`deployer ${wallet.address} (Cyprus-1)`);
console.log('fund it, then: node scripts/deploy-quai.mjs --network orchard --keystore ' + out + ' --broadcast');
