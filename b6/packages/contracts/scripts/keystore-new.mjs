#!/usr/bin/env node
/**
 * Creates a fresh Cyprus-1 deployer key in an encrypted JSON keystore.
 *
 *   node scripts/keystore-new.mjs keystores/deployer.keystore.json
 *
 * The password is typed at a hidden prompt (or read from QUESTATE_KEYSTORE_PASSWORD_FILE). The key
 * itself is never printed; only its address is, so you can fund it from your own wallet.
 * keystores/ and *.keystore.json are git-ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Wallet, getZoneForAddress, isQiAddress, Zone } from 'quais';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/keystore-new.mjs <output.keystore.json>');
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite a key`);
  process.exit(1);
}

async function hidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => (s.includes(question) ? write(s) : undefined);
  const a = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return a;
}

const pwFile = process.env.QUESTATE_KEYSTORE_PASSWORD_FILE;
let password;
if (pwFile) password = fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '');
else {
  if (!process.stdin.isTTY) {
    console.error('no TTY for the password prompt; set QUESTATE_KEYSTORE_PASSWORD_FILE');
    process.exit(1);
  }
  password = await hidden('New keystore password: ');
  if (password !== (await hidden('Repeat it: '))) {
    console.error('passwords differ');
    process.exit(1);
  }
}
if (password.length < 12) {
  console.error('use a password of at least 12 characters');
  process.exit(1);
}

let wallet;
do wallet = Wallet.createRandom();
while (getZoneForAddress(wallet.address) !== Zone.Cyprus1 || isQiAddress(wallet.address));

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, await wallet.encrypt(password), { mode: 0o600 });
console.log(`wrote ${out}`);
console.log(`address ${wallet.address} (Cyprus-1). Fund it from your own wallet before a --broadcast.`);
