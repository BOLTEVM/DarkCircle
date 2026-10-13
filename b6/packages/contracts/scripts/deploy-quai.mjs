#!/usr/bin/env node
/**
 * Deploys QuestateDeed and QuestateBrokerage to Quai Cyprus-1.
 *
 *   node scripts/deploy-quai.mjs --network orchard --from 0x00...                      simulate only (default)
 *   node scripts/deploy-quai.mjs --network orchard --sign-only                         sign with a throwaway key, send nothing
 *   node scripts/deploy-quai.mjs --network orchard --keystore k.json --broadcast
 *   node scripts/deploy-quai.mjs --network mainnet --keystore k.json --broadcast --i-understand-unaudited
 *
 *   --registrar 0x00...   owner of the deed registry (mints, services liens). Default: the deployer.
 *   --operator  0x00...   owner of the brokerage (brokers, pause). Default: the deployer.
 *   --replace             overwrite an existing deployment record for this network.
 *
 * Key handling: the deployer key comes only from an encrypted JSON keystore (see keystore-new.mjs).
 * The password is read from the file named by QUESTATE_KEYSTORE_PASSWORD_FILE, or typed at a
 * hidden prompt. There is no private-key flag or environment variable.
 *
 * Quai specifics (adapted from DarkSafe's deploy script, each learned on Cyprus-1):
 *  - A CREATE address must land in Cyprus-1, so a 4-byte salt is appended to the init data and
 *    bumped until the predicted address is in-zone. Constructors ignore trailing bytes.
 *  - Creation gas is sized from runtime bytes, never from quai_estimateGas (it has been off by
 *    0.43x to 2.5x). A revert burns the whole limit, so every step is simulated first.
 *  - Receipts are polled over raw JSON-RPC and must reach N confirmations; a reorg restarts the count.
 *
 * A broadcast writes deployments/<network>.json and regenerates packages/core/src/deployments.ts,
 * which is how the site learns the addresses. Rebuild and redeploy the site afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Wallet, JsonRpcProvider, QuaiTransaction, getCreateAddress, getZoneForAddress, isQiAddress, getAddress, keccak256, AbiCoder, Interface, Zone } from 'quais';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CORE_DEPLOYMENTS = path.resolve(ROOT, '../core/src/deployments.ts');

const NETWORKS = {
  orchard: { chainId: 15000n, rpc: 'https://orchard.rpc.quai.network/cyprus1', pathing: 'https://orchard.rpc.quai.network', confirmations: 6 },
  mainnet: { chainId: 9n, rpc: 'https://rpc.quai.network/cyprus1', pathing: 'https://rpc.quai.network', confirmations: 3 },
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
    if (a === '--') continue;
    if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (['broadcast', 'sign-only', 'replace', 'i-understand-unaudited'].includes(key)) out.flags.add(key);
    else if (['network', 'from', 'keystore', 'registrar', 'operator', 'confirmations'].includes(key)) out[key] = argv[++i];
    else fail(`unknown option ${a}`);
  }
  return out;
}

function artifact(name) {
  const file = path.join(ROOT, 'artifacts/contracts', `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) fail(`missing ${file}; run \`pnpm build\` first`);
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

const isCyprus1Quai = (a) => getZoneForAddress(a) === Zone.Cyprus1 && !isQiAddress(a);

function requireCyprus1(raw, what) {
  let a;
  try {
    a = getAddress(raw);
  } catch {
    fail(`${what} ${raw} is not an address`);
  }
  if (!isCyprus1Quai(a)) fail(`${what} ${a} is not a Cyprus-1 Quai address (0x00, second byte below 0x80)`);
  return a;
}

function grind(from, nonce, data) {
  let salt = nonce >>> 0;
  for (let attempt = 0; attempt < 200_000; attempt++) {
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
  return `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4)} QUAI`;
}

async function hiddenPrompt(question) {
  if (!process.stdin.isTTY) fail('no TTY for the password prompt; set QUESTATE_KEYSTORE_PASSWORD_FILE');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => (s.includes(question) ? write(s) : undefined);
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function loadKeystore(file, provider) {
  if (!fs.existsSync(file)) fail(`keystore ${file} not found`);
  const pwFile = process.env.QUESTATE_KEYSTORE_PASSWORD_FILE;
  const password = pwFile ? fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '') : await hiddenPrompt('Keystore password: ');
  return (await Wallet.fromEncryptedJson(fs.readFileSync(file, 'utf8'), password)).connect(provider);
}

async function waitConfirmed(net, hash, confirmations) {
  const deadline = Date.now() + 30 * 60_000;
  let seen = null;
  while (Date.now() < deadline) {
    const r = await rpc(net.rpc, 'quai_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.blockNumber) {
      if (seen !== null && r.blockHash !== seen) console.log('  receipt moved block (reorg); recounting');
      seen = r.blockHash;
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

function writeCoreDeployments(network, entry) {
  const src = fs.readFileSync(CORE_DEPLOYMENTS, 'utf8');
  const line = new RegExp(`^(  ${network}: ).*,$`, 'm');
  if (!line.test(src)) fail(`could not find the ${network} entry in ${CORE_DEPLOYMENTS}`);
  const value = `{ deed: '${entry.deed}', brokerage: '${entry.brokerage}', fromBlock: ${entry.fromBlock} }`;
  fs.writeFileSync(CORE_DEPLOYMENTS, src.replace(line, `$1${value},`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const net = NETWORKS[args.network];
  if (!net) fail('--network orchard|mainnet is required');
  const broadcast = args.flags.has('broadcast');
  const signOnly = args.flags.has('sign-only');
  if (broadcast && signOnly) fail('--broadcast and --sign-only are exclusive');
  if (args.network === 'mainnet' && broadcast && !args.flags.has('i-understand-unaudited')) {
    fail('refusing a mainnet broadcast: these contracts have not had an independent audit. Pass --i-understand-unaudited to proceed anyway.');
  }
  const confirmations = Number(args.confirmations ?? net.confirmations);
  const recordPath = path.join(ROOT, 'deployments', `${args.network}.json`);
  if (broadcast && fs.existsSync(recordPath) && !args.flags.has('replace')) fail(`${recordPath} exists; pass --replace to deploy over it`);

  const chainId = BigInt(await rpc(net.rpc, 'quai_chainId', []));
  if (chainId !== net.chainId) fail(`RPC reports chain ${chainId}, expected ${net.chainId}`);

  const provider = new JsonRpcProvider(net.pathing, undefined, { usePathing: true });
  let wallet = null;
  if (broadcast) {
    if (!args.keystore) fail('--broadcast needs --keystore <encrypted json>');
    wallet = await loadKeystore(args.keystore, provider);
  } else if (signOnly) {
    let key;
    do key = new Wallet('0x' + crypto.randomBytes(32).toString('hex'), provider);
    while (!isCyprus1Quai(key.address));
    wallet = key;
  }
  const deployer = requireCyprus1(wallet ? wallet.address : (args.from ?? fail('pass --from <Cyprus-1 address> to simulate')), 'deployer');
  const registrar = args.registrar ? requireCyprus1(args.registrar, 'registrar') : deployer;
  const operator = args.operator ? requireCyprus1(args.operator, 'operator') : deployer;

  const deedArt = artifact('QuestateDeed');
  const deskArt = artifact('QuestateBrokerage');
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  const balance = BigInt(await rpc(net.rpc, 'quai_getBalance', [deployer, 'latest']));
  const nonce = parseInt(await rpc(net.rpc, 'quai_getTransactionCount', [deployer, 'pending']), 16);
  const coder = AbiCoder.defaultAbiCoder();

  console.log(`network ${args.network} (chain ${chainId})  deployer ${deployer}  balance ${fmtQuai(balance)}`);
  console.log(`registrar ${registrar}  operator ${operator}`);
  console.log(`mode ${broadcast ? 'BROADCAST' : signOnly ? 'sign-only (throwaway key, nothing sent)' : 'simulate'}`);

  const deedGround = grind(deployer, nonce, deedArt.bytecode + coder.encode(['address'], [registrar]).slice(2));
  const deskGround = grind(deployer, nonce + 1, deskArt.bytecode + coder.encode(['address', 'address'], [deedGround.predicted, operator]).slice(2));
  const plan = [
    { label: 'QuestateDeed', ...deedGround, gasLimit: creationGasLimit(deedArt.deployedBytecode), nonce },
    { label: 'QuestateBrokerage', ...deskGround, gasLimit: creationGasLimit(deskArt.deployedBytecode), nonce: nonce + 1 },
  ];
  // The sum of both limits: conservative, since unused gas is refunded, but a revert burns its whole limit.
  const worstCase = plan.reduce((s, p) => s + p.gasLimit * gasPrice, 0n);
  for (const p of plan) console.log(`  ${p.label.padEnd(18)} -> ${p.predicted}  gas limit ${p.gasLimit}  <= ${fmtQuai(p.gasLimit * gasPrice)}`);
  console.log(`  worst case ${fmtQuai(worstCase)} at gas price ${gasPrice}`);

  // The registry simulates as-is. The brokerage's constructor checks the registry's ERC-165
  // answers, so it can only be simulated once the registry exists.
  await rpc(net.rpc, 'quai_call', [{ from: deployer, data: plan[0].data }, 'latest']);
  console.log('  QuestateDeed creation simulates cleanly');

  if (!broadcast && !signOnly) return;
  if (broadcast && balance < worstCase) fail(`balance ${fmtQuai(balance)} is below the worst case ${fmtQuai(worstCase)}`);

  const results = [];
  for (const step of plan) {
    if (step.label === 'QuestateBrokerage') {
      if (signOnly) {
        console.log('  QuestateBrokerage: not signed; its constructor needs the registry on chain, which sign-only never creates');
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
    results.push({ label: step.label, address: created, txHash: resp.hash, blockNumber: parseInt(receipt.blockNumber, 16), gasUsed: BigInt(receipt.gasUsed).toString() });
  }
  if (signOnly) return;

  // Verify what is on chain before telling the site about it.
  const [deedRes, deskRes] = results;
  const deedCode = await rpc(net.rpc, 'quai_getCode', [deedRes.address, 'latest']);
  if (keccak256(deedCode) !== keccak256(deedArt.deployedBytecode)) fail('QuestateDeed code on chain does not match the artifact');
  const read = async (art, to, fn) => {
    const iface = new Interface(art.abi);
    return iface.decodeFunctionResult(fn, await rpc(net.rpc, 'quai_call', [{ to, data: iface.encodeFunctionData(fn) }, 'latest']))[0];
  };
  if (getAddress(await read(deskArt, deskRes.address, 'deed')) !== deedRes.address) fail('the brokerage points at another registry');
  if (getAddress(await read(deskArt, deskRes.address, 'owner')) !== operator) fail('the brokerage owner is not the operator');
  if (getAddress(await read(deedArt, deedRes.address, 'owner')) !== registrar) fail('the registry owner is not the registrar');
  console.log('  verified: registry code hash, brokerage.deed(), both owners');

  const record = {
    network: args.network,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer,
    registrar,
    operator,
    deed: deedRes,
    brokerage: deskRes,
    deedCodeHash: keccak256(deedArt.deployedBytecode),
  };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  writeCoreDeployments(args.network, { deed: deedRes.address, brokerage: deskRes.address, fromBlock: deedRes.blockNumber });
  console.log(`recorded ${path.relative(process.cwd(), recordPath)} and updated packages/core/src/deployments.ts`);
  console.log('next: register at least one broker from the Registrar console, then rebuild and redeploy the site.');
}

main().catch((err) => fail(err?.message ?? String(err)));
