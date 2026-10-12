#!/usr/bin/env node
/**
 * Deploys the DarkSafe v2 implementation and factory to Quai Cyprus-1.
 *
 *   node scripts/deploy-v2.mjs --network orchard --from 0x00...        simulate only (default)
 *   node scripts/deploy-v2.mjs --network orchard --sign-only           sign with a throwaway key, never send
 *   node scripts/deploy-v2.mjs --network orchard --keystore k.json --broadcast
 *   node scripts/deploy-v2.mjs --network mainnet --keystore k.json --broadcast --mainnet-audited <audited-git-tag>
 *
 * Key handling: the deployer key comes only from an encrypted JSON keystore. The password
 * is read from the file named by DARKSAFE_KEYSTORE_PASSWORD_FILE, or typed at a hidden
 * prompt. There is no private-key flag or env var, and the key is never printed.
 *
 * Quai specifics handled here (see packages/core/src/tx.ts for the reasons):
 *  - CREATE addresses must land in Cyprus-1, so a 4-byte salt is appended to the init
 *    data and bumped until the predicted address is in-zone (constructors ignore it).
 *  - Creation gas is sized from runtime bytes, never from quai_estimateGas.
 *  - Receipts are polled over raw JSON-RPC and must reach N confirmations.
 *  - After deployment, the implementation's on-chain code hash and the factory's
 *    implementation/proxyCodeHash are checked against the compiled artifacts.
 *
 * A broadcast records deployments/v2-<network>.json (it refuses to overwrite an existing
 * record unless --replace is given) and regenerates packages/core/src/pinned.ts from it,
 * which is how the app and tools learn the factory address. Review and commit both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  Wallet,
  JsonRpcProvider,
  QuaiTransaction,
  getCreateAddress,
  getZoneForAddress,
  isQiAddress,
  getAddress,
  keccak256,
  AbiCoder,
  Interface,
  Zone,
} from 'quais';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const NETWORKS = {
  orchard: { chainId: 15000n, rpc: 'https://orchard.rpc.quai.network/cyprus1', pathingBase: 'https://orchard.rpc.quai.network', confirmations: 6 },
  mainnet: { chainId: 9n, rpc: 'https://rpc.quai.network/cyprus1', pathingBase: 'https://rpc.quai.network', confirmations: 3 },
};
const CREATION_GAS_PER_RUNTIME_BYTE = 1250n;
const MAX_GAS_LIMIT = 45_000_000n;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // pnpm forwards a bare -- separator
    if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (['broadcast', 'sign-only', 'replace'].includes(key)) out.flags.add(key);
    else if (['network', 'from', 'keystore', 'confirmations', 'mainnet-audited'].includes(key)) out[key] = argv[++i];
    else fail(`unknown option ${a}`);
  }
  return out;
}

function artifact(name) {
  const file = path.join(ROOT, 'artifacts/contracts/v2', `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) fail(`missing ${file}; run hardhat compile first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

function isCyprus1Quai(address) {
  return getZoneForAddress(address) === Zone.Cyprus1 && !isQiAddress(address);
}

function grind(from, nonce, data) {
  let salt = nonce >>> 0;
  for (let attempt = 1; attempt <= 200_000; attempt++) {
    const candidate = data + salt.toString(16).padStart(8, '0');
    const predicted = getCreateAddress({ from, nonce, data: candidate });
    if (isCyprus1Quai(predicted)) return { data: candidate, predicted };
    salt = (salt + 1) >>> 0;
  }
  throw new Error('could not grind an in-zone contract address');
}

function creationGasLimit(runtimeHex) {
  const wanted = BigInt((runtimeHex.length - 2) / 2) * CREATION_GAS_PER_RUNTIME_BYTE;
  return wanted < MAX_GAS_LIMIT ? wanted : MAX_GAS_LIMIT;
}

function fmtQuai(wei) {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${frac} QUAI`;
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

async function loadKeystoreWallet(file, provider) {
  if (!fs.existsSync(file)) fail(`keystore ${file} not found`);
  const pwFile = process.env.DARKSAFE_KEYSTORE_PASSWORD_FILE;
  const password = pwFile ? fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '') : await hiddenPrompt('Keystore password: ');
  const wallet = await Wallet.fromEncryptedJson(fs.readFileSync(file, 'utf8'), password);
  return wallet.connect(provider);
}

async function waitConfirmed(net, hash, confirmations) {
  const deadline = Date.now() + 30 * 60_000;
  let seenBlock = null;
  while (Date.now() < deadline) {
    const r = await rpc(net.rpc, 'quai_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.blockNumber) {
      if (seenBlock !== null && r.blockHash !== seenBlock) console.log('  receipt moved block (reorg); recounting');
      seenBlock = r.blockHash;
      const head = BigInt(await rpc(net.rpc, 'quai_blockNumber', []));
      const depth = Number(head - BigInt(r.blockNumber)) + 1;
      process.stdout.write(`\r  confirmations ${Math.min(depth, confirmations)}/${confirmations}   `);
      if (depth >= confirmations) {
        const again = await rpc(net.rpc, 'quai_getTransactionReceipt', [hash]);
        if (again?.blockHash === r.blockHash) {
          process.stdout.write('\n');
          return again;
        }
      }
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`no confirmed receipt for ${hash} after 30 minutes; check the explorer before retrying`);
}

/**
 * Mainnet only ever gets the audited code: HEAD must be the audited git tag, the contracts and
 * pins must have no uncommitted changes, and the compiled artifacts must match the pins.
 */
