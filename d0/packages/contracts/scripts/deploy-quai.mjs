#!/usr/bin/env node
/**
 * Deploys the DarkOrder protocol (GuildNameRegistry + TokenStackDeployer + GuildFactory) to Quai Cyprus-1.
 *
 *   node scripts/deploy-quai.mjs --network orchard --from 0x00...                      simulate only (default)
 *   node scripts/deploy-quai.mjs --network orchard --sign-only                         sign with a throwaway key, send nothing
 *   node scripts/deploy-quai.mjs --network orchard --keystore k.json --broadcast
 *   node scripts/deploy-quai.mjs --network mainnet --keystore k.json --broadcast --i-understand-unaudited
 *
 *   --replace             overwrite an existing deployment record for this network.
 *
 * Key handling: the deployer key comes only from an encrypted JSON keystore (see keystore-new.mjs).
 * The password is read from the file named by DARKORDER_KEYSTORE_PASSWORD_FILE, or typed at a
 * hidden prompt. There is no private-key flag or environment variable.
 *
 * Quai specifics (adapted from the suite's earlier deploy scripts, each learned on Cyprus-1):
 *  - A CREATE address must land in Cyprus-1, so a 4-byte salt is appended to the init data and
 *    bumped until the predicted address is in-zone. Constructors ignore trailing bytes.
 *  - The registry's constructor takes the factory address, which is predicted from the
 *    deployer's next nonce, so the registry can trust the factory before it exists.
 *  - Creation gas is sized from runtime bytes, never from quai_estimateGas. A revert burns
 *    the whole limit, so every step is simulated first.
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
    else if (['network', 'from', 'keystore', 'confirmations'].includes(key)) out[key] = argv[++i];
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

/* --- codecheck: mirrors packages/core/src/codecheck.ts (kept inline: this script has no workspace deps) ---
 * The registry's `_deployer` and the factory's `registry`/`tokenStack` are Solidity immutables: the
 * build's deployedBytecode holds 32 zero bytes at each slot and the constructor fills them in, so
 * on-chain code never hashes like the artifact. Compare byte for byte, accepting a difference only
 * where a zeroed word of the build holds one of the expected values on chain. */
const WORD_HEX = 64;
const ZERO_WORD = '0'.repeat(WORD_HEX);

function runtimeMatchesBuild(onchain, buildRuntime, immutables = []) {
  const chain = onchain.slice(2).toLowerCase();
  const build = buildRuntime.slice(2).toLowerCase();
  if (chain.length === 0 || chain.length !== build.length) return false;
  if (immutables.length === 0) return chain === build;
  const words = new Set(immutables.map((v) => v.slice(2).toLowerCase().padStart(WORD_HEX, '0')));
  let filled = 0;
  let i = 0;
  while (i < chain.length) {
    if (chain[i] === build[i]) {
      i++;
      continue;
    }
    let matched = false;
    const earliest = Math.max(0, i - (WORD_HEX - 1));
    for (let start = i - (i % 2); start >= earliest; start -= 2) {
      if (start + WORD_HEX > build.length) continue;
      if (build.slice(start, start + WORD_HEX) !== ZERO_WORD) continue;
      if (!words.has(chain.slice(start, start + WORD_HEX))) continue;
      matched = true;
      filled++;
      i = start + WORD_HEX;
      break;
    }
    if (!matched) return false;
  }
  return filled > 0;
}

function fmtQuai(wei) {
  return `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4)} QUAI`;
}

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

