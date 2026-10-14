#!/usr/bin/env node
/**
 * DarkCircle relayer keystore helper
 * File: scripts/relayer-key.ts
 *
 * Creates the encrypted keystore the production relayer opens at start (RELAYER_PLAN.md §3.1).
 * The passphrase is read from the environment, never from an argument — it must not land in shell
 * history or process listings. Usage:
 *
 *   RELAYER_PASSPHRASE='...' node scripts/relayer-key.ts --out /secure/path/relayer-keystore.json
 *
 * Prints the relayer address on stdout (fund THIS address with QUAI for gas).
 */

import fs from "node:fs";
import path from "node:path";
import { WalletQuaiSigner } from "../src/relayer/signer.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
if (outIdx < 0 || !args[outIdx + 1]) {
  console.error("usage: RELAYER_PASSPHRASE='...' node scripts/relayer-key.ts --out <keystore.json>");
  process.exit(2);
}
const out = path.resolve(args[outIdx + 1]);
if (fs.existsSync(out)) {
  console.error(`refusing to overwrite an existing keystore: ${out}`);
  process.exit(2);
}
const passphrase = process.env.RELAYER_PASSPHRASE;
if (!passphrase || passphrase.length < 12) {
  console.error("RELAYER_PASSPHRASE must be set and at least 12 characters");
  process.exit(2);
}

const address = await WalletQuaiSigner.createKeystoreFile(out, passphrase);
console.log(`keystore written: ${out}`);
console.log(`relayer address (fund with QUAI for gas): ${address}`);