function assertAuditedCheckout(tag) {
  if (!tag || tag.startsWith('--')) {
    fail('refusing a mainnet broadcast without --mainnet-audited <git tag of the audited commit>: v2 has not had an independent audit yet');
  }
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  let tagged;
  try {
    tagged = git('rev-list', '-n', '1', tag);
  } catch {
    fail(`git tag ${tag} does not exist`);
  }
  if (tagged !== git('rev-parse', 'HEAD')) fail(`HEAD is not the audited tag ${tag}; check it out first`);
  const dirty = git('status', '--porcelain', '--', 'contracts', 'scripts', 'hardhat.config.cjs', '../core/src/pinned.ts');
  if (dirty) fail(`uncommitted changes in the contracts or pins:\n${dirty}`);
  try {
    execFileSync(process.execPath, [path.join(HERE, 'pin-bytecode.js'), '--check'], { stdio: 'pipe' });
  } catch {
    fail('the compiled artifacts do not match pinned.ts; run a clean `hardhat compile --force` at the tag');
  }
  console.log(`audited checkout confirmed: ${tag} (${tagged.slice(0, 12)})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const net = NETWORKS[args.network];
  if (!net) fail('--network orchard|mainnet is required');
  const broadcast = args.flags.has('broadcast');
  const signOnly = args.flags.has('sign-only');
  if (broadcast && signOnly) fail('--broadcast and --sign-only are exclusive');
  if (args.network === 'mainnet' && broadcast) assertAuditedCheckout(args['mainnet-audited']);
  const confirmations = Number(args.confirmations ?? net.confirmations);
  const recordPath = path.join(ROOT, 'deployments', `v2-${args.network}.json`);
  if (broadcast && fs.existsSync(recordPath) && !args.flags.has('replace')) {
    fail(`${path.relative(process.cwd(), recordPath)} already exists; pass --replace to deploy a new factory over it`);
  }

  const chainId = BigInt(await rpc(net.rpc, 'quai_chainId', []));
  if (chainId !== net.chainId) fail(`RPC reports chain ${chainId}, expected ${net.chainId}`);

  const provider = new JsonRpcProvider(net.pathingBase, undefined, { usePathing: true });
  let wallet = null;
  if (broadcast) {
    if (!args.keystore) fail('--broadcast needs --keystore <encrypted json>');
    wallet = await loadKeystoreWallet(args.keystore, provider);
  } else if (signOnly) {
    // A throwaway key proves grinding, populating and signing work end to end; nothing is sent.
    let key;
    do {
      key = new Wallet('0x' + crypto.randomBytes(32).toString('hex'), provider);
    } while (!isCyprus1Quai(key.address));
    wallet = key;
  }
  const deployer = getAddress(wallet ? wallet.address : args.from ?? fail('pass --from <Cyprus-1 address> to simulate'));
  if (!isCyprus1Quai(deployer)) fail(`deployer ${deployer} is not a Cyprus-1 Quai address`);

  const vaultArt = artifact('DarkSafeVault');
  const factoryArt = artifact('DarkSafeVaultFactory');
  const proxyArt = artifact('DarkSafeVaultProxy');
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  const balance = BigInt(await rpc(net.rpc, 'quai_getBalance', [deployer, 'latest']));
  let nonce = parseInt(await rpc(net.rpc, 'quai_getTransactionCount', [deployer, 'pending']), 16);

  console.log(`network ${args.network} (chain ${chainId})  deployer ${deployer}  balance ${fmtQuai(balance)}`);
  console.log(`mode ${broadcast ? 'BROADCAST' : signOnly ? 'sign-only (throwaway key, nothing sent)' : 'simulate'}`);

  const plan = [];
  const implGround = grind(deployer, nonce, vaultArt.bytecode);
  plan.push({ label: 'DarkSafeVault (implementation)', data: implGround.data, predicted: implGround.predicted, gasLimit: creationGasLimit(vaultArt.deployedBytecode), nonce });
  const factoryData = factoryArt.bytecode + AbiCoder.defaultAbiCoder().encode(['address'], [implGround.predicted]).slice(2);
  const factGround = grind(deployer, nonce + 1, factoryData);
  plan.push({ label: 'DarkSafeVaultFactory', data: factGround.data, predicted: factGround.predicted, gasLimit: creationGasLimit(factoryArt.deployedBytecode), nonce: nonce + 1 });

  let total = 0n;
  for (const step of plan) {
    total += step.gasLimit * gasPrice;
    console.log(`  ${step.label.padEnd(34)} -> ${step.predicted}  gas limit ${step.gasLimit}  <= ${fmtQuai(step.gasLimit * gasPrice)}`);
  }
  console.log(`  worst case total ${fmtQuai(total)} at gas price ${gasPrice}`);

  // The implementation can be simulated as-is. The factory's constructor requires code at the
  // implementation address, which only exists after the first deployment, so it is simulated then.
  await rpc(net.rpc, 'quai_call', [{ from: deployer, data: plan[0].data }, 'latest']);
  console.log('  implementation creation simulates cleanly');

  if (!broadcast && !signOnly) return;
  if (broadcast && balance < total) fail(`balance ${fmtQuai(balance)} is below the worst case ${fmtQuai(total)}`);

  const results = [];
  for (const step of plan) {
    if (step.label.startsWith('DarkSafeVaultFactory')) {
      if (signOnly) {
        console.log(`  ${step.label}: not signed; its constructor needs the implementation on chain, which sign-only never creates`);
        continue;
      }
      await rpc(net.rpc, 'quai_call', [{ from: deployer, data: step.data }, 'latest']);
    }
    const pop = await wallet.populateQuaiTransaction({ from: deployer, data: step.data, nonce: step.nonce, gasLimit: step.gasLimit });
    if (Number(pop.nonce) !== step.nonce || pop.data !== step.data) fail(`${step.label}: populated tx diverged from the ground one; not sending`);
    const signed = await wallet.signTransaction(QuaiTransaction.from(pop));
    if (signOnly) {
      console.log(`  ${step.label}: signed ${signed.length / 2 - 1} bytes, would create ${step.predicted}`);
      continue;
    }
    const zone = await wallet.zoneFromAddress(deployer);
    const resp = await provider.broadcastTransaction(zone, signed, deployer);
    console.log(`  ${step.label}: sent ${resp.hash}`);
    const receipt = await waitConfirmed(net, resp.hash, confirmations);
    if (parseInt(receipt.status, 16) !== 1) fail(`${step.label} reverted (tx ${resp.hash})`);
    const created = getAddress(receipt.contractAddress);
    if (created !== step.predicted) fail(`${step.label} landed at ${created}, expected ${step.predicted}`);
    results.push({
      label: step.label,
      address: created,
      txHash: resp.hash,
      blockNumber: parseInt(receipt.blockNumber, 16),
      gasUsed: BigInt(receipt.gasUsed).toString(),
      gasLimit: step.gasLimit.toString(),
    });
  }
  if (signOnly) return;

  // Post-deploy verification against the compiled artifacts.
  const implCode = await rpc(net.rpc, 'quai_getCode', [results[0].address, 'latest']);
  if (keccak256(implCode) !== keccak256(vaultArt.deployedBytecode)) fail('implementation code on chain does not match the artifact');
  const factory = new Interface(factoryArt.abi);
  const readFactory = async (fn) =>
    factory.decodeFunctionResult(fn, await rpc(net.rpc, 'quai_call', [{ to: results[1].address, data: factory.encodeFunctionData(fn) }, 'latest']))[0];
  if (getAddress(await readFactory('implementation')) !== results[0].address) fail('factory points at the wrong implementation');
  if ((await readFactory('proxyCodeHash')) !== keccak256(proxyArt.deployedBytecode)) fail('factory proxyCodeHash does not match the proxy artifact');
  console.log('  verified: implementation code hash, factory.implementation, factory.proxyCodeHash');

  const record = {
    network: args.network,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer,
    implementation: results[0],
    factory: results[1],
    implementationCodeHash: keccak256(vaultArt.deployedBytecode),
    proxyCodeHash: keccak256(proxyArt.deployedBytecode),
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    auditedTag: args['mainnet-audited'] ?? null,
  };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  console.log(`recorded ${path.relative(process.cwd(), recordPath)}`);
  execFileSync(process.execPath, [path.join(HERE, 'pin-bytecode.js')], { stdio: 'inherit' });
  console.log('pinned.ts now lists this deployment; review and commit both files.');
}

main().catch((err) => fail(err?.message ?? String(err)));