async function loadKeystore(file, provider) {
  if (!fs.existsSync(file)) fail(`keystore ${file} not found`);
  const pwFile = process.env.DARKORDER_KEYSTORE_PASSWORD_FILE;
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
  const value = `{ factory: '${entry.factory}', registry: '${entry.registry}', fromBlock: ${entry.fromBlock} }`;
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

  const registryArt = artifact('GuildNameRegistry');
  const tokenStackArt = artifact('TokenStackDeployer');
  const factoryArt = artifact('GuildFactory');
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  const balance = BigInt(await rpc(net.rpc, 'quai_getBalance', [deployer, 'latest']));
  const nonce = parseInt(await rpc(net.rpc, 'quai_getTransactionCount', [deployer, 'pending']), 16);
  const coder = AbiCoder.defaultAbiCoder();

  console.log(`network ${args.network} (chain ${chainId})  deployer ${deployer}  balance ${fmtQuai(balance)}`);
  console.log(`mode ${broadcast ? 'BROADCAST' : signOnly ? 'sign-only (throwaway key, nothing sent)' : 'simulate'}`);

  // The registry takes no constructor arguments (see its `wire` note); the factory names the
  // registry and the token-stack deployer, so grind the registry first, then the token stack,
  // then the factory against both predicted addresses.
  const registryGround = grind(deployer, nonce, registryArt.bytecode);
  const tokenStackGround = grind(deployer, nonce + 1, tokenStackArt.bytecode);
  const factoryGround = grind(
    deployer,
    nonce + 2,
    factoryArt.bytecode + coder.encode(['address', 'address'], [registryGround.predicted, tokenStackGround.predicted]).slice(2)
  );

  const plan = [
    { label: 'GuildNameRegistry', ...registryGround, gasLimit: creationGasLimit(registryArt.deployedBytecode), nonce },
    { label: 'TokenStackDeployer', ...tokenStackGround, gasLimit: creationGasLimit(tokenStackArt.deployedBytecode), nonce: nonce + 1 },
    { label: 'GuildFactory', ...factoryGround, gasLimit: creationGasLimit(factoryArt.deployedBytecode), nonce: nonce + 2 },
  ];
  const worstCase = plan.reduce((s, p) => s + p.gasLimit * gasPrice, 0n) + 300_000n * gasPrice;
  for (const p of plan) console.log(`  ${p.label.padEnd(18)} -> ${p.predicted}  gas limit ${p.gasLimit}  <= ${fmtQuai(p.gasLimit * gasPrice)}`);
  console.log(`  registry.wire(factory)      gas limit 300000  <= ${fmtQuai(300_000n * gasPrice)}`);
  console.log(`  worst case ${fmtQuai(worstCase)} at gas price ${gasPrice}`);

  await rpc(net.rpc, 'quai_call', [{ from: deployer, data: plan[0].data }, 'latest']);
  console.log('  GuildNameRegistry creation simulates cleanly');
  await rpc(net.rpc, 'quai_call', [{ from: deployer, data: plan[1].data }, 'latest']);
  console.log('  TokenStackDeployer creation simulates cleanly');

  if (!broadcast && !signOnly) return;
  if (broadcast && balance < worstCase) fail(`balance ${fmtQuai(balance)} is below the worst case ${fmtQuai(worstCase)}`);

  const results = [];
  for (const step of plan) {
    if (step.label === 'GuildFactory') {
      if (signOnly) {
        console.log('  GuildFactory: not signed; its constructor needs the registry on chain, which sign-only never creates');
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

  // Wire the registry to the factory (one-time, deployer-only).
  const [registryRes, tokenStackRes, factoryRes] = results;
  if (!registryRes || !tokenStackRes || !factoryRes) fail('missing a deployment result; cannot wire');
  const registryIface = new Interface(registryArt.abi);
  const wireData = registryIface.encodeFunctionData('wire', [factoryRes.address]);
  await rpc(net.rpc, 'quai_call', [{ from: deployer, to: registryRes.address, data: wireData }, 'latest']);
  const wirePop = await wallet.populateQuaiTransaction({ from: deployer, to: registryRes.address, data: wireData, nonce: nonce + 3, gasLimit: 300_000n });
  const wireSigned = await wallet.signTransaction(QuaiTransaction.from(wirePop));
  const wireZone = await wallet.zoneFromAddress(deployer);
  const wireResp = await provider.broadcastTransaction(wireZone, wireSigned, deployer);
  console.log(`  registry.wire: sent ${wireResp.hash}`);
  const wireReceipt = await waitConfirmed(net, wireResp.hash, confirmations);
  if (parseInt(wireReceipt.status, 16) !== 1) fail(`registry.wire reverted (tx ${wireResp.hash})`);
  const registryCode = await rpc(net.rpc, 'quai_getCode', [registryRes.address, 'latest']);
  if (!runtimeMatchesBuild(registryCode, registryArt.deployedBytecode, [deployer])) fail('GuildNameRegistry code on chain does not match the build');
  const tokenStackCode = await rpc(net.rpc, 'quai_getCode', [tokenStackRes.address, 'latest']);
  if (!runtimeMatchesBuild(tokenStackCode, tokenStackArt.deployedBytecode)) fail('TokenStackDeployer code on chain does not match the build');
  const factoryCode = await rpc(net.rpc, 'quai_getCode', [factoryRes.address, 'latest']);
  if (!runtimeMatchesBuild(factoryCode, factoryArt.deployedBytecode, [registryRes.address, tokenStackRes.address])) fail('GuildFactory code on chain does not match the build');
  console.log('  verified: all three runtimes match the build (immutable slots filled)');

  const record = {
    network: args.network,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer,
    registry: registryRes,
    tokenStack: tokenStackRes,
    factory: factoryRes,
    registryCodeHash: keccak256(registryArt.deployedBytecode),
    tokenStackCodeHash: keccak256(tokenStackArt.deployedBytecode),
    factoryCodeHash: keccak256(factoryArt.deployedBytecode),
  };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  writeCoreDeployments(args.network, { factory: factoryRes.address, registry: registryRes.address, fromBlock: registryRes.blockNumber });
  console.log(`recorded ${path.relative(process.cwd(), recordPath)} and updated packages/core/src/deployments.ts`);
  console.log('next: rebuild the site so the Halls read from the live registry.');
}

main().catch((err) => fail(err?.message ?? String(err)));
