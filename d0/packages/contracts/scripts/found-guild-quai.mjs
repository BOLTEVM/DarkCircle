#!/usr/bin/env node
/**
 * Founds a guild on a live DarkOrder deployment (GuildFactory.foundGuild) on Quai Cyprus-1.
 *
 *   node scripts/found-guild-quai.mjs --network mainnet --from 0x00...                      simulate only (default)
 *   node scripts/found-guild-quai.mjs --network mainnet --keystore k.json --broadcast --i-understand-unaudited
 *   node scripts/found-guild-quai.mjs --network mainnet --keystore k.json --broadcast --i-understand-unaudited --delegate
 *
 *   --name crimsonvigil        registry handle (default crimsonvigil)
 *   --metadata "…"             guild metadata text / pointer
 *   --token-name "Vigil Ember" --token-symbol VEMB
 *   --initial-supply 1000      whole tokens minted to the founder (default 1000)
 *   --min-duration 3600        seconds a vote stays open at minimum
 *   --gas 15000000             gas limit for foundGuild (creation-heavy; sized manually, see below)
 *   --delegate                 after founding, send a second tx: token.delegate(founder)
 *
 * Key handling: identical to deploy-quai.mjs — encrypted JSON keystore only, password from
 * DARKORDER_KEYSTORE_PASSWORD_FILE or a hidden prompt. No private-key flag or env var.
 *
 * Quai specifics (same playbook as deploy-quai.mjs):
 *  - foundGuild is a CALL, not a CREATE, so no address grinding is needed; the guild's own
 *    contracts are created inside the factory and the zone rules for internal CREATEs are
 *    already how the protocol is designed to run.
 *  - quai_estimateGas is not trusted for revert-prone calls: the exact tx is simulated with
 *    quai_call first and nothing is signed unless the simulation returns cleanly.
 *  - Receipts are polled over raw JSON-RPC and must reach N confirmations; a reorg restarts.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Wallet, JsonRpcProvider, QuaiTransaction, Interface, getAddress, Zone, getZoneForAddress, isQiAddress } from 'quais';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const NETWORKS = {
  orchard: { chainId: 15000n, rpc: 'https://orchard.rpc.quai.network/cyprus1', pathing: 'https://orchard.rpc.quai.network', confirmations: 6 },
  mainnet: { chainId: 9n, rpc: 'https://rpc.quai.network/cyprus1', pathing: 'https://rpc.quai.network', confirmations: 3 },
};
const DEFAULT_GAS_LIMIT = 15_000_000n;

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
    if (['broadcast', 'delegate', 'i-understand-unaudited'].includes(key)) out.flags.add(key);
    else if (['network', 'from', 'keystore', 'confirmations', 'name', 'metadata', 'token-name', 'token-symbol', 'initial-supply', 'min-duration', 'gas'].includes(key)) out[key] = argv[++i];
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
  try { a = getAddress(raw); } catch { fail(`${what} ${raw} is not an address`); }
  if (!isCyprus1Quai(a)) fail(`${what} ${a} is not a Cyprus-1 Quai address (0x00, second byte below 0x80)`);
  return a;
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
        if (again?.blockHash === r.blockHash) { process.stdout.write('\n'); return again; }
      }
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`no confirmed receipt for ${hash} after 30 minutes; check the explorer before retrying`);
}

async function sendSimulated(net, wallet, from, tx, gasLimit, confirmations, label) {
  await rpc(net.rpc, 'quai_call', [{ ...tx, from }, 'latest']);
  console.log(`  ${label}: simulates cleanly`);
  const pop = await wallet.populateQuaiTransaction({ ...tx, from, gasLimit });
  const signed = await wallet.signTransaction(QuaiTransaction.from(pop));
  const zone = await wallet.zoneFromAddress(from);
  const resp = await wallet.provider.broadcastTransaction(zone, signed, from);
  console.log(`  ${label}: sent ${resp.hash}`);
  const receipt = await waitConfirmed(net, resp.hash, confirmations);
  if (parseInt(receipt.status, 16) !== 1) fail(`${label} reverted (tx ${resp.hash})`);
  console.log(`  ${label}: confirmed in block ${parseInt(receipt.blockNumber, 16)} (gas used ${BigInt(receipt.gasUsed)})`);
  return { hash: resp.hash, receipt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const net = NETWORKS[args.network];
  if (!net) fail('--network orchard|mainnet is required');
  const broadcast = args.flags.has('broadcast');
  if (args.network === 'mainnet' && broadcast && !args.flags.has('i-understand-unaudited')) {
    fail('refusing a mainnet broadcast: these contracts have not had an independent audit. Pass --i-understand-unaudited to proceed anyway.');
  }
  const confirmations = Number(args.confirmations ?? net.confirmations);

  const recordPath = path.join(ROOT, 'deployments', `${args.network}.json`);
  if (!fs.existsSync(recordPath)) fail(`${recordPath} not found; deploy the protocol first (deploy-quai.mjs)`);
  const deployment = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const factoryAddr = deployment.factory.address;
  const registryAddr = deployment.registry.address;

  const params = {
    name: args.name ?? 'crimsonvigil',
    metadata: args.metadata ?? 'Keepers of the crimson flame — first Grand Guild Hall of the Dark Order on Quai mainnet.',
    mode: 0, // Token
    tokenName: args['token-name'] ?? 'Vigil Ember',
    tokenSymbol: args['token-symbol'] ?? 'VEMB',
    initialSupply: BigInt(args['initial-supply'] ?? '1000') * 10n ** 18n,
    supportThreshold: 5_000n,
    minParticipation: 1_000n,
    minDuration: BigInt(args['min-duration'] ?? '3600'),
    members: [],
    minApprovals: 0n,
  };
  const gasLimit = BigInt(args.gas ?? DEFAULT_GAS_LIMIT);

  const chainId = BigInt(await rpc(net.rpc, 'quai_chainId', []));
  if (chainId !== net.chainId) fail(`RPC reports chain ${chainId}, expected ${net.chainId}`);

  const provider = new JsonRpcProvider(net.pathing, undefined, { usePathing: true });
  let wallet = null;
  if (broadcast) {
    if (!args.keystore) fail('--broadcast needs --keystore <encrypted json>');
    wallet = await loadKeystore(args.keystore, provider);
  }
  const founder = requireCyprus1(wallet ? wallet.address : (args.from ?? fail('pass --from <Cyprus-1 address> to simulate')), 'founder');

  const factoryArt = artifact('GuildFactory');
  const registryArt = artifact('GuildNameRegistry');
  const tokenArt = artifact('GovernanceToken');
  const factory = new Interface(factoryArt.abi);
  const registry = new Interface(registryArt.abi);
  const token = new Interface(tokenArt.abi);

  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  const balance = BigInt(await rpc(net.rpc, 'quai_getBalance', [founder, 'latest']));
  console.log(`network ${args.network} (chain ${chainId})  founder ${founder}  balance ${fmtQuai(balance)}`);
  console.log(`mode ${broadcast ? 'BROADCAST' : 'simulate'}`);
  console.log(`factory ${factoryAddr}  registry ${registryAddr}`);

  // Refuse a name that is already taken (resolve returns non-zero).
  const taken = await rpc(net.rpc, 'quai_call', [{ to: registryAddr, data: registry.encodeFunctionData('resolve', [params.name]) }, 'latest']);
  if (BigInt(taken) !== 0n) fail(`"${params.name}" already resolves to ${getAddress('0x' + taken.slice(-40))}; pick another --name`);

  const data = factory.encodeFunctionData('foundGuild', [params]);
  const estCost = gasLimit * gasPrice;
  console.log(`founding "${params.name}" (token ${params.tokenSymbol}, supply ${params.initialSupply / 10n ** 18n}, threshold 50%, participation 10%, min duration ${params.minDuration}s)`);
  console.log(`  gas limit ${gasLimit}  <= ${fmtQuai(estCost)} at gas price ${gasPrice}`);

  if (!broadcast) {
    await rpc(net.rpc, 'quai_call', [{ from: founder, to: factoryAddr, data }, 'latest']);
    console.log('  foundGuild simulates cleanly (pass --broadcast --keystore k.json to send)');
    return;
  }
  if (balance < estCost) fail(`balance ${fmtQuai(balance)} is below the gas worst case ${fmtQuai(estCost)}`);

  await sendSimulated(net, wallet, founder, { to: factoryAddr, data }, gasLimit, confirmations, 'foundGuild');

  // Read the hall record back.
  const guildAddr = getAddress('0x' + (await rpc(net.rpc, 'quai_call', [{ to: registryAddr, data: registry.encodeFunctionData('resolve', [params.name]) }, 'latest'])).slice(-40));
  const rec = registry.decodeFunctionResult('recordOf', await rpc(net.rpc, 'quai_call', [{ to: registryAddr, data: registry.encodeFunctionData('recordOf', [guildAddr]) }, 'latest']))[0];
  console.log(`  hall record: guild=${rec.guild} token=${rec.token} module=${rec.module} mode=${Number(rec.mode) === 0 ? 'token' : 'council'}`);

  if (args.flags.has('delegate')) {
    const delegateData = token.encodeFunctionData('delegate', [founder]);
    await sendSimulated(net, wallet, founder, { to: rec.token, data: delegateData }, 300_000n, confirmations, `delegate(${founder})`);
    console.log('  voting power armed: the founder can now file and win votes');
  } else {
    console.log(`  next: re-run with --delegate (or call delegate on ${rec.token}) so the founder's balance counts as votes`);
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
